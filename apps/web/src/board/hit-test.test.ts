import { CELL_SIZE, coordToPieceId, generatePuzzle, type Vec2 } from "@puzzlewithme/geometry";
import { describe, expect, it } from "vitest";
import { buildPiecePolygons, pointInPolygon, worldToGroup } from "./hit-test";

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

describe("worldToGroup", () => {
  // A one-piece group stored with its cell at (600..700, 450..550), held by another
  // player: drawn about its centre at 1.08x and raised 25 units, as the renderer does.
  const centre = { x: CELL_SIZE / 2, y: CELL_SIZE / 2 };
  const lifted = { x: 600 + centre.x, y: 450 + centre.y - 25, pivotX: centre.x, pivotY: centre.y, scale: 1.08 };
  const square: Vec2[] = [
    { x: 0, y: 0 },
    { x: CELL_SIZE, y: 0 },
    { x: CELL_SIZE, y: CELL_SIZE },
    { x: 0, y: CELL_SIZE },
  ];
  const hits = (wx: number, wy: number): boolean => {
    const p = worldToGroup(lifted, wx, wy);
    return pointInPolygon(square, p.x, p.y);
  };

  it("inverts the transform the group is drawn with", () => {
    const local = { x: 12, y: 87 };
    const wx = (local.x - lifted.pivotX) * lifted.scale + lifted.x;
    const wy = (local.y - lifted.pivotY) * lifted.scale + lifted.y;
    const back = worldToGroup(lifted, wx, wy);
    expect(back.x).toBeCloseTo(local.x, 9);
    expect(back.y).toBeCloseTo(local.y, 9);
  });

  it("hits a lifted piece where it is drawn, not where it is stored", () => {
    // Drawn from y 421 to 529: the top shows above the stored cell, and the stored cell's bottom is bare.
    expect(hits(615, 430)).toBe(true);
    expect(hits(615, 540)).toBe(false);
    expect(hits(650, 475)).toBe(true);
  });

  it("matches the stored cell for a group drawn where it is stored", () => {
    const resting = { x: 650, y: 500, pivotX: centre.x, pivotY: centre.y, scale: 1 };
    expect(worldToGroup(resting, 615, 540)).toEqual({ x: 15, y: 90 });
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
