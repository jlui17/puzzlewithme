import { describe, expect, it } from "vitest";
import { clientToPlane, fitPlaneHeight, planeToClient, planeToView, viewToPlane, type TiltView } from "./tilt";

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

  it("clientToPlane finds the view from the box of a canvas at the plane's top-left, and planeToClient round-trips it", () => {
    // The view sits off the page origin, and a canvas 1285 x 850 lies on the plane.
    const offset = { x: 37.25, y: 96.5 };
    const canvas = { width: 1285, height: 850 };
    for (const tiltDeg of [12, 5.3, 0]) {
      const t = { ...view, tiltDeg };
      // getBoundingClientRect of the drawn canvas: the box around its four projected corners.
      const corners = [
        [0, 0],
        [canvas.width, 0],
        [0, canvas.height],
        [canvas.width, canvas.height],
      ].map(([u, v]) => planeToView(t, u!, v!));
      const box = {
        left: Math.min(...corners.map((c) => c.x)) + offset.x,
        top: Math.min(...corners.map((c) => c.y)) + offset.y,
      };
      for (const [u, v] of [
        [0, 0],
        [1285, 0],
        [12, 840],
        [1270, 790],
        [640, 410],
      ]) {
        const drawn = planeToView(t, u!, v!);
        const back = clientToPlane(t, box, canvas.height, drawn.x + offset.x, drawn.y + offset.y);
        expect(back.x).toBeCloseTo(u!, 6);
        expect(back.y).toBeCloseTo(v!, 6);
        const client = planeToClient(t, box, canvas.height, u!, v!);
        expect(client.x).toBeCloseTo(drawn.x + offset.x, 6);
        expect(client.y).toBeCloseTo(drawn.y + offset.y, 6);
      }
    }
  });

  it("clientToPlane is the plain box offset when the plane lies flat", () => {
    const back = clientToPlane({ ...view, tiltDeg: 0 }, { left: 150, top: 96 }, 850, 400, 300);
    expect(back.x).toBeCloseTo(250, 9);
    expect(back.y).toBeCloseTo(204, 9);
  });
});
