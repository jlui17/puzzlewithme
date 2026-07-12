import { describe, expect, it } from "vitest";
import { clampTileToFrame } from "./atlas";

// World-unit fixtures: 100-unit cells, 20-unit overhang, 140-unit tiles on a
// 3x3-cell frame (300x300). Only the clamping math is under test; the canvas
// bake itself needs a DOM and is exercised in the browser.
const OVERHANG = 20;
const TILE = 100 + 2 * OVERHANG;
const FRAME_W = 300;
const FRAME_H = 300;

describe("clampTileToFrame", () => {
  it("leaves an interior tile untouched", () => {
    expect(clampTileToFrame(100, 100, OVERHANG, TILE, FRAME_W, FRAME_H)).toEqual({
      x0: 80,
      y0: 80,
      x1: 220,
      y1: 220,
    });
  });

  it("clamps a top-left corner tile to the frame origin", () => {
    // Unclamped box would start at (-20, -20): the out-of-bounds source rect
    // iOS Safari refuses to draw.
    expect(clampTileToFrame(0, 0, OVERHANG, TILE, FRAME_W, FRAME_H)).toEqual({
      x0: 0,
      y0: 0,
      x1: 120,
      y1: 120,
    });
  });

  it("clamps a bottom-right corner tile to the frame extent", () => {
    expect(clampTileToFrame(200, 200, OVERHANG, TILE, FRAME_W, FRAME_H)).toEqual({
      x0: 180,
      y0: 180,
      x1: 300,
      y1: 300,
    });
  });
});
