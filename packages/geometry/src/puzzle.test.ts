import { describe, expect, it } from "vitest";
import {
  coordToPieceId,
  framePosition,
  generatePuzzle,
  neighborsOf,
  pieceIdToCoord,
  CELL_SIZE,
} from "./index.js";

const ROWS = 4;
const COLS = 5;
const puzzle = generatePuzzle(ROWS, COLS, "puzzle-test");
const at = (row: number, col: number) => puzzle.pieces[coordToPieceId(row, col, COLS)]!;

describe("generatePuzzle structure", () => {
  it("produces rows*cols pieces indexed by id", () => {
    expect(puzzle.pieces).toHaveLength(ROWS * COLS);
    puzzle.pieces.forEach((p, i) => expect(p.id).toBe(i));
  });

  it("assigns correct frame positions", () => {
    expect(at(2, 3).framePosition).toEqual({ x: 3 * CELL_SIZE, y: 2 * CELL_SIZE });
    expect(framePosition(coordToPieceId(2, 3, COLS), COLS)).toEqual({ x: 300, y: 200 });
  });

  it("round-trips id <-> coord", () => {
    expect(pieceIdToCoord(coordToPieceId(3, 4, COLS), COLS)).toEqual({ row: 3, col: 4 });
  });
});

describe("edges: complementarity", () => {
  it("shared vertical edges are the identical curve with opposite kinds", () => {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS - 1; c++) {
        const left = at(r, c);
        const right = at(r, c + 1);
        expect(left.edges.right.points).toStrictEqual(right.edges.left.points);
        expect(left.edges.right.kind).not.toBe(right.edges.left.kind);
        expect(["tab", "blank"]).toContain(left.edges.right.kind);
      }
    }
  });

  it("shared horizontal edges are the identical curve with opposite kinds", () => {
    for (let r = 0; r < ROWS - 1; r++) {
      for (let c = 0; c < COLS; c++) {
        const top = at(r, c);
        const bottom = at(r + 1, c);
        expect(top.edges.bottom.points).toStrictEqual(bottom.edges.top.points);
        expect(top.edges.bottom.kind).not.toBe(bottom.edges.top.kind);
      }
    }
  });
});

describe("edges: borders and corners are flat", () => {
  it("top row is flat on top, bottom row flat on bottom", () => {
    for (let c = 0; c < COLS; c++) {
      expect(at(0, c).edges.top.kind).toBe("flat");
      expect(at(ROWS - 1, c).edges.bottom.kind).toBe("flat");
    }
  });

  it("left column flat on left, right column flat on right", () => {
    for (let r = 0; r < ROWS; r++) {
      expect(at(r, 0).edges.left.kind).toBe("flat");
      expect(at(r, COLS - 1).edges.right.kind).toBe("flat");
    }
  });

  it("corners are flat on exactly their two outer sides", () => {
    const tl = at(0, 0);
    expect([tl.edges.top.kind, tl.edges.left.kind]).toEqual(["flat", "flat"]);
    expect([tl.edges.right.kind, tl.edges.bottom.kind]).not.toContain("flat");

    const br = at(ROWS - 1, COLS - 1);
    expect([br.edges.bottom.kind, br.edges.right.kind]).toEqual(["flat", "flat"]);
    expect([br.edges.top.kind, br.edges.left.kind]).not.toContain("flat");
  });

  it("interior pieces have no flat edges", () => {
    const mid = at(1, 2);
    for (const side of ["top", "right", "bottom", "left"] as const) {
      expect(mid.edges[side].kind).not.toBe("flat");
    }
  });
});

describe("neighbors", () => {
  it("interior piece has all four neighbors", () => {
    expect(neighborsOf(at(1, 2))).toEqual({
      top: coordToPieceId(0, 2, COLS),
      right: coordToPieceId(1, 3, COLS),
      bottom: coordToPieceId(2, 2, COLS),
      left: coordToPieceId(1, 1, COLS),
    });
  });

  it("corner piece has exactly two neighbors", () => {
    expect(neighborsOf(at(0, 0))).toEqual({
      top: null,
      left: null,
      right: coordToPieceId(0, 1, COLS),
      bottom: coordToPieceId(1, 0, COLS),
    });
  });

  it("edge (non-corner) piece has three neighbors", () => {
    const n = neighborsOf(at(0, 2));
    expect(n.top).toBeNull();
    expect(n.left).not.toBeNull();
    expect(n.right).not.toBeNull();
    expect(n.bottom).not.toBeNull();
  });
});
