import { describe, expect, it } from "vitest";
import { deriveGrid, type Tier } from "./index.js";

const TIERS: Tier[] = [100, 250, 500, 1000];

// width:height pairs covering square, landscape, portrait, and extreme.
const ASPECTS: Array<{ name: string; w: number; h: number }> = [
  { name: "square", w: 1000, h: 1000 },
  { name: "16:9", w: 1920, h: 1080 },
  { name: "9:16", w: 1080, h: 1920 },
  { name: "3:1", w: 3000, h: 1000 },
];

describe("deriveGrid", () => {
  for (const tier of TIERS) {
    for (const { name, w, h } of ASPECTS) {
      it(`keeps pieces near-square and count near tier (${tier}, ${name})`, () => {
        const { rows, cols } = deriveGrid(tier, w, h);
        expect(rows).toBeGreaterThanOrEqual(1);
        expect(cols).toBeGreaterThanOrEqual(1);

        const pieceAspect = w / cols / (h / rows);
        // Within sqrt(2): no piece more than ~1.41x longer on one axis.
        expect(pieceAspect).toBeGreaterThan(1 / Math.SQRT2);
        expect(pieceAspect).toBeLessThan(Math.SQRT2);

        const count = rows * cols;
        // Count stays within 15% of the requested tier (FR-3 allows it to differ).
        expect(Math.abs(count - tier) / tier).toBeLessThanOrEqual(0.15);
      });
    }
  }

  it("orients the grid to the image (more cols when wider, more rows when taller)", () => {
    const wide = deriveGrid(500, 1920, 1080);
    expect(wide.cols).toBeGreaterThan(wide.rows);
    const tall = deriveGrid(500, 1080, 1920);
    expect(tall.rows).toBeGreaterThan(tall.cols);
  });

  it("rejects non-positive dimensions", () => {
    expect(() => deriveGrid(100, 0, 100)).toThrow();
  });
});
