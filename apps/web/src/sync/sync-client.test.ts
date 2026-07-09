import type { RoomSettings, SnapshotMessage } from "@puzzlewithme/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { SyncEvent } from "./state";
import { SyncClient } from "./sync-client";
import { FakeClock, FakeScheduler, FakeSocket, FakeTokenStorage, fakeSocketFactory } from "./test-fakes";

const SETTINGS: RoomSettings = {
  roomId: "room1",
  imageRef: "img1",
  rows: 2,
  cols: 2,
  seed: "seed-abc",
  status: "active",
};

function snapshot(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: "snapshot",
    settings: SETTINGS,
    groups: [],
    scoreboard: { players: [], progress: { placedPieces: 0, totalPieces: 4 } },
    players: [],
    ...overrides,
  };
}

interface Harness {
  client: SyncClient;
  clock: FakeClock;
  scheduler: FakeScheduler;
  storage: FakeTokenStorage;
  sockets: FakeSocket[];
  events: SyncEvent[];
}

function makeHarness(initialToken: string | null = null): Harness {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  const storage = new FakeTokenStorage(initialToken);
  const { factory, sockets } = fakeSocketFactory();
  const client = new SyncClient({ roomId: "room1", socketFactory: factory, clock, scheduler, tokenStorage: storage });
  const events: SyncEvent[] = [];
  client.onEvent((e) => events.push(e));
  return { client, clock, scheduler, storage, sockets, events };
}

/** Drive a client from construction to fully-synced (connected). */
function connectAndSync(h: Harness, guestId = "me"): FakeSocket {
  h.client.connect();
  const socket = h.sockets.at(-1)!;
  socket.open();
  socket.receive({ type: "joined", identity: { id: guestId, name: "Me", color: "#fff", placedCount: 0 }, resumeToken: "tok-1" });
  socket.receive(snapshot());
  return socket;
}

describe("SyncClient optimistic drag", () => {
  it("leads locally then reconciles to the authoritative snap_result", () => {
    const h = makeHarness();
    const socket = connectAndSync(h);

    // Grab "0-0": optimistic hold + grab intent.
    expect(h.client.beginDrag("0-0")).toBe(true);
    expect(h.client.getState().groups.get("0-0")!.heldBy).toBe("me");
    expect(socket.sentOfType("grab")).toEqual([{ type: "grab", groupId: "0-0" }]);
    socket.receive({ type: "grab_result", groupId: "0-0", outcome: "granted" });

    // Local position leads immediately.
    h.client.dragTo(700, 800);
    expect(h.client.getState().groups.get("0-0")!.position).toEqual({ x: 700, y: 800 });

    h.client.endDrag(710, 810);
    expect(socket.sentOfType("drop")).toEqual([{ type: "drop", groupId: "0-0", x: 710, y: 810 }]);
    // Optimistic position held until the result arrives.
    expect(h.client.getState().groups.get("0-0")!.position).toEqual({ x: 710, y: 810 });

    // Authoritative result corrects position and applies a merge verbatim.
    socket.receive({
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
      scoreCredits: [{ guestId: "me", piecesCredited: 2 }],
      progress: { placedPieces: 2, totalPieces: 4 },
    });

    const group = h.client.getState().groups.get("0-0")!;
    expect(group.position).toEqual({ x: 0, y: 0 });
    expect(group.pieces).toHaveLength(2);
    expect(group.heldBy).toBeNull();
    expect(h.client.getState().groups.has("0-1")).toBe(false);
  });

  it("rolls back the optimistic hold when the grab is rejected (held_by)", () => {
    const h = makeHarness();
    const socket = connectAndSync(h);
    const original = { ...h.client.getState().groups.get("1-0")!.position };

    h.client.beginDrag("1-0");
    h.client.dragTo(900, 900); // move optimistically before rejection
    expect(h.client.getState().groups.get("1-0")!.heldBy).toBe("me");

    socket.receive({ type: "grab_result", groupId: "1-0", outcome: "held_by", holderName: "Zoe" });

    const group = h.client.getState().groups.get("1-0")!;
    expect(group.heldBy).toBeNull();
    expect(group.position).toEqual(original); // rolled back to pre-grab position
    expect(h.events).toContainEqual({ type: "grab_rejected", groupId: "1-0", holderName: "Zoe" });
  });

  it("ignores its own held echo mid-drag, leaving optimistic position untouched", () => {
    const h = makeHarness();
    const socket = connectAndSync(h);

    h.client.beginDrag("0-0");
    socket.receive({ type: "grab_result", groupId: "0-0", outcome: "granted" });
    h.client.dragTo(700, 800);

    // Room-wide attribution echo of our own grab, e.g. arriving after our
    // local move: must not clobber the optimistic position or hold.
    socket.receive({ type: "held", groupId: "0-0", playerId: "me" });

    const group = h.client.getState().groups.get("0-0")!;
    expect(group.heldBy).toBe("me");
    expect(group.position).toEqual({ x: 700, y: 800 });
  });

  it("ignores a released message targeting its own active drag", () => {
    const h = makeHarness();
    const socket = connectAndSync(h);

    h.client.beginDrag("0-0");
    socket.receive({ type: "grab_result", groupId: "0-0", outcome: "granted" });
    h.client.dragTo(700, 800);

    // A stray released for the group we're actively dragging must not jump
    // it to a stale rest position; our own drag lifecycle owns this group.
    socket.receive({ type: "released", groupId: "0-0", x: 1, y: 1 });

    const group = h.client.getState().groups.get("0-0")!;
    expect(group.heldBy).toBe("me");
    expect(group.position).toEqual({ x: 700, y: 800 });
  });

  it("applies a remote held/released pair for a group it isn't dragging", () => {
    const h = makeHarness();
    const socket = connectAndSync(h);

    socket.receive({ type: "held", groupId: "1-1", playerId: "guest-2" });
    expect(h.client.getState().groups.get("1-1")!.heldBy).toBe("guest-2");

    socket.receive({ type: "released", groupId: "1-1", x: 55, y: 66 });
    const group = h.client.getState().groups.get("1-1")!;
    expect(group.heldBy).toBeNull();
    expect(group.position).toEqual({ x: 55, y: 66 });
  });
});

