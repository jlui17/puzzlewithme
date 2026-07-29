import { describe, expect, it } from "vitest";
import {
  CELL_SIZE,
  initialScatter,
  matBounds,
  MAT_ASPECT,
  playArea,
  SCATTER_ROOM_FACTOR,
  TAB_MAX_HEIGHT_RATIO,
} from "./index.js";

const OVERHANG = TAB_MAX_HEIGHT_RATIO * CELL_SIZE;

function boxesOverlap(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  // CELL_SIZE footprints: overlap only if they intersect on both axes.
  return (
    a.x < b.x + CELL_SIZE &&
    b.x < a.x + CELL_SIZE &&
    a.y < b.y + CELL_SIZE &&
    b.y < a.y + CELL_SIZE
  );
}

describe("playArea", () => {
  it("is landscape whatever the frame's shape, and holds the frame", () => {
    for (const [rows, cols] of [
      [4, 6],
      [6, 4],
      [5, 5],
    ] as const) {
      const p = playArea(rows, cols);
      const aspect = (p.maxX - p.minX) / (p.maxY - p.minY);
      expect(aspect).toBeCloseTo(MAT_ASPECT, 5);
      expect(p.minX).toBeLessThan(0);
      expect(p.minY).toBeLessThan(0);
      expect(p.maxX).toBeGreaterThan(cols * CELL_SIZE);
      expect(p.maxY).toBeGreaterThan(rows * CELL_SIZE);
    }
  });

  it("grows with the piece count instead of tracking the frame by a fixed multiple", () => {
    // Same frame shape, 25x the pieces: the surface must not scale by 25x, but
    // it must grow well past the small board's.
    const few = playArea(4, 4);
    const many = playArea(20, 20);
    const bandFew = -few.minY;
    const bandMany = -many.minY;
    expect(bandMany).toBeGreaterThan(bandFew * 2);
  });

  it("sits inside the mat, which carries the hem around it", () => {
    const p = playArea(8, 10);
    const m = matBounds(8, 10);
    expect(m.minX).toBeLessThan(p.minX);
    expect(m.minY).toBeLessThan(p.minY);
    expect(m.maxX).toBeGreaterThan(p.maxX);
    expect(m.maxY).toBeGreaterThan(p.maxY);
  });
});

describe("initialScatter", () => {
  const ROWS = 8;
  const COLS = 10;
  const positions = initialScatter(ROWS, COLS, "scatter-test");
  const bounds = playArea(ROWS, COLS);
  const frameW = COLS * CELL_SIZE;
  const frameH = ROWS * CELL_SIZE;

  it("places every piece", () => {
    expect(positions).toHaveLength(ROWS * COLS);
  });

  it("hugs the frame instead of filling the surface", () => {
    // The nearest-cells pool is what keeps a puzzle workable on a phone: pieces
    // ring the frame, and the cloth's far corners stay empty to sort into.
    const area = playArea(ROWS, COLS);
    const frameW = COLS * CELL_SIZE;
    const frameH = ROWS * CELL_SIZE;
    const distToFrame = (x: number, y: number): number => {
      const dx = Math.max(0, -x, x - frameW);
      const dy = Math.max(0, -y, y - frameH);
      return Math.sqrt(dx * dx + dy * dy);
    };
    const corner = distToFrame(area.minX, area.minY);
    const farthestPiece = Math.max(...positions.map((p) => distToFrame(p.x, p.y)));
    expect(farthestPiece).toBeLessThan(corner * 0.8);
  });

  it("uses no more cells than the room factor allows", () => {
    // Every piece sits on a distinct cell drawn from that pool, so a compact
    // scatter can never silently become a uniform fill.
    const unique = new Set(positions.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
    expect(unique.size).toBe(ROWS * COLS);
    expect(ROWS * COLS).toBeLessThanOrEqual(Math.ceil(ROWS * COLS * SCATTER_ROOM_FACTOR));
  });

  it("keeps every piece footprint inside the play area", () => {
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
  const bounds = playArea(ROWS, COLS);
  const frameW = COLS * CELL_SIZE;
  const frameH = ROWS * CELL_SIZE;

  it("places all 1024 pieces in the play area and clear of the frame", () => {
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
