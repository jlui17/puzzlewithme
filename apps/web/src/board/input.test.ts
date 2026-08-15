import { beforeEach, describe, expect, it } from "vitest";
import type { SyncClient } from "../sync";
import type { BoardRenderer } from "./renderer";
import { screenToWorld, type Camera } from "./camera";
import { InputController } from "./input";

/**
 * Drives InputController's gesture arbitration (drag vs. pan vs. pinch,
 * FR-26/27 §7.3) through fakes of its three seams: the canvas (plain listener
 * registry), the renderer (camera value + scripted hitTest), and the sync
 * client (recorded intents). Same pattern as sync/test-fakes.ts; these fakes
 * stay local because only this suite arbitrates gestures.
 */

class FakeCanvas {
  readonly listeners = new Map<string, (e: any) => void>();
  clientWidth = 800;
  clientHeight = 600;

  addEventListener(type: string, fn: (e: any) => void): void {
    this.listeners.set(type, fn);
  }
  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }
  getBoundingClientRect(): { left: number; top: number } {
    return { left: 0, top: 0 };
  }
  setPointerCapture(): void {}
  hasPointerCapture(): boolean {
    return false;
  }
  releasePointerCapture(): void {}

  dispatch(type: string, event: Record<string, unknown>): void {
    this.listeners.get(type)!(event);
  }
}

class FakeRenderer {
  camera: Camera = { x: 0, y: 0, scale: 1 };
  cameraLog: Camera[] = [];
  broughtToFront: string[] = [];
  hitResult: { groupId: string; pieceId: number } | null = null;
  hitTestCalls = 0;

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return screenToWorld(this.camera, sx, sy);
  }
  setCamera(cam: Camera): void {
    this.camera = cam;
    this.cameraLog.push(cam);
  }
  hitTest(): { groupId: string; pieceId: number } | null {
    this.hitTestCalls++;
    return this.hitResult;
  }
  bringToFront(groupId: string): void {
    this.broughtToFront.push(groupId);
  }
}

interface FakeGroup {
  position: { x: number; y: number };
  heldBy: string | null;
}

class FakeSync {
  groups = new Map<string, FakeGroup>();
  localGuestId = "me";
  beginDragResult = true;
  calls: { method: string; args: unknown[] }[] = [];

  getState(): { groups: Map<string, FakeGroup>; localGuestId: string } {
    return { groups: this.groups, localGuestId: this.localGuestId };
  }
  beginDrag(groupId: string): boolean {
    this.calls.push({ method: "beginDrag", args: [groupId] });
    return this.beginDragResult;
  }
  dragTo(x: number, y: number): void {
    this.calls.push({ method: "dragTo", args: [x, y] });
  }
  endDrag(x: number, y: number): void {
    this.calls.push({ method: "endDrag", args: [x, y] });
  }
  moveCursor(x: number, y: number): void {
    this.calls.push({ method: "moveCursor", args: [x, y] });
  }

  of(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }
}

interface Harness {
  canvas: FakeCanvas;
  renderer: FakeRenderer;
  sync: FakeSync;
}

let h: Harness;
let interactive: boolean;

function down(id: number, x: number, y: number): void {
  h.canvas.dispatch("pointerdown", { pointerId: id, clientX: x, clientY: y });
}
function move(id: number, x: number, y: number): void {
  h.canvas.dispatch("pointermove", { pointerId: id, clientX: x, clientY: y });
}
function up(id: number, x: number, y: number): void {
  h.canvas.dispatch("pointerup", { pointerId: id, clientX: x, clientY: y });
}

beforeEach(() => {
  h = { canvas: new FakeCanvas(), renderer: new FakeRenderer(), sync: new FakeSync() };
  interactive = true;
  const controller = new InputController(
    h.canvas as unknown as HTMLCanvasElement,
    h.renderer as unknown as BoardRenderer,
    h.sync as unknown as SyncClient,
    { rows: 4, cols: 5 },
    () => interactive,
    () => {},
  );
  controller.attach();
});

