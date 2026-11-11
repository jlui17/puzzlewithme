import type { Ticker } from "pixi.js";
import type { SyncClient } from "../sync";
import type { BoardRenderer } from "./renderer";
import { WHEEL_ZOOM_RATE } from "./constants";
import { clampScale, zoomAt, type Viewport } from "./camera";

/** How long a zoom-button step eases, in ms (the mock's 0.35 s). */
const ZOOM_BY_MS = 350;

/**
 * Where the canvas lies on screen. It lies on the Table, which tilts with the
 * zoom, so a client point maps to canvas pixels through the tilt as drawn
 * right now. BoardCanvas implements it.
 */
export interface CanvasPlacement {
  /** A client (viewport) point to canvas pixels. */
  toCanvas(clientX: number, clientY: number): { x: number; y: number };
  /** Canvas pixels to a client point, through the tilt drawn right now. */
  toClient(x: number, y: number): { x: number; y: number };
  /** Tilts the Table to suit camera scale `scale`. Call it before setting a camera with that scale. */
  tiltFor(scale: number): void;
  /** The part of the canvas the player sees: the tilted Table clips the canvas's bottom. */
  viewport(): Viewport;
}

/**
 * Translates raw pointer/wheel/touch input into camera moves and drag intents
 * (FR-26/27, §7.3). Kept out of React and off the Pixi event system: plain DOM
 * listeners on the canvas give one place to arbitrate pan vs. drag vs. pinch and
 * to convert screen→world through the shared camera.
 *
 * Arbitration on pointer-down: a hit on a grabbable piece starts a drag; a hit
 * on a locked/held piece is swallowed (no pan, no grab — the server's grab
 * rejection, if any, surfaces the holder); empty space starts a pan. Two active
 * pointers switch to pinch-zoom.
 */
