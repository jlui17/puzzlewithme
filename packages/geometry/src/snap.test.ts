import { describe, expect, it } from "vitest";
import {
  boardBounds,
  clampGroupToBoard,
  DEFAULT_SNAP_TOLERANCE,
  evaluateSnap,
  type GroupState,
} from "./index.js";

const ROWS = 3;
const COLS = 3;
const TOL = DEFAULT_SNAP_TOLERANCE;

function group(id: string, pieces: number[], x: number, y: number, locked = false): GroupState {
  return { id, pieces, position: { x, y }, locked };
}

const snap = (groups: GroupState[], id: string, x: number, y: number, tol = TOL) =>
  evaluateSnap(ROWS, COLS, groups, { groupId: id, position: { x, y } }, tol);

describe("evaluateSnap: neighbor merge", () => {
  it("merges and aligns exactly when within tolerance", () => {
    // g0 holds piece 0 at (200,200); piece 1's correct offset from 0 is (100,0).
    const groups = [group("g0", [0], 200, 200), group("g1", [1], 305, 203)];
    const out = snap(groups, "g1", 305, 203); // 5.8 units off -> snaps
    expect(out.merged).toBe(true);
    expect(out.locked).toBe(false);
    expect(out.group.pieces).toEqual([0, 1]);
    expect(out.group.position).toEqual({ x: 200, y: 200 });
    expect(out.mergedGroupIds).toEqual(["g0"]);
    expect(out.connectedPieces).toEqual([0, 1]);
    // Dropped piece 1 ends exactly at its correct offset from piece 0.
    expect(out.finalPosition).toEqual({ x: 300, y: 200 });
    expect(out.groups).toHaveLength(1);
  });

  it("does not merge just outside tolerance", () => {
    const groups = [group("g0", [0], 200, 200), group("g1", [1], 316, 200)];
    const out = snap(groups, "g1", 316, 200); // 16 units off -> no snap
    expect(out.merged).toBe(false);
    expect(out.locked).toBe(false);
    expect(out.events).toHaveLength(0);
    expect(out.finalPosition).toEqual({ x: 316, y: 200 });
    expect(out.groups).toHaveLength(2);
  });
});

describe("evaluateSnap: frame lock", () => {
  it("locks a group dropped within tolerance of its correct frame position", () => {
    const groups = [group("g4", [4], 108, 105)]; // piece 4 frame pos is (100,100)
    const out = snap(groups, "g4", 108, 105);
    expect(out.locked).toBe(true);
    expect(out.merged).toBe(false);
    expect(out.group.position).toEqual({ x: 100, y: 100 });
    expect(out.finalPosition).toEqual({ x: 100, y: 100 });
    expect(out.events).toEqual([{ type: "lock", groupIds: ["g4"], connectedPieces: [4] }]);
  });

  it("does not lock just outside tolerance", () => {
    const groups = [group("g4", [4], 120, 100)]; // 20 units off
    const out = snap(groups, "g4", 120, 100);
    expect(out.locked).toBe(false);
    expect(out.events).toHaveLength(0);
  });
});

describe("evaluateSnap: cascade merge", () => {
  it("dropping a piece between two chunks merges all three", () => {
    // g0=piece0 at (200,200), g2=piece2 at (400,200): consistent (offset 0->2 is 200).
    const groups = [group("g0", [0], 200, 200), group("g2", [2], 400, 200), group("g1", [1], 303, 202)];
    const out = snap(groups, "g1", 303, 202);
    expect(out.merged).toBe(true);
    expect(out.group.pieces).toEqual([0, 1, 2]);
    expect(out.mergedGroupIds).toEqual(["g0", "g2"]);
    expect(out.connectedPieces).toEqual([0, 1, 2]);
    expect(out.groups).toHaveLength(1);
    expect(out.events.some((e) => e.type === "merge" && e.groupIds.length === 3)).toBe(true);
  });
});

