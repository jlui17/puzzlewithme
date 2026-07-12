import { initialScatter, pieceIdToCoord } from "@puzzlewithme/geometry";
import {
  singletonGroupId,
  type CompletionMessage,
  type GuestIdentity,
  type PresenceMessage,
  type RoomSettings,
  type SnapResultMessage,
  type SnapshotMessage,
} from "@puzzlewithme/shared";
import { describe, expect, it } from "vitest";
import { BoardStore } from "./board-store";
import { FakeClock } from "./test-fakes";

const SETTINGS: RoomSettings = {
  roomId: "room1",
  imageRef: "img1",
  rows: 2,
  cols: 2,
  seed: "seed-abc",
  status: "active",
};

// 2x2 = 4 pieces; singleton ids are "row-col".
function emptySnapshot(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: "snapshot",
    settings: SETTINGS,
    groups: [],
    scoreboard: { players: [], progress: { placedPieces: 0, totalPieces: 4 } },
    players: [],
    ...overrides,
  };
}

function makeStore(): BoardStore {
  return new BoardStore(new FakeClock());
}

describe("BoardStore snapshot", () => {
  it("derives untouched groups at the seeded scatter positions", () => {
    const store = makeStore();
    store.applySnapshot(emptySnapshot());
    const state = store.getState();

    expect(state.groups.size).toBe(4);
    const scatter = initialScatter(SETTINGS.rows, SETTINGS.cols, SETTINGS.seed);
    for (let id = 0; id < scatter.length; id++) {
      const { row, col } = pieceIdToCoord(id, SETTINGS.cols);
      // Ids come from the shared singletonGroupId helper (single source of
      // truth with the server), not a locally re-derived "row-col" string.
      const group = state.groups.get(singletonGroupId(row, col))!;
      expect(group.position).toEqual({ x: scatter[id]!.x, y: scatter[id]!.y });
      expect(group.pieces).toEqual([{ row, col }]);
      expect(group.locked).toBe(false);
      expect(group.heldBy).toBeNull();
    }
  });

  it("overlays deviation groups, removing the singletons they absorb", () => {
    const store = makeStore();
    store.applySnapshot(
      emptySnapshot({
        groups: [
          {
            id: "chunk-A",
            pieces: [
              { row: 0, col: 0 },
              { row: 0, col: 1 },
            ],
            position: { x: 500, y: 600 },
            lockedToFrame: false,
            heldBy: "guest-2",
          },
        ],
      }),
    );
    const state = store.getState();

    // Two singletons folded into one deviation group => 3 groups total.
    expect(state.groups.size).toBe(3);
    expect(state.groups.has("0-0")).toBe(false);
    expect(state.groups.has("0-1")).toBe(false);
    expect(state.groups.has("1-0")).toBe(true);
    expect(state.groups.has("1-1")).toBe(true);
    const chunk = state.groups.get("chunk-A")!;
    expect(chunk.position).toEqual({ x: 500, y: 600 });
    expect(chunk.heldBy).toBe("guest-2");
  });

  it("applies a group_moved event and records a motion sample for interpolation", () => {
    const clock = new FakeClock();
    const store = new BoardStore(clock);
    store.applySnapshot(emptySnapshot());

    clock.advance(1000);
    store.applyGroupMoved({ type: "group_moved", groupId: "1-1", x: 42, y: 43 });
    clock.advance(33);
    store.applyGroupMoved({ type: "group_moved", groupId: "1-1", x: 50, y: 55 });

    const group = store.getState().groups.get("1-1")!;
    expect(group.position).toEqual({ x: 50, y: 55 });
    const motion = store.getState().motion.get("1-1")!;
    expect(motion.current).toEqual({ position: { x: 50, y: 55 }, timestamp: 1033 });
    expect(motion.previous).toEqual({ position: { x: 42, y: 43 }, timestamp: 1000 });
  });

  it("attributes a held group to its remote holder", () => {
    const store = makeStore();
    store.applySnapshot(emptySnapshot());

    store.applyGroupHeld({ type: "held", groupId: "0-1", playerId: "guest-2" });

    expect(store.getState().groups.get("0-1")!.heldBy).toBe("guest-2");
  });

  it("applies a cursor ping and records a motion sample for interpolation", () => {
    const clock = new FakeClock();
    const store = new BoardStore(clock);
    store.applySnapshot(emptySnapshot());
    store.setLocalIdentity("me");

    clock.advance(1000);
    store.applyCursor({ type: "cursor", guestId: "guest-2", x: 10, y: 20 });
    clock.advance(100);
    store.applyCursor({ type: "cursor", guestId: "guest-2", x: 30, y: 40 });

    expect(store.getState().cursors.get("guest-2")).toEqual({ guestId: "guest-2", x: 30, y: 40 });
    const motion = store.getState().cursorMotion.get("guest-2")!;
    expect(motion.current).toEqual({ position: { x: 30, y: 40 }, timestamp: 1100 });
    expect(motion.previous).toEqual({ position: { x: 10, y: 20 }, timestamp: 1000 });

    // Our own echo never produces a remote cursor or a sample.
    store.applyCursor({ type: "cursor", guestId: "me", x: 1, y: 1 });
    expect(store.getState().cursors.has("me")).toBe(false);
    expect(store.getState().cursorMotion.has("me")).toBe(false);
  });

  it("drops cursor motion when the player leaves and on resync", () => {
    const store = makeStore();
    store.applySnapshot(emptySnapshot());
    store.applyCursor({ type: "cursor", guestId: "guest-2", x: 10, y: 20 });
    expect(store.getState().cursorMotion.has("guest-2")).toBe(true);

    store.applyPresence({ type: "presence", event: "left", guestId: "guest-2" });
    expect(store.getState().cursors.has("guest-2")).toBe(false);
    expect(store.getState().cursorMotion.has("guest-2")).toBe(false);

    // Ephemeral across snapshots too: a reconnect gap must not leave a stale
    // sample pulling interpolation toward a pre-disconnect position.
    store.applyCursor({ type: "cursor", guestId: "guest-3", x: 1, y: 2 });
    store.applySnapshot(emptySnapshot());
    expect(store.getState().cursorMotion.size).toBe(0);
  });

  it("converges a released group to its carried rest position, clears the holder and any motion sample", () => {
    const clock = new FakeClock();
    const store = new BoardStore(clock);
    store.applySnapshot(emptySnapshot());
    store.applyGroupHeld({ type: "held", groupId: "1-0", playerId: "guest-2" });
    store.applyGroupMoved({ type: "group_moved", groupId: "1-0", x: 10, y: 10 });
    expect(store.getState().motion.has("1-0")).toBe(true);

    store.applyGroupReleased({ type: "released", groupId: "1-0", x: 321, y: 654 });

    const group = store.getState().groups.get("1-0")!;
    expect(group.heldBy).toBeNull();
    expect(group.position).toEqual({ x: 321, y: 654 });
    // The group's active-motion phase ended with the release; a stale sample
    // would otherwise pull renderer interpolation toward the old target.
    expect(store.getState().motion.has("1-0")).toBe(false);
  });
});

