import { CELL_SIZE, framePosition, type Puzzle } from "@puzzlewithme/geometry";
import type { BoardState, Clock, MotionState, RenderGroup, Vec2 } from "../sync";
import { Application, Color, Container, Graphics, Sprite, Text, type Texture } from "pixi.js";
import type { AtlasResult } from "./atlas";
import {
  type Camera,
  clampCamera,
  fitCamera,
  screenToWorld,
  worldToScreen,
} from "./camera";
import {
  ASSEMBLED_SHADOW_ALPHA,
  ASSEMBLED_SHADOW_DROP,
  COMPLETED_GLOW_ALPHA,
  COMPLETED_GLOW_COLOR,
  COMPLETED_GLOW_SPREAD,
  CURSOR_INTERP_DELAY_MS,
  FRAME_DASH_PX,
  FRAME_GAP_PX,
  FRAME_REDRAW_RATIO,
  FRAME_WIDTH_PX,
  HELD_RAISE,
  HELD_SCALE,
  HELD_SHADOW_LIFT,
  HELD_SHADOW_SCALE,
  INTERP_DELAY_MS,
  LAMP_HEIGHT_PX,
  MOCK_UNIT,
  PIECE_SIDE_DEPTH,
} from "./constants";
import { pointInPolygon } from "./hit-test";
import { shadowOffset } from "./shadow";
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
  /** Pivoted on the group's centre, so a held group scales about it. */
  container: Container;
  /**
   * The group's shadows. A loose group's sit inside its container and shift
   * every frame with the light; a locked group's sit in the shared layer under
   * all locked pieces, so an assembled block casts one shadow at its rim.
   */
  shadows: Container;
  /** Group centre relative to its position (the anchor piece's cell origin). */
  centre: Vec2;
  /** Who held the group when it was built: a held group's look differs, so a change rebuilds it. */
  heldBy: string | null;
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
  /** The owning player's color, so the pill can be redrawn without the store. */
  color: number;
}