describe("SyncClient errors", () => {
  it("surfaces room_completed through the event channel", () => {
    const h = makeHarness();
    connectAndSync(h);
    const socket = h.sockets.at(-1)!;

    socket.receive({ type: "error", code: "room_completed", message: "room is complete" });

    expect(h.events).toContainEqual({ type: "error", code: "room_completed", message: "room is complete" });
  });
});

describe("SyncClient throttle (fake time)", () => {
  it("emits one move per 30 Hz window regardless of dragTo call count", () => {
    const h = makeHarness();
    const socket = connectAndSync(h);
    h.client.beginDrag("0-0");
    socket.receive({ type: "grab_result", groupId: "0-0", outcome: "granted" });

    // Many calls inside one ~33ms window => a single relayed move.
    for (let i = 0; i < 10; i++) {
      h.clock.advance(1);
      h.client.dragTo(i, i);
    }
    expect(socket.sentOfType("move")).toHaveLength(1);

    // Cross the window boundary => one more move.
    h.clock.advance(40);
    h.client.dragTo(99, 99);
    expect(socket.sentOfType("move")).toHaveLength(2);
  });

  it("emits one cursor per 15 Hz window", () => {
    const h = makeHarness();
    const socket = connectAndSync(h);

    for (let i = 0; i < 10; i++) {
      h.clock.advance(1);
      h.client.moveCursor(i, i);
    }
    expect(socket.sentOfType("cursor")).toHaveLength(1);

    h.clock.advance(100);
    h.client.moveCursor(5, 5);
    expect(socket.sentOfType("cursor")).toHaveLength(2);
  });
});

describe("SyncClient reconnect", () => {
  it("replaces state on the second snapshot and replays the resume token", () => {
    const h = makeHarness();
    const socket1 = connectAndSync(h);
    expect(h.client.getState().connection).toBe("connected");

    // Server issued a token on join; it was persisted.
    expect(h.storage.saved).toBe("tok-1");

    // Move a piece so first-snapshot state is non-trivial, then lose the socket.
    socket1.receive({ type: "group_moved", groupId: "1-1", x: 123, y: 456 });
    expect(h.client.getState().groups.get("1-1")!.position).toEqual({ x: 123, y: 456 });

    socket1.drop();
    expect(h.client.getState().connection).toBe("reconnecting");
    expect(h.scheduler.pending).toBe(1);

    // Backoff fires -> a fresh socket connects and rejoins with the stored token.
    h.scheduler.runNext();
    const socket2 = h.sockets.at(-1)!;
    expect(socket2).not.toBe(socket1);
    socket2.open();
    const join = socket2.sentOfType("join")[0]!;
    expect(join["resumeToken"]).toBe("tok-1");

    // Second snapshot replaces the board: no duplicate groups, motion reset.
    socket2.receive({ type: "joined", identity: { id: "me", name: "Me", color: "#fff", placedCount: 0 }, resumeToken: "tok-2" });
    socket2.receive(snapshot());
    const state = h.client.getState();
    expect(state.connection).toBe("connected");
    expect(state.groups.size).toBe(4);
    // "1-1" is back at its seeded scatter position, not the pre-drop deviation.
    expect(state.groups.get("1-1")!.position).not.toEqual({ x: 123, y: 456 });
  });

  it("fails an in-flight drag gracefully on disconnect, releasing on resync", () => {
    const h = makeHarness();
    const socket1 = connectAndSync(h);
    h.client.beginDrag("0-0");
    socket1.receive({ type: "grab_result", groupId: "0-0", outcome: "granted" });
    h.client.dragTo(700, 700);

    socket1.drop();
    // Reconnect and resync.
    h.scheduler.runNext();
    const socket2 = h.sockets.at(-1)!;
    socket2.open();
    socket2.receive({ type: "joined", identity: { id: "me", name: "Me", color: "#fff", placedCount: 0 }, resumeToken: "t" });
    socket2.receive(snapshot());

    // Optimistic hold is gone; a subsequent drop attempt does nothing.
    expect(h.client.getState().groups.get("0-0")!.heldBy).toBeNull();
    const dropsBefore = socket2.sentOfType("drop").length;
    h.client.endDrag(1, 1);
    expect(socket2.sentOfType("drop")).toHaveLength(dropsBefore);
  });

  it("stops reconnecting and closes on room_full", () => {
    const h = makeHarness();
    h.client.connect();
    const socket = h.sockets.at(-1)!;
    socket.open();
    socket.receive({ type: "room_full" });

    expect(h.client.getState().connection).toBe("room_full");
    expect(h.events).toContainEqual({ type: "room_full" });
    expect(h.scheduler.pending).toBe(0);
  });
});
