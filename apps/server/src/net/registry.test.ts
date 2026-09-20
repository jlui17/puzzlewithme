import type { RoomSettings, ServerMessage } from "@puzzlewithme/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_TIMEOUT_MS } from "../engine/constants.js";
import { InMemoryRoomStore } from "../store/room-store.js";
import { RoomRegistry, type RoomConnection, type RoomSession } from "./registry.js";

/**
 * Fan-out policy through the RoomSession seam, with fake connections instead
 * of sockets: who hears about each intent, what persists, what only the
 * sender sees. The socket suite (ws-integration.test.ts) keeps the transport
 * lifecycle — handshake, resume, reconnect convergence, keepalive, eviction.
 */

const BASE_SETTINGS: Omit<RoomSettings, "roomId"> = {
  imageRef: "img",
  rows: 2,
  cols: 2,
  seed: "seed-1",
  status: "active",
};

class FakeConnection implements RoomConnection {
  readonly messages: ServerMessage[] = [];
  send(message: ServerMessage): void {
    this.messages.push(message);
  }
  ofType<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

let store: InMemoryRoomStore;
let registry: RoomRegistry;
let clock: number;
const ROOM = "room-1";

interface Joined {
  conn: FakeConnection;
  session: RoomSession;
  playerId: string;
  name: string;
}

async function joinRoom(roomId: string, userId: string | null = null): Promise<Joined> {
  const conn = new FakeConnection();
  const outcome = await registry.join(conn, roomId, null, userId);
  if (!outcome.ok) throw new Error(`join failed: ${outcome.reason}`);
  const joined = conn.ofType("joined")[0]!;
  return { conn, session: outcome.session, playerId: outcome.session.playerId, name: joined.identity.name };
}

/** Let a fire-and-forget store write (display name) settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  clock = 1_000;
  store = new InMemoryRoomStore();
  registry = new RoomRegistry({
    store,
    now: () => clock,
    // Large intervals so the debounce and sweep never fire on their own; the
    // sweep case triggers it explicitly via runIdleSweep.
    checkpointIntervalMs: 3_600_000,
    sweepIntervalMs: 3_600_000,
  });
  await store.create({ roomId: ROOM, ...BASE_SETTINGS });
});

afterEach(async () => {
  await registry.shutdown();
});

describe("room fan-out policy", () => {
  it("grab granted: `held` to everyone, `grab_result granted` to the grabber only", async () => {
    const a = await joinRoom(ROOM);
    const b = await joinRoom(ROOM);

    await a.session.apply({ type: "grab", groupId: "0-0" });

    expect(a.conn.ofType("held")).toMatchObject([{ groupId: "0-0", playerId: a.playerId }]);
    expect(b.conn.ofType("held")).toMatchObject([{ groupId: "0-0", playerId: a.playerId }]);
    expect(a.conn.ofType("grab_result")).toMatchObject([{ groupId: "0-0", outcome: "granted" }]);
    expect(b.conn.ofType("grab_result")).toEqual([]);
  });

  it("reports held_by with the holder's name on a conflicting grab", async () => {
    const a = await joinRoom(ROOM);
    const b = await joinRoom(ROOM);

    await a.session.apply({ type: "grab", groupId: "0-0" });
    await b.session.apply({ type: "grab", groupId: "0-0" });

    expect(b.conn.ofType("grab_result")).toMatchObject([
      { groupId: "0-0", outcome: "held_by", holderName: a.name },
    ]);
  });

  it("relays a move to everyone but the mover", async () => {
    const a = await joinRoom(ROOM);
    const b = await joinRoom(ROOM);

    await a.session.apply({ type: "grab", groupId: "0-0" });
    await a.session.apply({ type: "move", groupId: "0-0", x: 7, y: 9 });

    expect(a.conn.ofType("group_moved")).toEqual([]);
    expect(b.conn.ofType("group_moved")).toMatchObject([{ groupId: "0-0", x: 7, y: 9 }]);
  });

  it("releases a held group and drops presence when the holder leaves", async () => {
    const a = await joinRoom(ROOM);
    const b = await joinRoom(ROOM);

    await a.session.apply({ type: "grab", groupId: "0-0" });
    a.session.leave();

    expect(b.conn.ofType("released")).toMatchObject([{ groupId: "0-0" }]);
    // b joined last, so a's join was never broadcast to it; `left` is its
    // first presence message.
    expect(b.conn.ofType("presence")).toMatchObject([{ event: "left", guestId: a.playerId }]);
  });

  it("records session-history participation (createdByUser false) on join", async () => {
    await joinRoom(ROOM, "user-J");
    const rooms = await store.listUserRooms("user-J");
    expect(rooms).toEqual([
      expect.objectContaining({ roomId: ROOM, createdByUser: false, status: "active" }),
    ]);
  });

  it("a rename persists as the user's app-wide display name and follows them into another room", async () => {
    const a = await joinRoom(ROOM, "user-N");
    const b = await joinRoom(ROOM);

    await a.session.apply({ type: "rename", name: "Justin2" });
    await tick();

    expect(a.conn.ofType("presence").some((m) => m.event === "renamed")).toBe(false);
    expect(b.conn.ofType("presence")).toMatchObject([
      { event: "renamed", guestId: a.playerId, name: "Justin2" },
    ]);
    expect(await store.getUserDisplayName("user-N")).toBe("Justin2");

    // A brand-new room: the minted identity starts as the display name, not a
    // generated one.
    await store.create({ roomId: "room-2", ...BASE_SETTINGS });
    const elsewhere = await joinRoom("room-2", "user-N");
    expect(elsewhere.name).toBe("Justin2");
  });

  it("broadcasts completion after persisting it, then rejects further mutations", async () => {
    const a = await joinRoom(ROOM);
    for (const [groupId, x, y] of [
      ["0-0", 0, 0],
      ["0-1", 100, 0],
      ["1-0", 0, 100],
      ["1-1", 100, 100],
    ] as const) {
      await a.session.apply({ type: "grab", groupId });
      await a.session.apply({ type: "drop", groupId, x, y });
    }

    const completion = a.conn.ofType("completion");
    expect(completion).toMatchObject([
      { scoreboard: { progress: { placedPieces: 4, totalPieces: 4 } } },
    ]);
    // apply() resolves only after the completing drop's immediate save, so the
    // store already shows the terminal status (persist-before-announce, §7.6).
    const persisted = await store.load(ROOM);
    expect(persisted?.settings.status).toBe("completed");

    await a.session.apply({ type: "grab", groupId: "0-0" });
    expect(a.conn.ofType("error")).toMatchObject([{ code: "room_completed" }]);
  });

  it("releases idle holds on the periodic sweep (§9 AFK)", async () => {
    const a = await joinRoom(ROOM);
    const b = await joinRoom(ROOM);

    await a.session.apply({ type: "grab", groupId: "0-0" });
    clock += HOLD_TIMEOUT_MS;
    registry.runIdleSweep();

    expect(b.conn.ofType("released")).toMatchObject([{ groupId: "0-0" }]);
  });
});

it("still joins and records participation after a transient membership failure", async () => {
  const write = vi.spyOn(store, "recordMembership").mockRejectedValueOnce(new Error("busy"));
  vi.useFakeTimers();
  try {
    const joining = joinRoom(ROOM, "retry-user");
    await vi.advanceTimersByTimeAsync(100);
    const joined = await joining;
    expect(joined.conn.ofType("joined")).toHaveLength(1);
    expect(await store.listUserRooms("retry-user")).toEqual([
      expect.objectContaining({ roomId: ROOM, createdByUser: false }),
    ]);
    expect(write).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    write.mockRestore();
  }
});
