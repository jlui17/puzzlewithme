import { describe, expect, it } from "vitest";
import { deriveGrid, MAX_PIECE_COUNT, MIN_PIECE_COUNT } from "./index.js";

// The old fixed tiers plus arbitrary in-between requests the slider can now send.
const TARGETS = [100, 250, 337, 550, 763, 1000];

// width:height pairs covering square, landscape, portrait, and extreme.
const ASPECTS: Array<{ name: string; w: number; h: number }> = [
  { name: "square", w: 1000, h: 1000 },
  { name: "16:9", w: 1920, h: 1080 },
  { name: "9:16", w: 1080, h: 1920 },
  { name: "3:1", w: 3000, h: 1000 },
];

describe("deriveGrid", () => {
  for (const target of TARGETS) {
    for (const { name, w, h } of ASPECTS) {
      it(`keeps pieces near-square and count near the request (${target}, ${name})`, () => {
        const { rows, cols } = deriveGrid(target, w, h);
        expect(rows).toBeGreaterThanOrEqual(1);
        expect(cols).toBeGreaterThanOrEqual(1);

        const pieceAspect = w / cols / (h / rows);
        // Within sqrt(2): no piece more than ~1.41x longer on one axis.
        expect(pieceAspect).toBeGreaterThan(1 / Math.SQRT2);
        expect(pieceAspect).toBeLessThan(Math.SQRT2);

        const count = rows * cols;
        // Count stays within 15% of the request (FR-3 allows it to differ).
        expect(Math.abs(count - target) / target).toBeLessThanOrEqual(0.15);
      });
    }
  }

  it("is deterministic for the same inputs (client preview must match server)", () => {
    expect(deriveGrid(550, 1920, 1080)).toEqual(deriveGrid(550, 1920, 1080));
  });

  it("orients the grid to the image (more cols when wider, more rows when taller)", () => {
    const wide = deriveGrid(500, 1920, 1080);
    expect(wide.cols).toBeGreaterThan(wide.rows);
    const tall = deriveGrid(500, 1080, 1920);
    expect(tall.rows).toBeGreaterThan(tall.cols);
  });

  it("rejects non-positive dimensions and non-integer targets", () => {
    expect(() => deriveGrid(100, 0, 100)).toThrow();
    expect(() => deriveGrid(100.5, 1000, 1000)).toThrow();
    expect(() => deriveGrid(0, 1000, 1000)).toThrow();
  });

  it("exports sane product bounds", () => {
    expect(MIN_PIECE_COUNT).toBeLessThan(MAX_PIECE_COUNT);
    expect(MIN_PIECE_COUNT).toBeGreaterThan(0);
  });
});
