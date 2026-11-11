import { CELL_SIZE, matBounds, scatterBounds } from "@puzzlewithme/geometry";
import { describe, expect, it } from "vitest";
import {
  clampCamera,
  clampScale,
  fitCamera,
  maxScale,
  minScale,
  screenToWorld,
  TILT_FLAT_ZOOM,
  tiltForScale,
  worldToScreen,
  zoomAt,
  type Camera,
  type Viewport,
} from "./camera";
import {
  BOARD_FIT_HEADER_INSET_PX,
  BOARD_FIT_MENU_INSET_PX,
  MAX_ZOOM_CELL_FILL,
  MIN_ZOOM_BOARD_MARGIN,
  PAN_OVERSCROLL_PX,
} from "./constants";
import { planeToView, viewToPlane, type TiltView } from "./tilt";

const ROWS = 4;
const COLS = 5;
const VP: Viewport = { width: 800, height: 600 };

describe("worldToScreen / screenToWorld", () => {
  const cam: Camera = { x: 40, y: -25, scale: 2.5 };

  it("applies screen = world * scale + offset", () => {
    expect(worldToScreen(cam, 10, 20)).toEqual({ x: 65, y: 25 });
  });

  it("round-trips through both transforms", () => {
    const w = screenToWorld(cam, 123, 456);
    const s = worldToScreen(cam, w.x, w.y);
    expect(s.x).toBeCloseTo(123, 9);
    expect(s.y).toBeCloseTo(456, 9);
  });
});

describe("scale bounds", () => {
  it("minScale fits the whole mat inside the viewport minus the header and the menu band", () => {
    const s = minScale(ROWS, COLS, VP);
    const b = matBounds(ROWS, COLS);
    expect((b.maxX - b.minX) * s).toBeLessThanOrEqual(VP.width);
    const clearHeight = VP.height - BOARD_FIT_HEADER_INSET_PX - BOARD_FIT_MENU_INSET_PX;
    expect((b.maxY - b.minY) * s).toBeLessThanOrEqual(clearHeight);
    // The margin is applied exactly on the binding axis.
    const box = { width: VP.width, height: clearHeight };
    const rawFit = Math.min(box.width / (b.maxX - b.minX), box.height / (b.maxY - b.minY));
    expect(s).toBeCloseTo(rawFit * MIN_ZOOM_BOARD_MARGIN, 9);
  });

  it("minScale survives a zero-sized viewport during first layout", () => {
    expect(minScale(ROWS, COLS, { width: 0, height: 0 })).toBeGreaterThan(0);
  });

  it("maxScale fills the cell-fill fraction of the smaller viewport side", () => {
    expect(maxScale(VP) * CELL_SIZE).toBeCloseTo(600 * MAX_ZOOM_CELL_FILL, 9);
  });

  it("clampScale pins to both ends and passes values in range through", () => {
    const lo = minScale(ROWS, COLS, VP);
    const hi = maxScale(VP);
    expect(clampScale(lo / 10, ROWS, COLS, VP)).toBe(lo);
    expect(clampScale(hi * 10, ROWS, COLS, VP)).toBe(hi);
    const mid = (lo + hi) / 2;
    expect(clampScale(mid, ROWS, COLS, VP)).toBe(mid);
  });
});

describe("clampCamera", () => {
  const scale = minScale(ROWS, COLS, VP) * 2; // mat larger than the viewport on both axes

  it("stops the mat's near edge at the overscroll slack", () => {
    const b = matBounds(ROWS, COLS);
    // Dragged absurdly far right/down: the mat's left/top edge clamps to +slack.
    const cam = clampCamera({ x: 1e6, y: 1e6, scale }, ROWS, COLS, VP);
    expect(b.minX * scale + cam.x).toBeCloseTo(PAN_OVERSCROLL_PX, 6);
    expect(b.minY * scale + cam.y).toBeCloseTo(PAN_OVERSCROLL_PX, 6);
  });

  it("stops the mat's far edge symmetrically on the other side", () => {
    const b = matBounds(ROWS, COLS);
    const worldW = (b.maxX - b.minX) * scale;
    const worldH = (b.maxY - b.minY) * scale;
    const cam = clampCamera({ x: -1e6, y: -1e6, scale }, ROWS, COLS, VP);
    expect(b.minX * scale + cam.x).toBeCloseTo(VP.width - worldW - PAN_OVERSCROLL_PX, 6);
    expect(b.minY * scale + cam.y).toBeCloseTo(VP.height - worldH - PAN_OVERSCROLL_PX, 6);
  });

  it("leaves an in-range camera untouched and never changes scale", () => {
    const centered = fitCamera(ROWS, COLS, VP);
    expect(clampCamera(centered, ROWS, COLS, VP)).toEqual(centered);
  });
});

