"use client";

import { generatePuzzle } from "@puzzlewithme/geometry";
import type { RoomSettings } from "@puzzlewithme/shared";
import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { browserClock, type SyncClient } from "../sync";
import { buildAtlases } from "../board/atlas";
import { fitCamera, tiltForScale, type Camera } from "../board/camera";
import { buildPiecePolygons } from "../board/hit-test";
import { InputController, type CanvasPlacement } from "../board/input";
import { BoardRenderer } from "../board/renderer";
import { clientToPlane, planeToClient } from "../board/tilt";
import { imageUrl } from "../config";
import { ROOM_TILT_DEG } from "../scene/Table";
import type { TableHandle } from "../scene/table-handle";
import { subscribeTheme } from "../theme";
import { TableCard } from "./TableCard";

/**
 * The board's box on the Table's plane. Pinned to the plane's top-left corner,
 * which the pointer mapping relies on (clientToPlane), and as big as the
 * plane, so it clips the canvas at the plane's near edge.
 */
const MOUNT_STYLE: React.CSSProperties = { position: "absolute", inset: 0, overflow: "hidden", touchAction: "none" };

/**
 * Client-only Pixi host. Bakes atlases, builds the renderer + input, and wires
 * the scene to the sync store (structural updates via subscribe; per-frame via
 * the renderer's own ticker). React never touches the scene graph after mount.
 *
 * The board lies on the Table's tilted plane and drives its tilt: the tilt
 * follows the camera scale (tiltForScale), and every pointer maps back through
 * it. The canvas is sized to the plane laid flat, its deepest, once per real
 * resize, and the board's box clips it to the plane as the tilt changes.
 */
export function BoardCanvas({
  sync,
  settings,
  interactive,
  pointerRef,
  table,
  zoomRef,
  onZoom,
}: {
  sync: SyncClient;
  settings: RoomSettings;
  /** False for completed (read-only) rooms: pan/zoom stay on, drag/grab off. */
  interactive: boolean;
  /** Last pointer position in canvas CSS pixels (on the plane), for placing the held-by toast. */
  pointerRef: React.MutableRefObject<{ x: number; y: number }>;
  /** The Table the board lies on. */
  table: React.RefObject<TableHandle | null>;
  /** Set to the zoom buttons' action while the board is up: zoom by a factor, eased. */
  zoomRef?: React.MutableRefObject<((factor: number) => void) | null>;
  /** Told the zoom, as a multiple of the fit zoom, on every camera change. */
  onZoom?: (zoom: number) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    const tableHandle = table.current;
    if (!mount || !tableHandle) return;

    let disposed = false;
    let app: Application | null = null;
    let renderer: BoardRenderer | null = null;
    let input: InputController | null = null;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeTheme: (() => void) | null = null;
    let atlasTextures: import("pixi.js").Texture[] = [];
    let onResize: (() => void) | null = null;

    (async () => {
      try {
        const res = await fetch(imageUrl(settings.imageRef));
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

        const pixi = new Application();
        app = pixi;
        await pixi.init({
          // Transparent: the table is the Table's CSS plane behind the
          // canvas, so the board screen shares the surface with every other
          // screen instead of painting its own flat backdrop.
          backgroundAlpha: 0,
          antialias: true,
          resolution: window.devicePixelRatio || 1,
          autoDensity: true,
        });
        if (disposed) {
          pixi.destroy(true);
          return;
        }
        mount.appendChild(pixi.canvas);

        const board = new BoardRenderer(pixi, puzzle, atlas, polygons, browserClock, () => sync.getState());
        renderer = board;
        board.syncGroups(sync.getState());
        unsubscribe = sync.subscribe((state) => renderer?.syncGroups(state));

        let tilt = tableHandle.getTiltView();
        let visibleHeight = 0;
        let restingTilt = 0;
        let fitScale = 1;
        const placement: CanvasPlacement = {
          toCanvas: (x, y) => clientToPlane(tilt, pixi.canvas.getBoundingClientRect(), pixi.screen.height, x, y),
          toClient: (x, y) => planeToClient(tilt, pixi.canvas.getBoundingClientRect(), pixi.screen.height, x, y),
          tiltFor: (scale) => {
            tilt = tableHandle.setTilt(tiltForScale(scale, fitScale, restingTilt));
            onZoomRef.current?.(scale / fitScale);
            // The board's box is the plane's size, so its height is how much of the canvas shows.
            visibleHeight = mount.clientHeight;
            board.visibleHeight = visibleHeight;
          },
          viewport: () => ({ width: pixi.screen.width, height: visibleHeight }),
        };
        const applyCamera = (cam: Camera): void => {
          placement.tiltFor(cam.scale);
          board.setCamera(cam);
        };

        /** Sizes the canvas and works out the fit; `camera` null fits the camera too. */
        const fitToTable = (camera: Camera | null): void => {
          // The plane is deepest laid flat (it also takes the edge's height
          // then), so that is the canvas size. Flat, the box is untransformed
          // and its rect is exact.
          tilt = tableHandle.setTilt(0);
          const flat = mount.getBoundingClientRect();
          pixi.renderer.resize(Math.ceil(flat.width), Math.ceil(flat.height));
          // Asking for the room's tilt tells what the Table draws at the fit
          // zoom: on a phone it stays flat.
          tilt = tableHandle.setTilt(ROOM_TILT_DEG);
          restingTilt = tilt.tiltDeg;
          visibleHeight = mount.clientHeight;
          const fit = fitCamera(settings.rows, settings.cols, placement.viewport());
          fitScale = fit.scale;
          applyCamera(camera ?? fit);
        };
        fitToTable(null);

        input = new InputController(
          pixi.canvas,
          board,
          sync,
          { rows: settings.rows, cols: settings.cols },
          () => interactiveRef.current,
          (x, y) => {
            pointerRef.current = { x, y };
          },
          placement,
          pixi.ticker,
        );
        input.attach();
        const controller = input;
        if (zoomRef) zoomRef.current = (factor) => controller.zoomBy(factor);

        // Re-fit only on real resizes, never per zoom frame. The Table fits
        // itself again on every setTilt, so this need not wait for its own
        // resize listener.
        onResize = () => fitToTable(board.camera);
        window.addEventListener("resize", onResize);
        unsubscribeTheme = subscribeTheme(() => renderer?.refreshTheme());
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : "Failed to load the board.");
      }
    })();

    return () => {
      disposed = true;
      if (onResize) window.removeEventListener("resize", onResize);
      if (zoomRef) zoomRef.current = null;
      input?.detach();
      unsubscribe?.();
      unsubscribeTheme?.();
      renderer?.destroy();
      for (const t of atlasTextures) t.destroy(true);
      app?.destroy(true);
    };
  }, [sync, settings, pointerRef, table, zoomRef]);

  if (error) {
    return (
      <div className="board-error">
        <TableCard>
          <h2>The picture didn&apos;t arrive</h2>
          <p>{error}</p>
        </TableCard>
      </div>
    );
  }
  return <div className="board-mount" ref={mountRef} style={MOUNT_STYLE} />;
}
