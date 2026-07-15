import { boardBounds, CELL_SIZE, framePosition, type Puzzle } from "@puzzlewithme/geometry";
import type { BoardState, Clock, MotionState, RenderGroup, Vec2 } from "../sync";
import { Application, Container, Graphics, Sprite, Text } from "pixi.js";
import type { AtlasResult } from "./atlas";
import {
  type Camera,
  clampCamera,
  fitCamera,
  screenToWorld,
  worldToScreen,
} from "./camera";
import { CURSOR_INTERP_DELAY_MS, INTERP_DELAY_MS } from "./constants";
import { pointInPolygon } from "./hit-test";
import { currentTheme, type BoardTheme } from "../theme";

/**
 * Owns the PixiJS scene and drives it straight from the sync store (React state
 * is only for panels/overlays). Two update paths:
 *  - structural (onState): add/remove/rebuild group containers when the group
 *    set changes (joins, merges, locks). Infrequent.
 *  - per-frame (ticker): reposition every group container and redraw cursors,
 *    interpolating remotely-held groups and remote cursors between motion
 *    samples. Every frame.
 */

const MIN_ID = (pieces: RenderGroup["pieces"], cols: number): number => {
  let min = Infinity;
  for (const p of pieces) {
    const id = p.row * cols + p.col;
    if (id < min) min = id;
  }
  return min;
};

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Where to draw a group or cursor this frame. Anything with a motion sample
 * (a remotely-held group or another player's cursor) interpolates between its
 * two newest samples at `renderTime` (now minus the source's interp delay:
 * INTERP_DELAY_MS for groups, CURSOR_INTERP_DELAY_MS for cursors), so relayed
 * motion reads as continuous (NFR-2) regardless of the source's send rate.
 * Everything else, settled groups and the local drag (which leads
 * optimistically), uses `fallback` (the store's raw position) directly.
 */
function renderPosition(motion: MotionState | undefined, fallback: Vec2, renderTime: number): Vec2 {
  if (!motion) return fallback;
  const { current, previous } = motion;
  if (!previous) return current.position;
  const span = current.timestamp - previous.timestamp;
  if (span <= 0) return current.position;
  const t = (renderTime - previous.timestamp) / span;
  if (t <= 0) return previous.position;
  if (t >= 1) return current.position;
  return lerp(previous.position, current.position, t);
}

interface GroupNode {
  container: Container;
  /**
   * The exact RenderGroup object last built from. The board store mutates
   * position/heldBy on the same object in place but swaps in a NEW object on any
   * structural change (snap_result: merge, lock, pieces). So reference equality
   * is a zero-allocation "did the structure change?" test, cheap enough to run
   * on every notify (up to ~60 Hz) for 1000 groups.
   */
  group: RenderGroup;
}

interface CursorNode {
  container: Container;
  pointer: Graphics;
  label: Text;
  labelBg: Graphics;
}

/**
 * Scene diagnostics published to window.__pwmScene for the ?debug=1 overlay:
 * lets a device with no console show whether the Pixi scene graph tracks the
 * store (nodes/lockedNodes vs the store's groups/locked) and whether sync ever
 * threw or the GPU context was lost. Split store-vs-scene is exactly the
 * desync signature under investigation.
 */
export interface SceneDebugStats {
  nodes: number;
  lockedNodes: number;
  syncErrors: number;
  rebuilds: number;
  contextLost: number;
  lastError: string | null;
}

export class BoardRenderer {
  private readonly viewport = new Container();
  private readonly groupLayer = new Container();
  private readonly cursorLayer = new Container();
  private readonly frame = new Graphics();
  private readonly nodes = new Map<string, GroupNode>();
  private readonly cursors = new Map<string, CursorNode>();
  private needsFullRebuild = false;
  private readonly sceneStats: SceneDebugStats = {
    nodes: 0,
    lockedNodes: 0,
    syncErrors: 0,
    rebuilds: 0,
    contextLost: 0,
    lastError: null,
  };
  /** Snapshot of the active theme's board colors; refreshTheme() re-reads it. */
  private theme: BoardTheme = currentTheme().board;
  camera: Camera;

  constructor(
    private readonly app: Application,
    private readonly puzzle: Puzzle,
    private readonly atlas: AtlasResult,
    private readonly polygons: Map<number, Vec2[]>,
    private readonly clock: Clock,
    private readonly getState: () => BoardState,
  ) {
    this.app.stage.addChild(this.viewport);
    this.viewport.addChild(this.frame);
    this.viewport.addChild(this.groupLayer);
    // Cursors live in screen space (constant label size regardless of zoom).
    this.app.stage.addChild(this.cursorLayer);

    this.drawFrame();
    this.camera = fitCamera(puzzle.rows, puzzle.cols, this.viewport_size());
    this.applyCamera();
    this.app.ticker.add(this.tick);

    // iOS Safari revokes WebGL contexts under memory pressure (backgrounded
    // tab, camera/FaceTime running). Count it and queue a scene rebuild for
    // the restore, since textures/buffers may not survive.
    this.app.canvas.addEventListener?.("webglcontextlost", () => {
      this.sceneStats.contextLost += 1;
      this.publishSceneStats();
    });
    this.app.canvas.addEventListener?.("webglcontextrestored", () => {
      this.needsFullRebuild = true;
    });
    this.publishSceneStats();
  }

  private publishSceneStats(): void {
    this.sceneStats.nodes = this.nodes.size;
    let locked = 0;
    for (const node of this.nodes.values()) if (node.group.locked) locked += 1;
    this.sceneStats.lockedNodes = locked;
    (globalThis as { __pwmScene?: SceneDebugStats }).__pwmScene = { ...this.sceneStats };
  }

  private viewport_size(): { width: number; height: number } {
    return { width: this.app.screen.width, height: this.app.screen.height };
  }

  /** Subtle frame outline + faint board-bounds rect on the table (FR-8). */
  private drawFrame(): void {
    const { rows, cols } = this.puzzle;
    const b = boardBounds(rows, cols);
    this.frame.clear();
    this.frame
      .rect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY)
      .fill({ color: this.theme.well, alpha: this.theme.wellAlpha });
    this.frame
      .rect(0, 0, cols * CELL_SIZE, rows * CELL_SIZE)
      .fill({ color: 0xffffff, alpha: 0.02 })
      .stroke({ width: 2, color: this.theme.frameStroke, alpha: 0.9, alignment: 0.5 });
  }

  /** Re-reads the active theme and repaints everything themed in the scene. */
  refreshTheme(): void {
    this.theme = currentTheme().board;
    this.drawFrame();
    for (const node of this.cursors.values()) this.drawCursorLabelBg(node);
  }

  private drawCursorLabelBg(node: CursorNode): void {
    node.labelBg
      .clear()
      .roundRect(9, 10, node.label.width + 10, node.label.height + 4, 8)
      .fill({ color: this.theme.cursorLabelBg, alpha: 0.85 });
  }

  applyCamera(): void {
    this.viewport.position.set(this.camera.x, this.camera.y);
    this.viewport.scale.set(this.camera.scale);
  }

  setCamera(cam: Camera): void {
    this.camera = clampCamera(cam, this.puzzle.rows, this.puzzle.cols, this.viewport_size());
    this.applyCamera();
  }

  onResize(): void {
    this.setCamera(this.camera);
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    return screenToWorld(this.camera, sx, sy);
  }

  /** Bring a group's container to the top so a grabbed group renders over others. */
  bringToFront(groupId: string): void {
    const node = this.nodes.get(groupId);
    if (node) this.groupLayer.addChild(node.container);
  }

  /**
   * Topmost group whose actual piece outline contains the world point. Iterates
   * containers back-to-front (render order top first) so a click resolves to the
   * piece drawn on top; the cheap cell-bbox reject runs before the polygon test.
   */
  hitTest(wx: number, wy: number): { groupId: string; pieceId: number } | null {
    const state = this.getState();
    const cols = this.puzzle.cols;
    const children = this.groupLayer.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const id = children[i]!.label;
      const group = state.groups.get(id);
      if (!group) continue;
      const anchor = MIN_ID(group.pieces, cols);
      const anchorFrame = framePosition(anchor, cols);
      for (const p of group.pieces) {
        const pid = p.row * cols + p.col;
        const fp = framePosition(pid, cols);
        const lx = wx - (group.position.x + fp.x - anchorFrame.x);
        const ly = wy - (group.position.y + fp.y - anchorFrame.y);
        if (
          lx < -this.atlas.overhang ||
          ly < -this.atlas.overhang ||
          lx > CELL_SIZE + this.atlas.overhang ||
          ly > CELL_SIZE + this.atlas.overhang
        ) {
          continue;
        }
        const poly = this.polygons.get(pid);
        if (poly && pointInPolygon(poly, lx, ly)) return { groupId: id, pieceId: pid };
      }
    }
    return null;
  }

  /**
   * Reconcile the scene graph with the current group set (structural changes).
   * Failure-isolated: if reconciliation throws (observed shape: the scene
   * silently freezing on iOS Safari while the store stays correct — ghost
   * pieces at stale positions), the error is recorded for the debug overlay
   * and the next frame rebuilds the whole scene from the store instead of
   * leaving it frozen forever.
   */
  syncGroups(state: BoardState): void {
    try {
      this.reconcileGroups(state);
    } catch (err) {
      this.sceneStats.syncErrors += 1;
      this.sceneStats.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.needsFullRebuild = true;
      console.error("syncGroups failed; scheduling full scene rebuild", err);
    }
    this.publishSceneStats();
  }

  private reconcileGroups(state: BoardState): void {
    for (const group of state.groups.values()) {
      const existing = this.nodes.get(group.id);
      if (!existing) {
        this.buildNode(group);
      } else if (existing.group !== group) {
        // Structural change (merge/lock/pieces): rebuild this group's sprites.
        existing.container.destroy({ children: true });
        this.nodes.delete(group.id);
        this.buildNode(group);
      }
    }
    for (const [id, node] of this.nodes) {
      if (!state.groups.has(id)) {
        node.container.destroy({ children: true });
        this.nodes.delete(id);
      }
    }
  }

  /** Tear down every group node and rebuild from the store: the recovery path after a sync failure or context restore. */
  private rebuildAllGroups(state: BoardState): void {
    for (const [id, node] of this.nodes) {
      try {
        node.container.destroy({ children: true });
      } catch {
        // A node wrecked by the very failure we're recovering from; orphaning
        // it is fine — the container is detached below by rebuilding the map.
      }
      this.nodes.delete(id);
    }
    this.groupLayer.removeChildren();
    for (const group of state.groups.values()) this.buildNode(group);
    this.sceneStats.rebuilds += 1;
    this.publishSceneStats();
  }

  private buildNode(group: RenderGroup): void {
    const cols = this.puzzle.cols;
    const anchor = MIN_ID(group.pieces, cols);
    const anchorFrame = framePosition(anchor, cols);
    const container = new Container();
    container.label = group.id;
    for (const p of group.pieces) {
      const id = p.row * cols + p.col;
      const tex = this.atlas.pieceTextures.get(id);
      if (!tex) continue;
      const sprite = new Sprite(tex);
      const fp = framePosition(id, cols);
      // Sprite top-left = piece cell origin minus the overhang baked into the tile.
      sprite.position.set(
        fp.x - anchorFrame.x - this.atlas.overhang,
        fp.y - anchorFrame.y - this.atlas.overhang,
      );
      sprite.setSize(this.atlas.tileWorld, this.atlas.tileWorld);
      container.addChild(sprite);
    }
    container.position.set(group.position.x, group.position.y);
    // Placed (locked) groups sit beneath movable ones so loose pieces stay
    // visible when dropped over the assembled area.
    if (group.locked) this.groupLayer.addChildAt(container, 0);
    else this.groupLayer.addChild(container);
    this.nodes.set(group.id, { container, group });
  }

  private readonly tick = (): void => {
    const state = this.getState();
    if (this.needsFullRebuild) {
      this.needsFullRebuild = false;
      try {
        this.rebuildAllGroups(state);
      } catch (err) {
        // Rebuild itself failing means the GPU context is still gone; retry
        // next frame rather than giving up.
        this.needsFullRebuild = true;
        this.sceneStats.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
    }
    const now = this.clock.now();
    for (const [id, node] of this.nodes) {
      const group = state.groups.get(id);
      if (!group) continue;
      const pos = renderPosition(state.motion.get(id), group.position, now - INTERP_DELAY_MS);
      node.container.position.set(pos.x, pos.y);
    }
    this.updateCursors(state, now);
  };

  private updateCursors(state: BoardState, now: number): void {
    const seen = new Set<string>();
    for (const cursor of state.cursors.values()) {
      if (cursor.guestId === state.localGuestId) continue;
      const player = state.players.get(cursor.guestId);
      if (!player) continue;
      seen.add(cursor.guestId);
      const color = parseColor(player.color);
      let node = this.cursors.get(cursor.guestId);
      if (!node) node = this.buildCursor(cursor.guestId);
      node.pointer.tint = color;
      if (node.label.text !== player.name) {
        node.label.text = player.name;
        this.drawCursorLabelBg(node);
      }
      const pos = renderPosition(
        state.cursorMotion.get(cursor.guestId),
        { x: cursor.x, y: cursor.y },
        now - CURSOR_INTERP_DELAY_MS,
      );
      const s = worldToScreen(this.camera, pos.x, pos.y);
      node.container.position.set(s.x, s.y);
    }
    for (const [id, node] of this.cursors) {
      if (!seen.has(id)) {
        node.container.destroy({ children: true });
        this.cursors.delete(id);
      }
    }
  }

  private buildCursor(guestId: string): CursorNode {
    const container = new Container();
    const pointer = new Graphics();
    // A small arrow pointer; white base tinted to the player's color.
    pointer
      .moveTo(0, 0)
      .lineTo(0, 16)
      .lineTo(4.5, 12)
      .lineTo(11, 11)
      .closePath()
      .fill(0xffffff)
      .stroke({ width: 1, color: 0x000000, alpha: 0.3 });
    const label = new Text({
      text: "",
      style: { fontSize: 12, fontFamily: "system-ui, sans-serif", fill: 0xffffff },
    });
    label.position.set(12, 12);
    const labelBg = new Graphics();
    // labelBg before label so the text sits on top of its pill.
    container.addChild(pointer, labelBg, label);
    this.cursorLayer.addChild(container);
    const node: CursorNode = { container, pointer, label, labelBg };
    this.cursors.set(guestId, node);
    return node;
  }

  destroy(): void {
    this.app.ticker.remove(this.tick);
    for (const node of this.nodes.values()) node.container.destroy({ children: true });
    for (const node of this.cursors.values()) node.container.destroy({ children: true });
    this.nodes.clear();
    this.cursors.clear();
  }
}

/** Parse a "#rrggbb" (or "rgb(...)") color to a 0xRRGGBB int; falls back to grey. */
function parseColor(color: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) return parseInt(hex[1]!, 16);
  return 0x9aa7b4;
}