describe("drag", () => {
  beforeEach(() => {
    // Identity camera, so world == screen and the intent math is exact.
    h.renderer.hitResult = { groupId: "g1", pieceId: 0 };
    h.sync.groups.set("g1", { position: { x: 80, y: 90 }, heldBy: null });
  });

  it("press on a grabbable piece drags by the grab-point offset, then drops", () => {
    down(1, 100, 100); // grab offset within the group: (20, 10)
    expect(h.sync.of("beginDrag")).toEqual([["g1"]]);
    expect(h.renderer.broughtToFront).toEqual(["g1"]);

    move(1, 150, 120);
    expect(h.sync.of("dragTo")).toEqual([[130, 110]]);

    up(1, 160, 130);
    expect(h.sync.of("endDrag")).toEqual([[140, 120]]);
  });

  it("press on a piece held by someone else is swallowed: no drag, no pan", () => {
    h.sync.beginDragResult = false;
    h.sync.groups.get("g1")!.heldBy = "other";

    down(1, 100, 100);
    move(1, 150, 120);
    expect(h.sync.of("dragTo")).toEqual([]);
    expect(h.renderer.cameraLog).toEqual([]);
  });

  it("press on a locked piece (held by nobody, grab refused) falls through to pan", () => {
    h.sync.beginDragResult = false;

    down(1, 100, 100);
    move(1, 150, 120);
    expect(h.renderer.cameraLog).toEqual([{ x: 50, y: 20, scale: 1 }]);
  });

  it("when not interactive, a press never hit-tests and pans instead", () => {
    interactive = false;
    down(1, 100, 100);
    move(1, 110, 100);
    expect(h.renderer.hitTestCalls).toBe(0);
    expect(h.sync.of("beginDrag")).toEqual([]);
    expect(h.renderer.cameraLog).toHaveLength(1);
  });
});

describe("pan", () => {
  it("press on empty space pans the camera by the pointer delta", () => {
    down(1, 200, 200);
    move(1, 230, 180);
    move(1, 240, 175);
    expect(h.renderer.cameraLog).toEqual([
      { x: 30, y: -20, scale: 1 },
      { x: 40, y: -25, scale: 1 },
    ]);
  });
});

describe("pinch", () => {
  it("a second finger cancels an active drag with a drop at the group's current position", () => {
    h.renderer.hitResult = { groupId: "g1", pieceId: 0 };
    h.sync.groups.set("g1", { position: { x: 80, y: 90 }, heldBy: null });

    down(1, 100, 100);
    down(2, 300, 100);
    expect(h.sync.of("endDrag")).toEqual([[80, 90]]);

    // The now-pinching first finger no longer emits drag intents.
    move(1, 120, 100);
    expect(h.sync.of("dragTo")).toEqual([]);
  });

  it("spreading two fingers zooms in around their midpoint", () => {
    down(1, 100, 300);
    down(2, 300, 300);
    move(2, 500, 300); // distance 200 → 400
    const cam = h.renderer.camera;
    expect(cam.scale).toBeGreaterThan(1);
  });
});

describe("wheel and hover", () => {
  it("wheel up zooms in around the cursor", () => {
    let prevented = false;
    h.canvas.dispatch("wheel", {
      clientX: 400,
      clientY: 300,
      deltaY: -200,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(h.renderer.camera.scale).toBeGreaterThan(1);
    // The world point under the cursor stayed put (zoomAt's anchor contract).
    const w = screenToWorld(h.renderer.camera, 400, 300);
    expect(w.x).toBeCloseTo(400, 6);
    expect(w.y).toBeCloseTo(300, 6);
  });

  it("a hover move (no button) still relays the cursor", () => {
    move(9, 250, 260);
    expect(h.sync.of("moveCursor")).toEqual([[250, 260]]);
  });
});
