import type { SyncClient } from "../sync";
import type { BoardRenderer } from "./renderer";
import { WHEEL_ZOOM_RATE } from "./constants";
import { zoomAt } from "./camera";

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
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private dragging: { groupId: string; offsetX: number; offsetY: number } | null = null;
  private panning = false;
  private panLast = { x: 0, y: 0 };
  private pinch: { dist: number; midX: number; midY: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: BoardRenderer,
    private readonly sync: SyncClient,
    private readonly puzzle: { rows: number; cols: number },
    private readonly isInteractive: () => boolean,
    private readonly reportPointer: (screenX: number, screenY: number) => void,
  ) {}

  attach(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  detach(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
  }

  private localXY(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown = (e: PointerEvent): void => {
    const { x, y } = this.localXY(e);
    this.pointers.set(e.pointerId, { x, y });
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
    this.pointers.set(e.pointerId, { x, y });
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
    const rect = this.canvas.getBoundingClientRect();
    const ax = e.clientX - rect.left;
    const ay = e.clientY - rect.top;
    // Exponential so a notch feels the same at any zoom; negative deltaY = in.
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_RATE);
    this.renderer.setCamera(
      zoomAt(this.renderer.camera, factor, ax, ay, this.puzzle.rows, this.puzzle.cols, {
        width: this.canvas.clientWidth,
        height: this.canvas.clientHeight,
      }),
    );
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
    const c = this.twoPointerCenter();
    this.pinch = { dist: c.dist || 1, midX: c.midX, midY: c.midY };
  }

  private updatePinch(): void {
    if (!this.pinch) return;
    const c = this.twoPointerCenter();
    const factor = c.dist / this.pinch.dist;
    const cam = this.renderer.camera;
    const vp = { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
    // Zoom around the pinch midpoint, then pan by its screen drift.
    let next = zoomAt(cam, factor, this.pinch.midX, this.pinch.midY, this.puzzle.rows, this.puzzle.cols, vp);
    next = { x: next.x + (c.midX - this.pinch.midX), y: next.y + (c.midY - this.pinch.midY), scale: next.scale };
    this.renderer.setCamera(next);
    this.pinch = { dist: c.dist, midX: c.midX, midY: c.midY };
  }
}
