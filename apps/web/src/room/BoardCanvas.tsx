"use client";

import { generatePuzzle } from "@puzzlewithme/geometry";
import type { RoomSettings } from "@puzzlewithme/shared";
import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { browserClock, type SyncClient } from "../sync";
import { buildAtlases } from "../board/atlas";
import { buildPiecePolygons } from "../board/hit-test";
import { InputController } from "../board/input";
import { BoardRenderer } from "../board/renderer";
import { roomImageUrl } from "../config";
import { currentTheme, subscribeTheme } from "../theme";

/**
 * Client-only Pixi host. Bakes atlases, builds the renderer + input, and wires
 * the scene to the sync store (structural updates via subscribe; per-frame via
 * the renderer's own ticker). React never touches the scene graph after mount.
 */
export function BoardCanvas({
  sync,
  settings,
  interactive,
  pointerRef,
}: {
  sync: SyncClient;
  settings: RoomSettings;
  /** False for completed (read-only) rooms: pan/zoom stay on, drag/grab off. */
  interactive: boolean;
  /** Last pointer position in canvas CSS pixels, for placing the held-by toast. */
  pointerRef: React.MutableRefObject<{ x: number; y: number }>;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let app: Application | null = null;
    let renderer: BoardRenderer | null = null;
    let input: InputController | null = null;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeTheme: (() => void) | null = null;
    let atlasTextures: import("pixi.js").Texture[] = [];
    const onResize = () => renderer?.onResize();

    (async () => {
      try {
        const res = await fetch(roomImageUrl(settings.roomId));
        if (!res.ok) throw new Error(`image fetch failed (${res.status})`);
        const bitmap = await createImageBitmap(await res.blob());
        if (disposed) {
          bitmap.close();
          return;
        }

        const puzzle = generatePuzzle(settings.rows, settings.cols, settings.seed);
        const atlas = buildAtlases(puzzle, bitmap, bitmap.width, bitmap.height);
        atlasTextures = atlas.atlases;
        bitmap.close();
        const polygons = buildPiecePolygons(puzzle);

        app = new Application();
        await app.init({
          resizeTo: mount,
          background: currentTheme().board.canvas,
          antialias: true,
          resolution: window.devicePixelRatio || 1,
          autoDensity: true,
        });
        if (disposed) {
          app.destroy(true);
          return;
        }
        mount.appendChild(app.canvas);

        renderer = new BoardRenderer(app, puzzle, atlas, polygons, browserClock, () => sync.getState());
        renderer.syncGroups(sync.getState());
        unsubscribe = sync.subscribe((state) => renderer?.syncGroups(state));

        input = new InputController(
          app.canvas,
          renderer,
          sync,
          { rows: settings.rows, cols: settings.cols },
          () => interactiveRef.current,
          (x, y) => {
            pointerRef.current = { x, y };
          },
        );
        input.attach();
        window.addEventListener("resize", onResize);
        unsubscribeTheme = subscribeTheme(() => {
          if (app) app.renderer.background.color = currentTheme().board.canvas;
          renderer?.refreshTheme();
        });
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : "Failed to load the board.");
      }
    })();

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      input?.detach();
      unsubscribe?.();
      unsubscribeTheme?.();
      renderer?.destroy();
      for (const t of atlasTextures) t.destroy(true);
      app?.destroy(true);
    };
  }, [sync, settings, pointerRef]);

  if (error) {
    return (
      <div className="center-msg">
        <h2>Couldn&apos;t load the puzzle</h2>
        <p>{error}</p>
      </div>
    );
  }
  return <div className="board-mount" ref={mountRef} />;
}
