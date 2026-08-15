import { CELL_SIZE, matBounds, scatterBounds } from "@puzzlewithme/geometry";
import { describe, expect, it } from "vitest";
import {
  clampCamera,
  clampScale,
  fitCamera,
  maxScale,
  minScale,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Camera,
  type Viewport,
} from "./camera";
import {
  BOARD_FIT_TRAY_INSET_PX,
  MAX_ZOOM_CELL_FILL,
  MIN_ZOOM_BOARD_MARGIN,
  PAN_OVERSCROLL_PX,
} from "./constants";

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
  it("minScale fits the whole mat inside the viewport minus the tray band", () => {
    const s = minScale(ROWS, COLS, VP);
    const b = matBounds(ROWS, COLS);
    expect((b.maxX - b.minX) * s).toBeLessThanOrEqual(VP.width);
    expect((b.maxY - b.minY) * s).toBeLessThanOrEqual(VP.height - BOARD_FIT_TRAY_INSET_PX);
    // The margin is applied exactly on the binding axis.
    const box = { width: VP.width, height: VP.height - BOARD_FIT_TRAY_INSET_PX };
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
  it("centers the scatter area in the viewport above the tray", () => {
    const cam = fitCamera(ROWS, COLS, VP);
    const b = scatterBounds(ROWS, COLS);
    const left = b.minX * cam.scale + cam.x;
    const right = b.maxX * cam.scale + cam.x;
    const top = b.minY * cam.scale + cam.y;
    const bottom = b.maxY * cam.scale + cam.y;
    expect(left).toBeCloseTo(VP.width - right, 6);
    expect(top).toBeCloseTo(VP.height - BOARD_FIT_TRAY_INSET_PX - bottom, 6);
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
    const next = zoomAt(cam, 1.5, anchor.x, anchor.y, ROWS, COLS, VP);
    const after = screenToWorld(next, anchor.x, anchor.y);
    expect(next.scale).toBeCloseTo(cam.scale * 1.5, 9);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("clamps the scale at max zoom instead of overshooting", () => {
    const cam: Camera = { x: 0, y: 0, scale: maxScale(VP) };
    const next = zoomAt(cam, 2, 400, 300, ROWS, COLS, VP);
    expect(next.scale).toBe(maxScale(VP));
  });
});