/** The mock's cursor arrow, in screen pixels with the tip at the origin. */
const CURSOR_ARROW = [0, 0, 0, 17, 4.6, 13.2, 7.6, 20, 10.2, 18.9, 7.2, 12.2, 12.6, 12.2];

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
  /** The completed picture's amber glow, under everything else. */
  private readonly glow = new Graphics();
  /** The dashed picture outline, and the camera scale it was last drawn for. */
  private readonly frame = new Graphics();
  private frameScale = 0;
  private readonly lockedShadowLayer = new Container();
  private readonly groupLayer = new Container();
  private readonly cursorLayer = new Container();
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
  /** How much of the canvas shows, from its top: the tilted table clips the rest. Clamp uses it; null is all of it. */
  visibleHeight: number | null = null;

  constructor(
    private readonly app: Application,
    private readonly puzzle: Puzzle,
    private readonly atlas: AtlasResult,
    private readonly polygons: Map<number, Vec2[]>,
    private readonly clock: Clock,
    private readonly getState: () => BoardState,
  ) {
    this.camera = fitCamera(puzzle.rows, puzzle.cols, this.viewport_size());

    // The canvas is transparent over the CSS table. Bottom up: the glow, the
    // picture outline, the assembled pieces' shadows, then the pieces.
    this.app.stage.addChild(this.viewport);
    this.viewport.addChild(this.glow, this.frame, this.lockedShadowLayer, this.groupLayer);
    // Cursors live in screen space (constant label size regardless of zoom).
    this.app.stage.addChild(this.cursorLayer);

    this.drawGlow();
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
    return { width: this.app.screen.width, height: this.visibleHeight ?? this.app.screen.height };
  }

  /**
   * The completed picture's glow: faint amber rings stepping out from the
   * picture. Each ring adds the opacity lost between its inner and outer
   * distance, so where they overlap the glow is half its peak at the picture's
   * edge, as a blurred edge is, and eases to nothing at COMPLETED_GLOW_SPREAD.
   * Graphics stand in for the mock's blur, which would be a filter pass every
   * frame.
   */
  private drawGlow(): void {
    const w = this.puzzle.cols * CELL_SIZE;
    const h = this.puzzle.rows * CELL_SIZE;
    const steps = 16;
    const opacityAt = (step: number): number => {
      const t = step / steps;
      return (COMPLETED_GLOW_ALPHA / 2) * (1 - t * t * (3 - 2 * t));
    };
    for (let i = steps; i >= 1; i--) {
      const spread = (COMPLETED_GLOW_SPREAD * i) / steps;
      this.glow
        .roundRect(-spread, -spread, w + spread * 2, h + spread * 2, 4 * MOCK_UNIT + spread)
        .fill({ color: COMPLETED_GLOW_COLOR, alpha: opacityAt(i - 1) - opacityAt(i) });
    }
    this.glow.visible = false;
  }

  /**
   * The picture outline: a faint fill and a dashed line. The dash and stroke
   * are screen sizes divided back into world units, so the line looks the
   * same at every zoom; that makes it camera-dependent, redrawn from
   * applyCamera.
   */
  private drawFrame(): void {
    const scale = this.camera.scale;
    this.frameScale = scale;
    const w = this.puzzle.cols * CELL_SIZE;
    const h = this.puzzle.rows * CELL_SIZE;
    const dash = FRAME_DASH_PX / scale;
    const step = dash + FRAME_GAP_PX / scale;
    this.frame.clear().rect(0, 0, w, h).fill(this.theme.frameFill);
    const run = (fromX: number, fromY: number, dx: number, dy: number, length: number): void => {
      for (let at = 0; at < length; at += step) {
        const end = Math.min(at + dash, length);
        this.frame.moveTo(fromX + dx * at, fromY + dy * at).lineTo(fromX + dx * end, fromY + dy * end);
      }
    };
    run(0, 0, 1, 0, w);
    run(w, 0, 0, 1, h);
    run(w, h, -1, 0, w);
    run(0, h, 0, -1, h);
    this.frame.stroke({ width: FRAME_WIDTH_PX / scale, color: this.theme.frameStroke });
  }

  /** Re-reads the active theme and repaints everything themed in the scene. */
  refreshTheme(): void {
    this.theme = currentTheme().board;
    this.drawFrame();
    this.rebuildAllGroups(this.getState());
    for (const node of this.cursors.values()) this.drawCursorLabelBg(node);
  }

  /** Name pill in the player's own color, so a cursor reads at a glance. */
  private drawCursorLabelBg(node: CursorNode): void {
    const width = node.label.width + 16;
    node.labelBg.clear().roundRect(12, 14, width, 20, 10).fill(node.color);
    node.label.style.fill = this.theme.cursorLabelText;
    node.label.position.set(12 + (width - node.label.width) / 2, 14 + (20 - node.label.height) / 2);
  }

  applyCamera(): void {
    this.viewport.position.set(this.camera.x, this.camera.y);
    this.viewport.scale.set(this.camera.scale);
    const scale = this.camera.scale;
    if (scale < this.frameScale * (1 - FRAME_REDRAW_RATIO) || scale > this.frameScale * (1 + FRAME_REDRAW_RATIO)) {
      this.drawFrame();
    }
  }

  setCamera(cam: Camera): void {
    this.camera = clampCamera(cam, this.puzzle.rows, this.puzzle.cols, this.viewport_size());
    this.applyCamera();
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
        destroyNode(existing);
        this.nodes.delete(group.id);
        this.buildNode(group);
      }
    }
    for (const [id, node] of this.nodes) {
      if (!state.groups.has(id)) {
        destroyNode(node);
        this.nodes.delete(id);
      }
    }
  }

  /** Tear down every group node and rebuild from the store: after a theme change, and the recovery path after a sync failure or context restore. */
  private rebuildAllGroups(state: BoardState): void {
    for (const [id, node] of this.nodes) {
      try {
        destroyNode(node);
      } catch {
        // A node wrecked by the very failure we're recovering from; orphaning
        // it is fine — the container is detached below by rebuilding the map.
      }
      this.nodes.delete(id);
    }
    this.groupLayer.removeChildren();
    this.lockedShadowLayer.removeChildren();
    for (const group of state.groups.values()) this.buildNode(group);
    this.publishSceneStats();
  }

  /**
   * One group's sprites. Every piece is a face, and a loose piece also has a
   * dark side face showing below it and a light edge around it; a group's
   * sides all sit under its edges, which all sit under its faces, so inside a
   * group only the outer rim shows. Shadows go in their own container (see
   * GroupNode.shadows).
   */
  private buildNode(group: RenderGroup): void {
    const cols = this.puzzle.cols;
    const anchorFrame = framePosition(MIN_ID(group.pieces, cols), cols);
    const container = new Container();
    container.label = group.id;
    const shadows = new Container();
    const sides = new Container();
    const edges = new Container();
    const faces = new Container();
    const edge = new Color(this.theme.pieceEdge);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    // A sprite for one of a piece's tiles, placed so the tile's piece lines up
    // with the cell: top-left = cell origin minus the overhang and the tile's pad.
    const tile = (texture: Texture, x: number, y: number, pad: number, world: number): Sprite => {
      const sprite = new Sprite(texture);
      sprite.position.set(x - this.atlas.overhang - pad, y - this.atlas.overhang - pad);
      sprite.setSize(world, world);
      return sprite;
    };
    const { shadowTile, silhouetteTile } = this.atlas;
    // A held piece is further from the table, so its shadow is softer: the
    // overcast tile, the softest baked, in either light.
    const held = group.heldBy !== null;
    const shadowTextures = this.atlas.shadowTextures[held ? "overhead" : this.theme.shadowFrom];
    for (const p of group.pieces) {
      const id = p.row * cols + p.col;
      const face = this.atlas.pieceTextures.get(id);
      const silhouette = this.atlas.silhouetteTextures.get(id);
      const shadow = shadowTextures.get(id);
      if (!face || !silhouette || !shadow) continue;
      const fp = framePosition(id, cols);
      const x = fp.x - anchorFrame.x;
      const y = fp.y - anchorFrame.y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + CELL_SIZE);
      maxY = Math.max(maxY, y + CELL_SIZE);
      const shade = tile(shadow, x, y, shadowTile.pad, shadowTile.world);
      shade.tint = 0x000000;
      shadows.addChild(shade);
      faces.addChild(tile(face, x, y, 0, this.atlas.tileWorld));
      if (group.locked) continue;
      const side = tile(silhouette, x, y + PIECE_SIDE_DEPTH, silhouetteTile.pad, silhouetteTile.world);
      side.tint = this.theme.pieceSide;
      sides.addChild(side);
      const rim = tile(silhouette, x, y, silhouetteTile.pad, silhouetteTile.world);
      rim.tint = edge.toNumber();
      rim.alpha = edge.alpha;
      edges.addChild(rim);
    }
    const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    container.pivot.set(centre.x, centre.y);
    container.position.set(group.position.x + centre.x, group.position.y + centre.y);
    if (group.locked) {
      // Locked groups never move, so their shadows are placed once, in world space.
      shadows.alpha = ASSEMBLED_SHADOW_ALPHA;
      shadows.position.set(group.position.x, group.position.y + ASSEMBLED_SHADOW_DROP);
      this.lockedShadowLayer.addChild(shadows);
      container.addChild(faces);
    } else {
      shadows.alpha = this.theme.shadowAlpha;
      shadows.pivot.set(centre.x, centre.y);
      shadows.scale.set(held ? HELD_SHADOW_SCALE : 1);
      container.addChild(shadows, sides, edges, faces);
      if (held && group.heldBy !== this.getState().localGuestId) container.scale.set(HELD_SCALE);
    }
    // Placed (locked) groups sit beneath movable ones so loose pieces stay
    // visible when dropped over the assembled area.
    if (group.locked) this.groupLayer.addChildAt(container, 0);
    else this.groupLayer.addChild(container);
    this.nodes.set(group.id, { container, shadows, centre, heldBy: group.heldBy, group });
  }

  private readonly tick = (): void => {
    const state = this.getState();
    if (this.needsFullRebuild) {
      this.needsFullRebuild = false;
      try {
        this.rebuildAllGroups(state);
        this.sceneStats.rebuilds += 1;
      } catch (err) {
        // Rebuild itself failing means the GPU context is still gone; retry
        // next frame rather than giving up.
        this.needsFullRebuild = true;
        this.sceneStats.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
    }
    // A finished picture glows instead of casting the assembled shadow.
    this.glow.visible = state.status === "completed";
    this.lockedShadowLayer.visible = !this.glow.visible;
    const now = this.clock.now();
    const lamp = { x: this.app.screen.width / 2, y: -LAMP_HEIGHT_PX };
    const pickedUpOrPutDown: RenderGroup[] = [];
    for (const [id, node] of this.nodes) {
      const group = state.groups.get(id);
      if (!group) continue;
      if (group.heldBy !== node.heldBy) pickedUpOrPutDown.push(group);
      const pos = renderPosition(state.motion.get(id), group.position, now - INTERP_DELAY_MS);
      const cx = pos.x + node.centre.x;
      const cy = pos.y + node.centre.y;
      if (group.locked) {
        node.container.position.set(cx, cy);
        continue;
      }
      const lifted = node.heldBy !== null && node.heldBy !== state.localGuestId;
      node.container.position.set(cx, cy - (lifted ? HELD_RAISE : 0));
      const offset = shadowOffset(
        this.theme.shadowFrom,
        worldToScreen(this.camera, cx, cy),
        lamp,
        node.heldBy !== null ? HELD_SHADOW_LIFT : 1,
      );
      // The shadow is of the face and the side together, so it starts half the side's depth down.
      node.shadows.position.set(node.centre.x + offset.x, node.centre.y + offset.y + PIECE_SIDE_DEPTH / 2);
    }
    for (const group of pickedUpOrPutDown) {
      destroyNode(this.nodes.get(group.id)!);
      this.nodes.delete(group.id);
      this.buildNode(group);
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
      if (node.label.text !== player.name || node.color !== color) {
        node.label.text = player.name;
        node.color = color;
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
    // The arrow: a white base tinted to the player's color, with a dark outline
    // the tint leaves dark.
    pointer.poly(CURSOR_ARROW, true).fill(0xffffff).stroke({ width: 1, color: 0x0f0a06 });
    const label = new Text({
      text: "",
      style: { fontSize: 12, fontWeight: "600", fontFamily: cursorFont(), fill: this.theme.cursorLabelText },
    });
    const labelBg = new Graphics();
    // labelBg before label so the text sits on top of its pill.
    container.addChild(pointer, labelBg, label);
    this.cursorLayer.addChild(container);
    const node: CursorNode = { container, pointer, label, labelBg, color: 0x9aa7b4 };
    this.cursors.set(guestId, node);
    return node;
  }

  destroy(): void {
    this.app.ticker.remove(this.tick);
    for (const node of this.nodes.values()) destroyNode(node);
    for (const node of this.cursors.values()) node.container.destroy({ children: true });
    this.nodes.clear();
    this.cursors.clear();
  }
}

/** A locked node's shadows live outside its container, so they go separately. */
function destroyNode(node: GroupNode): void {
  if (node.group.locked) node.shadows.destroy({ children: true });
  node.container.destroy({ children: true });
}

/** The page's Figtree, which next/font registers under a generated family name in --fs. */
function cursorFont(): string {
  const family = typeof document === "undefined" ? "" : getComputedStyle(document.body).getPropertyValue("--fs").trim();
  return family || "Figtree, system-ui, sans-serif";
}

/** Parse a player's CSS color (the server sends "hsl(...)") to a 0xRRGGBB int; falls back to grey. */
function parseColor(color: string): number {
  try {
    return new Color(color).toNumber();
  } catch {
    return 0x9aa7b4;
  }
}
