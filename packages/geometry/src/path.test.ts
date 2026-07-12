import { describe, expect, it } from "vitest";
import {
  buildTabEdge,
  CELL_SIZE,
  coordToPieceId,
  edgeControlPoints,
  generatePuzzle,
  pieceOutlineControlPoints,
  pieceSvgPath,
  TAB_ASYMMETRY_JITTER,
  TAB_POS_JITTER,
  TAB_SIZE_JITTER,
  TAB_TILT_JITTER,
  type EdgeJitter,
} from "./index.js";

const COLS = 4;
const puzzle = generatePuzzle(4, COLS, "path-test");
const at = (row: number, col: number) => puzzle.pieces[coordToPieceId(row, col, COLS)]!;

describe("pieceSvgPath", () => {
  it("is a closed path starting at the cell origin", () => {
    const piece = at(1, 1);
    const svg = pieceSvgPath(piece);
    expect(svg.startsWith("M ")).toBe(true);
    expect(svg.trim().endsWith("Z")).toBe(true);
    // Interior piece: all four edges are curves.
    expect(svg).toContain("C ");
  });

  it("border piece has flat (line) segments on its outer sides", () => {
    const svg = pieceSvgPath(at(0, 0));
    expect(svg).toContain("L ");
  });

  it("local coordinates are world coordinates shifted by the frame position", () => {
    const piece = at(2, 3);
    const world = pieceOutlineControlPoints(piece);
    const local = pieceOutlineControlPoints(piece, { local: true });
    expect(local).toHaveLength(world.length);
    world.forEach((w, i) => {
      expect(local[i]!.x).toBeCloseTo(w.x - piece.framePosition.x, 6);
      expect(local[i]!.y).toBeCloseTo(w.y - piece.framePosition.y, 6);
    });
  });

  it("outline is closed (first point equals the cell origin)", () => {
    const piece = at(1, 2);
    const pts = pieceOutlineControlPoints(piece);
    expect(pts[0]).toEqual(piece.framePosition);
  });
});

describe("edgeControlPoints", () => {
  it("returns the same world curve for a shared edge from either piece", () => {
    expect(edgeControlPoints(at(1, 1), "right")).toStrictEqual(edgeControlPoints(at(1, 2), "left"));
  });

  it("a flat edge is its two corner endpoints", () => {
    expect(edgeControlPoints(at(0, 1), "top")).toHaveLength(2);
  });

  it("a tab/blank edge is 13 control points (four cubic segments)", () => {
    expect(edgeControlPoints(at(1, 1), "right")).toHaveLength(13);
  });
});

describe("buildTabEdge: per-edge variation", () => {
  const zero: EdgeJitter = { pos: 0, size: 0, tilt: 0, asymmetry: 0 };

  it("asymmetry gives the bulb unequal half-widths on each flank", () => {
    // Point indices: 4/5 are the left bulb control column, 6 is the peak, 7/8
    // the right bulb control column (see buildTabEdge's `local` array).
    const symmetric = buildTabEdge("horizontal", { x: 0, y: 0 }, 1, zero);
    const symLeftDist = symmetric[6]!.x - symmetric[4]!.x;
    const symRightDist = symmetric[7]!.x - symmetric[6]!.x;
    expect(symLeftDist).toBeCloseTo(symRightDist, 6);

    const lopsided = buildTabEdge("horizontal", { x: 0, y: 0 }, 1, {
      ...zero,
      asymmetry: TAB_ASYMMETRY_JITTER,
    });
    const lopLeftDist = lopsided[6]!.x - lopsided[4]!.x;
    const lopRightDist = lopsided[7]!.x - lopsided[6]!.x;
    expect(lopLeftDist).not.toBeCloseTo(lopRightDist, 2);
  });

  it("tilt offsets the bulb peak from the neck's center", () => {
    // Points 3 and 9 are where the bulb meets the neck; their midpoint is the
    // neck's center, which stays fixed regardless of tilt (only the peak moves).
    const untilted = buildTabEdge("horizontal", { x: 0, y: 0 }, 1, zero);
    const neckMidX = (untilted[3]!.x + untilted[9]!.x) / 2;
    expect(untilted[6]!.x).toBeCloseTo(neckMidX, 6);

    const tilted = buildTabEdge("horizontal", { x: 0, y: 0 }, 1, { ...zero, tilt: TAB_TILT_JITTER });
    expect(tilted[6]!.x).toBeCloseTo(neckMidX + TAB_TILT_JITTER * CELL_SIZE, 6);
  });

  it("keeps every control point clear of the edge's corners at every jitter extreme", () => {
    // Exhaustive over the +-1 corners of the 4D jitter cube: this is exactly
    // the worst case the constants.ts margin comment reasons about, so a future
    // change to any *_JITTER constant that breaks that margin fails here rather
    // than showing up as a rare clipped/self-crossing piece in production.
    const signs = [-1, 1];
    for (const sPos of signs) {
      for (const sSize of signs) {
        for (const sTilt of signs) {
          for (const sAsym of signs) {
            const jitter: EdgeJitter = {
              pos: sPos * TAB_POS_JITTER,
              size: sSize * TAB_SIZE_JITTER,
              tilt: sTilt * TAB_TILT_JITTER,
              asymmetry: sAsym * TAB_ASYMMETRY_JITTER,
            };
            const points = buildTabEdge("horizontal", { x: 0, y: 0 }, 1, jitter);
            // First/last points are the edge's fixed corner endpoints (u=0/1
            // exactly, by construction); only the interior (tab) points need
            // clearance from those corners.
            for (const p of points.slice(1, -1)) {
              const u = p.x / CELL_SIZE;
              expect(u).toBeGreaterThan(0.05);
              expect(u).toBeLessThan(0.95);
            }
          }
        }
      }
    }
  });
});
