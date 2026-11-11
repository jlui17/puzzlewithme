import { describe, expect, it } from "vitest";
import { planeToView } from "../board/tilt";
import { sizeTable } from "./table-size";

// A MacBook home: 982 px tall window, the view starting under a 294 px window band, sill and wall.
const base = { space: 982 - 348, content: 400, tiltDeg: 28, perspective: 1700, edge: 33, growWithContent: false };

describe("sizeTable", () => {
  it("lands the plane's near edge one edge-thickness above the bottom of the screen", () => {
    const size = sizeTable(base);
    expect(size.tiltDeg).toBe(28);
    expect(size.viewHeight).toBeCloseTo(base.space, 9);
    // The browser's projection of the plane's near edge, from the board's own math.
    const near = planeToView(
      { perspective: 1700, originX: 756, originY: 0, planeLeft: 113, planeTop: 0, tiltDeg: 28 },
      0,
      size.planeHeight,
    );
    expect(near.y).toBeCloseTo(base.space - base.edge, 9);
  });

  it("keeps the room's plane at the fit however tall its content is", () => {
    const fit = sizeTable(base).planeHeight;
    expect(sizeTable({ ...base, content: 5000 }).planeHeight).toBe(fit);
  });

  it("grows the home's plane with its content and lets the view run past the screen", () => {
    const home = { ...base, growWithContent: true };
    const fit = sizeTable(home).planeHeight;
    expect(sizeTable(home).viewHeight).toBeCloseTo(base.space, 9);

    const tall = sizeTable({ ...home, content: fit + 300 });
    expect(tall.planeHeight).toBe(fit + 300);
    expect(tall.viewHeight).toBeGreaterThan(base.space);
  });

  // The near edge's magnification, as the browser draws the plane.
  const nearScale = (size: { tiltDeg: number; planeHeight: number }): number =>
    base.perspective / (base.perspective - size.planeHeight * Math.sin((size.tiltDeg * Math.PI) / 180));

  it.each([2000, 4000, 20000])("flattens a home plane %ipx deep so its near edge is magnified no more than at the fit", (content) => {
    const home = { ...base, growWithContent: true };
    const atFit = sizeTable(home);
    const tall = sizeTable({ ...home, content });
    expect(tall.planeHeight).toBe(content);
    expect(tall.tiltDeg).toBeGreaterThan(0);
    expect(tall.tiltDeg).toBeLessThan(28);
    expect(nearScale(tall)).toBeCloseTo(nearScale(atFit), 9);
    // The view is set, and taller than the screen, so the page scrolls.
    expect(Number.isFinite(tall.viewHeight)).toBe(true);
    expect(tall.viewHeight).toBeGreaterThan(base.space);
  });

  it("flattens a longer home plane more", () => {
    const home = { ...base, growWithContent: true };
    expect(sizeTable({ ...home, content: 4000 }).tiltDeg).toBeLessThan(sizeTable({ ...home, content: 2000 }).tiltDeg);
  });

  it("lies flat and fills the space when the tilt is 0", () => {
    expect(sizeTable({ ...base, tiltDeg: 0 })).toEqual({ tiltDeg: 0, planeHeight: base.space, viewHeight: base.space });
  });

  it("lies flat when the screen is too short to tilt", () => {
    const size = sizeTable({ ...base, space: 239 + base.edge });
    expect(size.tiltDeg).toBe(0);
    expect(size.viewHeight).toBe(239 + base.edge);
  });

  it("grows a flat home plane with its content", () => {
    const size = sizeTable({ ...base, tiltDeg: 0, content: 2000, growWithContent: true });
    expect(size).toEqual({ tiltDeg: 0, planeHeight: 2000, viewHeight: 2000 });
  });
});
