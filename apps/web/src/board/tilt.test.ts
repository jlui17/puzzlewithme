import { describe, expect, it } from "vitest";
import { fitPlaneHeight, planeToView, viewToPlane, type TiltView } from "./tilt";

const view: TiltView = {
  perspective: 1700,
  originX: 756,
  originY: 0,
  planeLeft: 113, // (1512 - 1512 * 0.85) / 2
  planeTop: 0,
  tiltDeg: 12,
};

describe("tilt projection", () => {
  it("is the identity at zero tilt", () => {
    const flat = { ...view, tiltDeg: 0 };
    expect(planeToView(flat, 100, 200)).toEqual({ x: 213, y: 200 });
    expect(viewToPlane(flat, 213, 200)).toEqual({ x: 100, y: 200 });
  });

  it("leaves the top edge (the rotation axis) in place and brings the near edge closer", () => {
    const top = planeToView(view, 0, 0);
    expect(top.x).toBeCloseTo(113, 9);
    expect(top.y).toBeCloseTo(0, 9);
    // A point far down the plane projects lower and spreads out from the center.
    const near = planeToView(view, 0, 800);
    expect(near.y).toBeGreaterThan(800 * Math.cos((12 * Math.PI) / 180));
    expect(near.x).toBeLessThan(113);
  });

  it("round-trips view -> plane -> view across the plane", () => {
    for (const [u, v] of [
      [0, 0],
      [1285, 0],
      [0, 820],
      [1285, 820],
      [640, 410],
      [-50, 900],
    ]) {
      const s = planeToView(view, u!, v!);
      const back = viewToPlane(view, s.x, s.y);
      expect(back.x).toBeCloseTo(u!, 6);
      expect(back.y).toBeCloseTo(v!, 6);
    }
  });

  it("fitPlaneHeight gives the depth whose near edge projects to the available height", () => {
    const h = fitPlaneHeight(880, 12, 1700);
    const near = planeToView(view, 0, h);
    expect(near.y).toBeCloseTo(880, 6);
    expect(h).toBeLessThan(880);
  });
});
