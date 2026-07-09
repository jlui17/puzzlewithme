import { describe, expect, it } from "vitest";
import { boardBounds, CELL_SIZE, initialScatter, TAB_HEIGHT_RATIO } from "./index.js";

const OVERHANG = TAB_HEIGHT_RATIO * CELL_SIZE;

function boxesOverlap(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  // CELL_SIZE footprints: overlap only if they intersect on both axes.
  return (
    a.x < b.x + CELL_SIZE &&
    b.x < a.x + CELL_SIZE &&
    a.y < b.y + CELL_SIZE &&
    b.y < a.y + CELL_SIZE
  );
}

describe("boardBounds", () => {
  it("is 3x the frame, centered, extending negative", () => {
    const { minX, minY, maxX, maxY } = boardBounds(4, 6);
    const frameW = 6 * CELL_SIZE;
    const frameH = 4 * CELL_SIZE;
    expect(minX).toBe(-frameW);
    expect(minY).toBe(-frameH);
    expect(maxX).toBe(2 * frameW);
    expect(maxY).toBe(2 * frameH);
  });
});

describe("initialScatter", () => {
  const ROWS = 8;
  const COLS = 10;
  const positions = initialScatter(ROWS, COLS, "scatter-test");
  const bounds = boardBounds(ROWS, COLS);
  const frameW = COLS * CELL_SIZE;
  const frameH = ROWS * CELL_SIZE;

  it("places every piece", () => {
    expect(positions).toHaveLength(ROWS * COLS);
  });

  it("keeps every piece footprint inside the board bounds", () => {
    for (const p of positions) {
      expect(p.x - OVERHANG).toBeGreaterThanOrEqual(bounds.minX - 1e-6);
      expect(p.y - OVERHANG).toBeGreaterThanOrEqual(bounds.minY - 1e-6);
      expect(p.x + CELL_SIZE + OVERHANG).toBeLessThanOrEqual(bounds.maxX + 1e-6);
      expect(p.y + CELL_SIZE + OVERHANG).toBeLessThanOrEqual(bounds.maxY + 1e-6);
    }
  });

  it("never overlaps the frame region (incl. tab overhang)", () => {
    for (const p of positions) {
      const left = p.x - OVERHANG;
      const right = p.x + CELL_SIZE + OVERHANG;
      const top = p.y - OVERHANG;
      const bottom = p.y + CELL_SIZE + OVERHANG;
      const intersectsFrame = left < frameW && right > 0 && top < frameH && bottom > 0;
      expect(intersectsFrame).toBe(false);
    }
  });

  it("keeps pieces pickable: CELL_SIZE footprints do not overlap", () => {
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        expect(boxesOverlap(positions[i]!, positions[j]!)).toBe(false);
      }
    }
  });
});

describe("initialScatter at max tier scale (NFR-1: 1000 pieces)", () => {
  // 32x32 = 1024 pieces exercises the pitch-fit logic at the largest tier.
  const ROWS = 32;
  const COLS = 32;
  const positions = initialScatter(ROWS, COLS, "big");
  const bounds = boardBounds(ROWS, COLS);
  const frameW = COLS * CELL_SIZE;
  const frameH = ROWS * CELL_SIZE;

  it("places all 1024 pieces in bounds and clear of the frame", () => {
    expect(positions).toHaveLength(ROWS * COLS);
    for (const p of positions) {
      expect(p.x - OVERHANG).toBeGreaterThanOrEqual(bounds.minX - 1e-6);
      expect(p.x + CELL_SIZE + OVERHANG).toBeLessThanOrEqual(bounds.maxX + 1e-6);
      expect(p.y - OVERHANG).toBeGreaterThanOrEqual(bounds.minY - 1e-6);
      expect(p.y + CELL_SIZE + OVERHANG).toBeLessThanOrEqual(bounds.maxY + 1e-6);
      const intersectsFrame =
        p.x - OVERHANG < frameW && p.x + CELL_SIZE + OVERHANG > 0 && p.y - OVERHANG < frameH && p.y + CELL_SIZE + OVERHANG > 0;
      expect(intersectsFrame).toBe(false);
    }
  });

  it("keeps footprints non-overlapping at scale", () => {
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        expect(boxesOverlap(positions[i]!, positions[j]!)).toBe(false);
      }
    }
  });
});