describe("evaluateSnap: frame-lock cascade with merge", () => {
  it("attaching to a locked group locks the whole result and leaves the locked pieces in place", () => {
    const locked = group("g0", [0], 0, 0, true); // piece 0 locked at its frame position
    const groups = [locked, group("g1", [1], 103, 2)]; // near piece 1's frame pos (100,0)
    const out = snap(groups, "g1", 103, 2);
    expect(out.locked).toBe(true);
    expect(out.group.pieces).toEqual([0, 1]);
    expect(out.group.position).toEqual({ x: 0, y: 0 }); // frame coords; g0 didn't move
    expect(out.connectedPieces).toEqual([0, 1]);
    expect(out.groups).toHaveLength(1);
  });
});

describe("evaluateSnap: locked groups are immovable", () => {
  it("dropping a locked group is a no-op", () => {
    const groups = [group("g0", [0], 0, 0, true), group("g8", [8], 500, 500)];
    const out = snap(groups, "g0", 300, 300);
    expect(out.merged).toBe(false);
    expect(out.events).toHaveLength(0);
    expect(out.group.position).toEqual({ x: 0, y: 0 });
    expect(out.groups).toHaveLength(2);
  });
});

describe("evaluateSnap: bounds clamp", () => {
  it("clamps a drop beyond the board edge (FR-15)", () => {
    const groups = [group("g0", [0], 0, 0)];
    const out = snap(groups, "g0", 5000, 5000);
    const bounds = boardBounds(ROWS, COLS);
    // Footprint stays inside the board.
    expect(out.finalPosition.x).toBeLessThanOrEqual(bounds.maxX);
    expect(out.finalPosition.y).toBeLessThanOrEqual(bounds.maxY);
    expect(out.merged).toBe(false);
    expect(out.group.position).toEqual(out.finalPosition);
  });

  it("clampGroupToBoard keeps a multi-piece group's footprint inside", () => {
    const clamped = clampGroupToBoard({ x: -9999, y: -9999 }, [0, 1, 2], ROWS, COLS);
    const bounds = boardBounds(ROWS, COLS);
    expect(clamped.x).toBeGreaterThanOrEqual(bounds.minX);
    expect(clamped.y).toBeGreaterThanOrEqual(bounds.minY);
  });
});

describe("evaluateSnap: determinism of output ordering", () => {
  it("produces the same outcome regardless of input group order", () => {
    const a = [group("g0", [0], 200, 200), group("g2", [2], 400, 200), group("g1", [1], 303, 202)];
    const b = [group("g1", [1], 303, 202), group("g2", [2], 400, 200), group("g0", [0], 200, 200)];
    const outA = snap(a, "g1", 303, 202);
    const outB = snap(b, "g1", 303, 202);
    expect(outA.mergedGroupIds).toEqual(outB.mergedGroupIds);
    expect(outA.connectedPieces).toEqual(outB.connectedPieces);
    expect(outA.group.pieces).toEqual(outB.group.pieces);
    expect(outA.group.position).toEqual(outB.group.position);
  });
});

describe("evaluateSnap: scoring support", () => {
  it("reports both pieces when two singletons connect", () => {
    const out = snap([group("g0", [0], 200, 200), group("g1", [1], 300, 200)], "g1", 300, 200);
    expect(out.connectedPieces).toEqual([0, 1]);
  });

  it("reports the single piece on a lone frame lock", () => {
    const out = snap([group("g4", [4], 100, 100)], "g4", 100, 100);
    expect(out.connectedPieces).toEqual([4]);
  });

  it("merging two multi-piece chunks reports all involved pieces (not just newly connected)", () => {
    // connectedPieces is a stateless "involved" report; none of these 4 pieces
    // are newly connected (both chunks were already joined), so the server must
    // diff against its credited set to apply FR-21 correctly.
    const chunkA = group("gA", [0, 3], 200, 200); // left column, rows 0-1
    const chunkB = group("gB", [1, 4], 304, 203); // middle column, near aligned
    const out = snap([chunkA, chunkB], "gB", 304, 203);
    expect(out.merged).toBe(true);
    expect(out.group.pieces).toEqual([0, 1, 3, 4]);
    expect(out.connectedPieces).toEqual([0, 1, 3, 4]);
    expect(out.mergedGroupIds).toEqual(["gA"]);
  });
});