export class InputController {
  /** Pressed pointers, in client coordinates, so a pinch maps through the tilt like the wheel does. */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private dragging: { groupId: string; offsetX: number; offsetY: number } | null = null;
  private panning = false;
  private panLast = { x: 0, y: 0 };
  private pinch: { dist: number; midX: number; midY: number } | null = null;
  private zoomTween: { from: number; to: number; elapsedMs: number; anchor: { x: number; y: number } } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: BoardRenderer,
    private readonly sync: SyncClient,
    private readonly puzzle: { rows: number; cols: number },
    private readonly isInteractive: () => boolean,
    private readonly reportPointer: (screenX: number, screenY: number) => void,
    private readonly placement: CanvasPlacement,
    private readonly ticker: Pick<Ticker, "add" | "remove">,
  ) {}

  attach(): void {
    this.ticker.add(this.tick);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  detach(): void {
    this.ticker.remove(this.tick);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
  }

  /**
   * Zooms by `factor` around the middle of the visible board, easing the
   * camera scale over ZOOM_BY_MS in the ticker (the zoom buttons). A jump
   * under reduced motion. Wheel and pinch stay immediate.
   */
  zoomBy(factor: number): void {
    const from = this.renderer.camera.scale;
    const to = clampScale(
      (this.zoomTween?.to ?? from) * factor,
      this.puzzle.rows,
      this.puzzle.cols,
      this.placement.viewport(),
    );
    // The middle of the visible board as a client point, held still through
    // the whole ease as the wheel holds the pointer, while the tilt changes under it.
    const vp = this.placement.viewport();
    const anchor = this.zoomTween?.anchor ?? this.placement.toClient(vp.width / 2, vp.height / 2);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.zoomTween = null;
      this.zoomTo(to, anchor, anchor);
      return;
    }
    this.zoomTween = { from, to, elapsedMs: 0, anchor };
  }

  private readonly tick = (ticker: Ticker): void => {
    const tween = this.zoomTween;
    if (!tween) return;
    tween.elapsedMs += ticker.deltaMS;
    const t = Math.min(1, tween.elapsedMs / ZOOM_BY_MS);
    const eased = 1 - (1 - t) ** 3;
    // Geometric, so the zoom feels even the way the wheel's exponential steps do.
    this.zoomTo(tween.from * (tween.to / tween.from) ** eased, tween.anchor, tween.anchor);
    if (t === 1) this.zoomTween = null;
  };

  /**
   * Sets the camera to `scale`, moving the world point under client point
   * `from` to client point `to`. Each is mapped through its own tilt: `from`
   * through the tilt drawn now, `to` through the one the new scale brings.
   */
  private zoomTo(scale: number, from: { x: number; y: number }, to: { x: number; y: number }): void {
    const cam = this.renderer.camera;
    const fromCanvas = this.placement.toCanvas(from.x, from.y);
    this.placement.tiltFor(scale);
    const toCanvas = this.placement.toCanvas(to.x, to.y);
    this.renderer.setCamera(zoomAt(cam, scale, fromCanvas, toCanvas));
  }

  private localXY(e: PointerEvent): { x: number; y: number } {
    return this.placement.toCanvas(e.clientX, e.clientY);
  }

  private onPointerDown = (e: PointerEvent): void => {
    const { x, y } = this.localXY(e);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.setPointerCapture(e.pointerId);

    if (this.pointers.size === 2) {
      // Second finger: abandon any single-pointer gesture, start pinch.
      this.cancelDrag();
      this.panning = false;
      this.beginPinch();
      return;
    }
    if (this.pointers.size > 2) return;

    const world = this.renderer.screenToWorld(x, y);
    const state = this.sync.getState();
    const hit = this.isInteractive() ? this.renderer.hitTest(world.x, world.y) : null;
    if (hit) {
      const group = state.groups.get(hit.groupId);
      if (group && this.sync.beginDrag(hit.groupId)) {
        this.renderer.bringToFront(hit.groupId);
        this.dragging = {
          groupId: hit.groupId,
          offsetX: world.x - group.position.x,
          offsetY: world.y - group.position.y,
        };
        return;
      }
      // Held by someone else: swallow the press (the grab rejection surfaces the
      // holder). A locked piece isn't draggable but shouldn't trap the pointer —
      // fall through to pan so the assembled (all-locked) center stays pannable.
      if (group && group.heldBy !== null && group.heldBy !== state.localGuestId) return;
    }
    this.panning = true;
    this.panLast = { x, y };
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) {
      // Hover move (no button): still relay the cursor.
      const p = this.localXY(e);
      this.relayCursor(p.x, p.y);
      this.reportPointer(p.x, p.y);
      return;
    }
    const { x, y } = this.localXY(e);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.reportPointer(x, y);

    if (this.pinch) {
      this.updatePinch();
      return;
    }
    if (this.dragging) {
      const world = this.renderer.screenToWorld(x, y);
      this.sync.dragTo(world.x - this.dragging.offsetX, world.y - this.dragging.offsetY);
      this.relayCursor(x, y);
      return;
    }
    if (this.panning) {
      const cam = this.renderer.camera;
      this.renderer.setCamera({
        x: cam.x + (x - this.panLast.x),
        y: cam.y + (y - this.panLast.y),
        scale: cam.scale,
      });
      this.panLast = { x, y };
      // The world point under the pointer moves as the board pans, so keep
      // relaying the cursor (FR-17) rather than freezing it for remote viewers.
      this.relayCursor(x, y);
      return;
    }
    this.relayCursor(x, y);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const { x, y } = this.localXY(e);
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);

    if (this.dragging) {
      const world = this.renderer.screenToWorld(x, y);
      this.sync.endDrag(world.x - this.dragging.offsetX, world.y - this.dragging.offsetY);
      this.dragging = null;
    }
    this.panning = false;
    if (this.pointers.size < 2) this.pinch = null;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoomTween = null;
    // Exponential so a notch feels the same at any zoom; negative deltaY = in.
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_RATE);
    const scale = clampScale(
      this.renderer.camera.scale * factor,
      this.puzzle.rows,
      this.puzzle.cols,
      this.placement.viewport(),
    );
    const pointer = { x: e.clientX, y: e.clientY };
    this.zoomTo(scale, pointer, pointer);
  };

  private relayCursor(sx: number, sy: number): void {
    const world = this.renderer.screenToWorld(sx, sy);
    this.sync.moveCursor(world.x, world.y);
  }

  private cancelDrag(): void {
    if (!this.dragging) return;
    // A pinch interrupting a drag: drop at the current position so the hold
    // doesn't dangle. Use the group's current store position (no pointer delta).
    const group = this.sync.getState().groups.get(this.dragging.groupId);
    if (group) this.sync.endDrag(group.position.x, group.position.y);
    this.dragging = null;
  }

  private twoPointerCenter(): { midX: number; midY: number; dist: number } {
    const pts = [...this.pointers.values()];
    const a = pts[0]!;
    const b = pts[1]!;
    return {
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  private beginPinch(): void {
    this.zoomTween = null;
    const c = this.twoPointerCenter();
    this.pinch = { dist: c.dist || 1, midX: c.midX, midY: c.midY };
  }

  private updatePinch(): void {
    if (!this.pinch) return;
    const c = this.twoPointerCenter();
    const scale = clampScale(
      this.renderer.camera.scale * (c.dist / this.pinch.dist),
      this.puzzle.rows,
      this.puzzle.cols,
      this.placement.viewport(),
    );
    // Zoom around the pinch midpoint and follow its drift: the world point
    // under the old midpoint ends up under the new one.
    this.zoomTo(scale, { x: this.pinch.midX, y: this.pinch.midY }, { x: c.midX, y: c.midY });
    this.pinch = { dist: c.dist, midX: c.midX, midY: c.midY };
  }
}