describe("BoardStore snap_result", () => {
  it("applies position and merge exactly from the payload, without re-derivation", () => {
    const store = makeStore();
    store.applySnapshot(emptySnapshot());

    const snap: SnapResultMessage = {
      type: "snap_result",
      droppedGroupId: "0-0",
      group: {
        id: "0-0",
        pieces: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
        ],
        position: { x: 0, y: 0 },
        lockedToFrame: false,
      },
      mergedGroupIds: ["0-1"],
      scoreCredits: [{ guestId: "guest-1", piecesCredited: 2 }],
      progress: { placedPieces: 2, totalPieces: 4 },
    };
    store.applySnapResult(snap);
    const state = store.getState();

    // "0-1" absorbed; "0-0" now the 2-piece group at the payload position.
    expect(state.groups.has("0-1")).toBe(false);
    const merged = state.groups.get("0-0")!;
    expect(merged.pieces).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
    ]);
    expect(merged.position).toEqual({ x: 0, y: 0 });
    expect(merged.heldBy).toBeNull();
    expect(state.scoreboard.progress).toEqual({ placedPieces: 2, totalPieces: 4 });
  });

  it("removes the pre-drop group id when the merge produced a new id", () => {
    const store = makeStore();
    store.applySnapshot(emptySnapshot());

    store.applySnapResult({
      type: "snap_result",
      droppedGroupId: "0-0",
      group: {
        id: "merged-xyz",
        pieces: [
          { row: 0, col: 0 },
          { row: 1, col: 0 },
        ],
        position: { x: 10, y: 20 },
        lockedToFrame: true,
      },
      mergedGroupIds: ["1-0"],
      scoreCredits: [],
      progress: { placedPieces: 2, totalPieces: 4 },
    });
    const state = store.getState();

    expect(state.groups.has("0-0")).toBe(false);
    expect(state.groups.has("1-0")).toBe(false);
    expect(state.groups.get("merged-xyz")!.locked).toBe(true);
  });
});

