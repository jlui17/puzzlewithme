import { CELL_SIZE, coordToPieceId, generatePuzzle, type Vec2 } from "@puzzlewithme/geometry";
import { describe, expect, it } from "vitest";
import { buildPiecePolygons, pointInPolygon } from "./hit-test";

describe("pointInPolygon", () => {
  const square: Vec2[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it("classifies inside and outside of a convex polygon", () => {
    expect(pointInPolygon(square, 5, 5)).toBe(true);
    expect(pointInPolygon(square, 15, 5)).toBe(false);
    expect(pointInPolygon(square, 5, -1)).toBe(false);
  });

  it("excludes a concave notch that a bounding box would include", () => {
    // An L-shape: the 10x10 square minus its top-right 5x5 corner.
    const ell: Vec2[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon(ell, 7, 2)).toBe(false); // in the notch, inside the box
    expect(pointInPolygon(ell, 7, 7)).toBe(true);
    expect(pointInPolygon(ell, 2, 2)).toBe(true);
  });
});

describe("buildPiecePolygons", () => {
  const ROWS = 3;
  const COLS = 3;
  const puzzle = generatePuzzle(ROWS, COLS, "hit-test-test");
  const polygons = buildPiecePolygons(puzzle);

  it("produces a closed-loop polygon per piece containing the cell center", () => {
    expect(polygons.size).toBe(ROWS * COLS);
    for (const piece of puzzle.pieces) {
      const poly = polygons.get(piece.id)!;
      expect(poly.length).toBeGreaterThanOrEqual(4);
      // Piece-local coordinates: the cell spans [0, CELL_SIZE]^2, and no tab or
      // blank reaches the center.
      expect(pointInPolygon(poly, CELL_SIZE / 2, CELL_SIZE / 2)).toBe(true);
    }
  });

  it("partitions the shared-edge band: every point belongs to exactly one neighbor", () => {
    // Two horizontally adjacent pieces flatten the identical shared curve
    // (edges are complementary by construction, puzzle.test.ts), so their
    // polygons tile the band around the shared edge with no gap or overlap.
    const left = puzzle.pieces[coordToPieceId(1, 0, COLS)]!;
    const right = puzzle.pieces[coordToPieceId(1, 1, COLS)]!;
    const leftPoly = polygons.get(left.id)!;
    const rightPoly = polygons.get(right.id)!;

    // World point → each piece's local frame.
    const inLeft = (wx: number, wy: number) =>
      pointInPolygon(leftPoly, wx - left.framePosition.x, wy - left.framePosition.y);
    const inRight = (wx: number, wy: number) =>
      pointInPolygon(rightPoly, wx - right.framePosition.x, wy - right.framePosition.y);

    const edgeX = right.framePosition.x; // the shared vertical edge
    let crossOwned = 0;
    for (let dy = 10; dy <= CELL_SIZE - 10; dy += 4) {
      for (let dx = -20; dx <= 20; dx += 2) {
        if (dx === 0) continue; // exactly on the boundary is ambiguous by definition
        const wx = edgeX + dx;
        const wy = left.framePosition.y + dy;
        const a = inLeft(wx, wy);
        const b = inRight(wx, wy);
        expect(a !== b).toBe(true);
        // The point is on one piece's side of the straight edge but belongs to
        // the other: only a tab/blank curve can cause this.
        if (a !== dx < 0) crossOwned++;
      }
    }
    // The shared edge is a tab into one of the two pieces (never flat in the
    // interior), so a box-based test would misassign a whole region of points.
    expect(crossOwned).toBeGreaterThan(0);
  });
});