describe("fitCamera", () => {
  it("centers the scatter area between the header and the menu", () => {
    const cam = fitCamera(ROWS, COLS, VP);
    const b = scatterBounds(ROWS, COLS);
    const left = b.minX * cam.scale + cam.x;
    const right = b.maxX * cam.scale + cam.x;
    const top = b.minY * cam.scale + cam.y;
    const bottom = b.maxY * cam.scale + cam.y;
    expect(left).toBeCloseTo(VP.width - right, 6);
    expect(top - BOARD_FIT_HEADER_INSET_PX).toBeCloseTo(VP.height - BOARD_FIT_MENU_INSET_PX - bottom, 6);
  });

  it("yields a scale inside the clamp range", () => {
    const cam = fitCamera(ROWS, COLS, VP);
    expect(cam.scale).toBeGreaterThanOrEqual(minScale(ROWS, COLS, VP));
    expect(cam.scale).toBeLessThanOrEqual(maxScale(VP));
  });
});

describe("zoomAt", () => {
  it("keeps the world point under the anchor fixed", () => {
    const cam = fitCamera(ROWS, COLS, VP);
    const anchor = { x: 400, y: 250 };
    const before = screenToWorld(cam, anchor.x, anchor.y);
    const next = zoomAt(cam, cam.scale * 1.5, anchor, anchor);
    const after = screenToWorld(next, anchor.x, anchor.y);
    expect(next.scale).toBeCloseTo(cam.scale * 1.5, 9);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("moves the world point from one canvas pixel to another", () => {
    const cam: Camera = { x: 40, y: -25, scale: 2 };
    const world = screenToWorld(cam, 100, 200);
    const next = zoomAt(cam, 3, { x: 100, y: 200 }, { x: 130, y: 170 });
    const drawn = worldToScreen(next, world.x, world.y);
    expect(drawn.x).toBeCloseTo(130, 9);
    expect(drawn.y).toBeCloseTo(170, 9);
  });

  it("keeps the world point under the pointer on screen while the zoom flattens the tilt", () => {
    const view: TiltView = { perspective: 1700, originX: 756, originY: 0, planeLeft: 113.4, planeTop: 0, tiltDeg: 12 };
    const fitScale = 0.3;
    const viewAt = (scale: number): TiltView => ({ ...view, tiltDeg: tiltForScale(scale, fitScale, 12) });
    const cam: Camera = { x: 60, y: 40, scale: fitScale };
    const pointer = { x: 1180, y: 760 }; // near the near-right corner, where the tilt moves things most
    const from = viewToPlane(viewAt(cam.scale), pointer.x, pointer.y);
    const world = screenToWorld(cam, from.x, from.y);

    const scale = fitScale * 1.6;
    expect(viewAt(scale).tiltDeg).toBeCloseTo(6, 9); // the tilt really changes across this zoom
    const next = zoomAt(cam, scale, from, viewToPlane(viewAt(scale), pointer.x, pointer.y));
    const canvas = worldToScreen(next, world.x, world.y);
    const drawn = planeToView(viewAt(scale), canvas.x, canvas.y);
    expect(drawn.x).toBeCloseTo(pointer.x, 6);
    expect(drawn.y).toBeCloseTo(pointer.y, 6);

    // Solving on the canvas alone, ignoring the tilt change, misses by many pixels.
    const naive = worldToScreen(zoomAt(cam, scale, from, from), world.x, world.y);
    const naiveDrawn = planeToView(viewAt(scale), naive.x, naive.y);
    expect(Math.hypot(naiveDrawn.x - pointer.x, naiveDrawn.y - pointer.y)).toBeGreaterThan(10);
  });
});

describe("tiltForScale", () => {
  it("is the resting tilt at the fit zoom and when zoomed out past it", () => {
    expect(tiltForScale(0.3, 0.3, 12)).toBe(12);
    expect(tiltForScale(0.2, 0.3, 12)).toBe(12);
  });

  it("flattens linearly to 0 at TILT_FLAT_ZOOM times the fit scale", () => {
    expect(TILT_FLAT_ZOOM).toBe(2.2);
    expect(tiltForScale(0.3 * 1.6, 0.3, 12)).toBeCloseTo(6, 9);
    expect(tiltForScale(0.3 * 2.2, 0.3, 12)).toBeCloseTo(0, 9);
  });

  it("stays level beyond TILT_FLAT_ZOOM", () => {
    expect(tiltForScale(0.3 * 2.5, 0.3, 12)).toBe(0);
    expect(tiltForScale(0.3 * 10, 0.3, 12)).toBe(0);
  });
});
