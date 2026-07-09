import { describe, expect, it } from "vitest";
import {
  coordToPieceId,
  edgeControlPoints,
  generatePuzzle,
  pieceOutlineControlPoints,
  pieceSvgPath,
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
