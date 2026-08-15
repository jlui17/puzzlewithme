import type { ServerMessage } from "@puzzlewithme/shared";
import { describe, expect, it } from "vitest";
import { reconcile, type DragState } from "./reconcile";

const LOCAL = "guest-local";
const OTHER = "guest-other";

function drag(groupId = "g1", phase: DragState["phase"] = "granted"): DragState {
  return { groupId, originalPosition: { x: 10, y: 20 }, phase };
}

describe("reconcile: drag arbitration matrix", () => {
  // Each row: message × drag state → which store ops apply and what the drag becomes.
  const rows: Array<{
    name: string;
    msg: ServerMessage;
    drag: DragState | null;
    wantOps: string[];
    wantDrag: "kept" | "cleared" | "granted";
  }> = [
    {
      name: "group_moved for the dragged group is dropped (local drag leads)",
      msg: { type: "group_moved", groupId: "g1", x: 5, y: 5 },
      drag: drag("g1"),
      wantOps: [],
      wantDrag: "kept",
    },
    {
      name: "group_moved for another group applies",
      msg: { type: "group_moved", groupId: "g2", x: 5, y: 5 },
      drag: drag("g1"),
      wantOps: ["applyGroupMoved"],
      wantDrag: "kept",
    },
    {
      name: "group_moved with no drag applies",
      msg: { type: "group_moved", groupId: "g1", x: 5, y: 5 },
      drag: null,
      wantOps: ["applyGroupMoved"],
      wantDrag: "kept",
    },
    {
      name: "own held echo for the dragged group is dropped",
      msg: { type: "held", groupId: "g1", playerId: LOCAL },
      drag: drag("g1"),
      wantOps: [],
      wantDrag: "kept",
    },
    {
      name: "held by someone else applies even mid-drag (server won the race)",
      msg: { type: "held", groupId: "g1", playerId: OTHER },
      drag: drag("g1"),
      wantOps: ["applyGroupHeld"],
      wantDrag: "kept",
    },
    {
      name: "held for another group applies",
      msg: { type: "held", groupId: "g2", playerId: OTHER },
      drag: drag("g1"),
      wantOps: ["applyGroupHeld"],
      wantDrag: "kept",
    },
    {
      name: "released targeting the active drag is dropped (would yank the group mid-drag)",
      msg: { type: "released", groupId: "g1", x: 0, y: 0 },
      drag: drag("g1"),
      wantOps: [],
      wantDrag: "kept",
    },
    {
      name: "released for another group applies",
      msg: { type: "released", groupId: "g2", x: 0, y: 0 },
      drag: drag("g1"),
      wantOps: ["applyGroupReleased"],
      wantDrag: "kept",
    },
    {
      name: "snap_result for the dropped group applies and ends the drag",
      msg: {
        type: "snap_result",
        droppedGroupId: "g1",
        group: { id: "g1", pieces: [{ row: 0, col: 0 }], position: { x: 0, y: 0 }, lockedToFrame: false },
        mergedGroupIds: [],
        scoreCredits: [],
        progress: { placedPieces: 0, totalPieces: 4 },
      },
      drag: drag("g1"),
      wantOps: ["applySnapResult"],
      wantDrag: "cleared",
    },
    {
      name: "snap_result for another group's drop applies and keeps the drag",
      msg: {
        type: "snap_result",
        droppedGroupId: "g2",
        group: { id: "g2", pieces: [{ row: 0, col: 1 }], position: { x: 0, y: 0 }, lockedToFrame: false },
        mergedGroupIds: [],
        scoreCredits: [],
        progress: { placedPieces: 0, totalPieces: 4 },
      },
      drag: drag("g1"),
      wantOps: ["applySnapResult"],
      wantDrag: "kept",
    },
    {
      name: "grab granted promotes a pending drag",
      msg: { type: "grab_result", groupId: "g1", outcome: "granted" },
      drag: drag("g1", "pending"),
      wantOps: [],
      wantDrag: "granted",
    },
    {
      name: "grab granted for a stale group leaves the current drag alone",
      msg: { type: "grab_result", groupId: "g2", outcome: "granted" },
      drag: drag("g1", "pending"),
      wantOps: [],
      wantDrag: "kept",
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const result = reconcile(row.msg, row.drag, LOCAL);
      expect(result.store.map((op) => op.op)).toEqual(row.wantOps);
      if (row.wantDrag === "cleared") expect(result.drag).toBeNull();
      else if (row.wantDrag === "granted") expect(result.drag).toEqual({ ...row.drag, phase: "granted" });
      else expect(result.drag).toEqual(row.drag);
    });
  }
});

describe("reconcile: rejection and lifecycle", () => {
  it("grab held_by rolls back the matching drag to its original position and emits", () => {
    const d = drag("g1", "pending");
    const result = reconcile(
      { type: "grab_result", groupId: "g1", outcome: "held_by", holderName: "Ada" },
      d,
      LOCAL,
    );
    expect(result.store).toEqual([{ op: "rollbackGrab", groupId: "g1", originalPosition: { x: 10, y: 20 } }]);
    expect(result.drag).toBeNull();
    expect(result.emit).toEqual([{ type: "grab_rejected", groupId: "g1", holderName: "Ada" }]);
  });

  it("grab held_by for a non-dragged group emits without touching the store or drag", () => {
    const d = drag("g1");
    const result = reconcile(
      { type: "grab_result", groupId: "g2", outcome: "held_by", holderName: "Ada" },
      d,
      LOCAL,
    );
    expect(result.store).toEqual([]);
    expect(result.drag).toBe(d);
    expect(result.emit).toEqual([{ type: "grab_rejected", groupId: "g2", holderName: "Ada" }]);
  });

  it("snapshot replaces the board, marks connected, and fails the drag into it", () => {
    const result = reconcile(
      {
        type: "snapshot",
        settings: {} as never,
        groups: [],
        players: [],
        scoreboard: { players: [], progress: { placedPieces: 0, totalPieces: 4 } },
      } as never,
      drag("g1"),
      LOCAL,
    );
    expect(result.store.map((op) => op.op)).toEqual(["applySnapshot", "setConnection"]);
    expect(result.drag).toBeNull();
  });

  it("room_full sets the terminal connection status and emits", () => {
    const result = reconcile({ type: "room_full" }, null, null);
    expect(result.store).toEqual([{ op: "setConnection", status: "room_full" }]);
    expect(result.emit).toEqual([{ type: "room_full" }]);
  });
});