describe("BoardStore presence, scores, completion", () => {
  const alice: GuestIdentity = { id: "guest-1", name: "Alice", color: "#f00", placedCount: 0 };
  const bob: GuestIdentity = { id: "guest-2", name: "Bob", color: "#0f0", placedCount: 3 };

  it("tracks joins, renames, and leaves", () => {
    const store = makeStore();
    store.applySnapshot(emptySnapshot({ players: [alice] }));

    store.applyPresence({ type: "presence", event: "joined", player: bob });
    expect(store.getState().players.get("guest-2")!.name).toBe("Bob");

    store.applyPresence({ type: "presence", event: "renamed", guestId: "guest-1", name: "Alicia" });
    expect(store.getState().players.get("guest-1")!.name).toBe("Alicia");

    const left: PresenceMessage = { type: "presence", event: "left", guestId: "guest-2" };
    store.applyPresence(left);
    expect(store.getState().players.has("guest-2")).toBe(false);
  });

  it("credits scores on snap_result into both the player and the scoreboard", () => {
    const store = makeStore();
    store.applySnapshot(
      emptySnapshot({
        players: [alice],
        scoreboard: { players: [{ guestId: "guest-1", placedCount: 0 }], progress: { placedPieces: 0, totalPieces: 4 } },
      }),
    );

    store.applySnapResult({
      type: "snap_result",
      droppedGroupId: "0-0",
      group: { id: "0-0", pieces: [{ row: 0, col: 0 }], position: { x: 0, y: 0 }, lockedToFrame: true },
      mergedGroupIds: [],
      scoreCredits: [{ guestId: "guest-1", piecesCredited: 1 }],
      progress: { placedPieces: 1, totalPieces: 4 },
    });
    const state = store.getState();

    expect(state.players.get("guest-1")!.placedCount).toBe(1);
    expect(state.scoreboard.players.find((p) => p.guestId === "guest-1")!.placedCount).toBe(1);
  });

  it("marks the room completed and records final stats", () => {
    const store = makeStore();
    store.applySnapshot(emptySnapshot());

    const completion: CompletionMessage = {
      type: "completion",
      scoreboard: { players: [{ guestId: "guest-1", placedCount: 4 }], progress: { placedPieces: 4, totalPieces: 4 } },
      totalActiveSolvingTimeMs: 123_456,
    };
    store.applyCompletion(completion);
    const state = store.getState();

    expect(state.status).toBe("completed");
    expect(state.completion).toEqual({ totalActiveSolvingTimeMs: 123_456 });
    expect(state.scoreboard.progress.placedPieces).toBe(4);
  });
});
