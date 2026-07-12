import type { AddressInfo } from "node:net";
import type { RoomSettings, ServerMessage } from "@puzzlewithme/shared";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageStore } from "../images/image-store.js";
import { InMemoryRoomStore } from "../store/room-store.js";
import { HOLD_TIMEOUT_MS } from "../engine/constants.js";
import { createGameServer, type GameServer } from "./server.js";

// Images are never touched over the WS path; a no-op store satisfies the wiring.
const stubImageStore: ImageStore = {
  async put() {},
  async get() {
    return null;
  },
};

const BASE_SETTINGS: Omit<RoomSettings, "roomId"> = {
  imageRef: "img",
  rows: 2,
  cols: 2,
  seed: "seed-1",
  status: "active",
};

/**
 * A real `ws` client that buffers every ServerMessage it receives. `waitFor`
 * consumes the first unconsumed match (so sequential awaits don't re-match one
 * message); `all` exposes the full unconsumed-agnostic history for event-folding.
 */
class TestClient {
  readonly ws: WebSocket;
  private readonly records: { msg: ServerMessage; consumed: boolean }[] = [];
  private readonly waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  private readonly openPromise: Promise<void>;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as ServerMessage;
      this.records.push({ msg, consumed: false });
      this.pump();
    });
  }

  opened(): Promise<void> {
    return this.openPromise;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(data: string): void {
    this.ws.send(data);
  }

  waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs = 2000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      this.pump();
    });
  }

  waitForType(type: ServerMessage["type"], timeoutMs = 2000): Promise<ServerMessage> {
    return this.waitFor((m) => m.type === type, timeoutMs);
  }

  all(): ServerMessage[] {
    return this.records.map((r) => r.msg);
  }

  closed(): Promise<{ code: number }> {
    return new Promise((resolve) => this.ws.once("close", (code) => resolve({ code })));
  }

  close(): void {
    this.ws.close();
  }

  private pump(): void {
    for (let wi = 0; wi < this.waiters.length; ) {
      const waiter = this.waiters[wi]!;
      const record = this.records.find((r) => !r.consumed && waiter.predicate(r.msg));
      if (record !== undefined) {
        record.consumed = true;
        waiter.resolve(record.msg);
        this.waiters.splice(wi, 1);
      } else {
        wi += 1;
      }
    }
  }
}

let store: InMemoryRoomStore;
let game: GameServer;
let port: number;
const clients: TestClient[] = [];
const ROOM = "room-1";

async function makeRoom(roomId: string): Promise<void> {
  await store.create({ roomId, ...BASE_SETTINGS });
}

async function join(
  roomId: string,
  resumeToken: string | null = null,
  userId: string | null = null,
): Promise<{ client: TestClient; playerId: string; name: string; resumeToken: string; snapshot: ServerMessage }> {
  const client = new TestClient(port);
  clients.push(client);
  await client.opened();
  client.send({ type: "join", roomId, resumeToken, userId });
  const joined = await client.waitForType("joined");
  const snapshot = await client.waitForType("snapshot");
  if (joined.type !== "joined") throw new Error("unreachable");
  return {
    client,
    playerId: joined.identity.id,
    name: joined.identity.name,
    resumeToken: joined.resumeToken,
    snapshot,
  };
}

beforeEach(async () => {
  store = new InMemoryRoomStore();
  game = createGameServer({
    roomStore: store,
    imageStore: stubImageStore,
    // Large intervals so the debounce and idle sweep never fire mid-test; the
    // paths under test are the immediate ones (completion save, evict flush).
    registry: { checkpointIntervalMs: 3_600_000, sweepIntervalMs: 3_600_000 },
  });
  await new Promise<void>((resolve) => game.server.listen(0, resolve));
  port = (game.server.address() as AddressInfo).port;
  await makeRoom(ROOM);
});

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await game.close();
});

describe("websocket net layer", () => {
  it("relays grab, move, and an identical snap_result crediting the dropper", async () => {
    const a = await join(ROOM);
    const b = await join(ROOM);

    a.client.send({ type: "grab", groupId: "0-0" });
    const grabResult = await a.client.waitForType("grab_result");
    expect(grabResult).toMatchObject({ groupId: "0-0", outcome: "granted" });
    const held = await b.client.waitForType("held");
    expect(held).toMatchObject({ type: "held", groupId: "0-0", playerId: a.playerId });

    a.client.send({ type: "move", groupId: "0-0", x: 5, y: 5 });
    const moved = await b.client.waitForType("group_moved");
    expect(moved).toMatchObject({ groupId: "0-0", x: 5, y: 5 });

    // Dropping "0-0" on its exact frame position (0,0) provably frame-locks it.
    a.client.send({ type: "drop", groupId: "0-0", x: 0, y: 0 });
    const snapA = await a.client.waitForType("snap_result");
    const snapB = await b.client.waitForType("snap_result");
    expect(snapA).toEqual(snapB);
    expect(snapA).toMatchObject({
      droppedGroupId: "0-0",
      group: { lockedToFrame: true },
      scoreCredits: [{ guestId: a.playerId, piecesCredited: 1 }],
      progress: { placedPieces: 1, totalPieces: 4 },
    });
  });

  it("reports held_by with the holder's name on a conflicting grab", async () => {
    const a = await join(ROOM);
    const b = await join(ROOM);

    a.client.send({ type: "grab", groupId: "0-0" });
    await a.client.waitForType("grab_result");

    b.client.send({ type: "grab", groupId: "0-0" });
    const conflict = await b.client.waitForType("grab_result");
    expect(conflict).toMatchObject({ groupId: "0-0", outcome: "held_by", holderName: a.name });
  });

  it("releases a held group and drops presence when the holder disconnects", async () => {
    const a = await join(ROOM);
    const b = await join(ROOM);

    a.client.send({ type: "grab", groupId: "0-0" });
    await b.client.waitForType("held");

    a.client.close();
    const released = await b.client.waitForType("released");
    expect(released).toMatchObject({ type: "released", groupId: "0-0" });
    const left = await b.client.waitFor((m) => m.type === "presence" && m.event === "left");
    expect(left).toMatchObject({ event: "left", guestId: a.playerId });
  });

  it("resumes the prior identity and score with a resume token, mints a new one without", async () => {
    // Keeper keeps the room resident so resume reads live in-memory identity.
    await join(ROOM);
    const a = await join(ROOM);

    a.client.send({ type: "grab", groupId: "0-0" });
    await a.client.waitForType("grab_result");
    a.client.send({ type: "drop", groupId: "0-0", x: 0, y: 0 });
    await a.client.waitForType("snap_result");
    a.client.close();
    await a.client.closed();

    const resumed = await join(ROOM, a.resumeToken);
    expect(resumed.playerId).toBe(a.playerId);
    if (resumed.snapshot.type !== "snapshot") throw new Error("unreachable");
    const meResumed = resumed.snapshot.scoreboard.players.find((p) => p.guestId === a.playerId);
    expect(meResumed?.placedCount).toBe(1);

    const fresh = await join(ROOM, null);
    expect(fresh.playerId).not.toBe(a.playerId);
    if (fresh.snapshot.type !== "snapshot") throw new Error("unreachable");
    const meFresh = fresh.snapshot.scoreboard.players.find((p) => p.guestId === fresh.playerId);
    expect(meFresh?.placedCount).toBe(0);
  });

  it("resumes the prior identity by persistent userId when no resume token is sent", async () => {
    // Keeper keeps the room resident so the resume reads live in-memory identity.
    await join(ROOM);
    const a = await join(ROOM, null, "user-A");

    a.client.send({ type: "grab", groupId: "0-0" });
    await a.client.waitForType("grab_result");
    a.client.send({ type: "drop", groupId: "0-0", x: 0, y: 0 });
    await a.client.waitForType("snap_result");
    a.client.close();
    await a.client.closed();

    // Same userId, no resume token: still maps to the same player and score.
    const resumed = await join(ROOM, null, "user-A");
    expect(resumed.playerId).toBe(a.playerId);
    if (resumed.snapshot.type !== "snapshot") throw new Error("unreachable");
    const me = resumed.snapshot.scoreboard.players.find((p) => p.guestId === a.playerId);
    expect(me?.placedCount).toBe(1);
  });

  it("converges a live-derived board to a fresh snapshot (NFR-6)", async () => {
    const a = await join(ROOM);
    const b = await join(ROOM);

    // Scripted sequence: lock 0-0, merge+lock 0-1 onto it, then hold+move 1-0.
    // Every grabbed group is moved before C joins, so B has a position for it.
    for (const [groupId, x, y] of [
      ["0-0", 0, 0],
      ["0-1", 100, 0],
    ] as const) {
      a.client.send({ type: "grab", groupId });
      await b.client.waitFor((m) => m.type === "held" && m.groupId === groupId);
      a.client.send({ type: "move", groupId, x: x + 5, y: y + 5 });
      await b.client.waitFor((m) => m.type === "group_moved" && m.groupId === groupId);
      a.client.send({ type: "drop", groupId, x, y });
      await b.client.waitFor((m) => m.type === "snap_result" && m.droppedGroupId === groupId);
    }
    a.client.send({ type: "grab", groupId: "1-0" });
    await b.client.waitFor((m) => m.type === "held" && m.groupId === "1-0");
    a.client.send({ type: "move", groupId: "1-0", x: 7, y: 107 });
    await b.client.waitFor((m) => m.type === "group_moved" && m.groupId === "1-0" && m.x === 7);

    const c = await join(ROOM);
    if (c.snapshot.type !== "snapshot") throw new Error("unreachable");

    const derived = foldEvents(b.client.all());
    const fromSnapshot = projectSnapshot(c.snapshot);
    expect(derived.groups).toEqual(fromSnapshot.groups);
    expect(derived.progress).toEqual(fromSnapshot.progress);
    expect(derived.scores.get(a.playerId)).toBe(fromSnapshot.scores.get(a.playerId));
    expect(derived.scores.get(b.playerId)).toBe(fromSnapshot.scores.get(b.playerId));
  });

  it("broadcasts completion on solve and rejects further mutations", async () => {
    const a = await join(ROOM);
    for (const [groupId, x, y] of [
      ["0-0", 0, 0],
      ["0-1", 100, 0],
      ["1-0", 0, 100],
      ["1-1", 100, 100],
    ] as const) {
      a.client.send({ type: "grab", groupId });
      await a.client.waitFor((m) => m.type === "grab_result");
      a.client.send({ type: "drop", groupId, x, y });
      await a.client.waitFor((m) => m.type === "snap_result" && m.droppedGroupId === groupId);
    }
    const completion = await a.client.waitForType("completion");
    expect(completion).toMatchObject({ type: "completion", scoreboard: { progress: { placedPieces: 4, totalPieces: 4 } } });

    // Completion is persisted before it's announced (NFR-5); the store shows it.
    const persisted = await store.load(ROOM);
    expect(persisted?.settings.status).toBe("completed");

    a.client.send({ type: "grab", groupId: "0-0" });
    const err = await a.client.waitForType("error");
    expect(err).toMatchObject({ type: "error", code: "room_completed" });
  });

  it("rejects the 21st player with room_full (engine cap is 20)", async () => {
    // ROOM_CAP is a fixed engine constant, not injectable, so the cap is driven
    // with real connections: 20 fill it, the 21st is refused.
    for (let i = 0; i < 20; i++) await join(ROOM);

    const overflow = new TestClient(port);
    clients.push(overflow);
    await overflow.opened();
    overflow.send({ type: "join", roomId: ROOM, resumeToken: null });
    const full = await overflow.waitForType("room_full");
    expect(full).toMatchObject({ type: "room_full" });
    const closed = await overflow.closed();
    expect(closed.code).toBeGreaterThan(0);
  });

  it("errors on malformed input and keeps serving other clients", async () => {
    const bad = new TestClient(port);
    clients.push(bad);
    await bad.opened();

    bad.sendRaw("this is not json");
    expect((await bad.waitForType("error")) as { code: string }).toMatchObject({ code: "invalid_message" });

    // Non-join first message.
    bad.send({ type: "grab", groupId: "0-0" });
    expect(await bad.waitForType("error")).toMatchObject({ code: "invalid_message" });

    // The server keeps serving: a well-formed client still joins and plays.
    const good = await join(ROOM);
    good.client.send({ type: "grab", groupId: "0-0" });
    expect(await good.client.waitForType("grab_result")).toMatchObject({ outcome: "granted" });

    // Non-finite coordinate on an otherwise-joined client is rejected at parse.
    good.client.send({ type: "move", groupId: "0-0", x: "nope", y: 0 });
    expect(await good.client.waitForType("error")).toMatchObject({ code: "invalid_message" });
  });

  it("releases idle holds on the periodic sweep (§9 AFK)", async () => {
    // Own server with an injected clock so the AFK timeout is reached without
    // sleeping; the beforeEach server uses the real clock.
    let clock = 0;
    const idleStore = new InMemoryRoomStore();
    await idleStore.create({ roomId: "idle-room", ...BASE_SETTINGS });
    const idleGame = createGameServer({
      roomStore: idleStore,
      imageStore: stubImageStore,
      registry: { now: () => clock, checkpointIntervalMs: 3_600_000, sweepIntervalMs: 3_600_000 },
    });
    await new Promise<void>((resolve) => idleGame.server.listen(0, resolve));
    const idlePort = (idleGame.server.address() as AddressInfo).port;

    const a = new TestClient(idlePort);
    const b = new TestClient(idlePort);
    clients.push(a, b);
    try {
      await a.opened();
      a.send({ type: "join", roomId: "idle-room", resumeToken: null });
      await a.waitForType("joined");
      await b.opened();
      b.send({ type: "join", roomId: "idle-room", resumeToken: null });
      await b.waitForType("joined");

      a.send({ type: "grab", groupId: "0-0" });
      await b.waitForType("held");

      clock += HOLD_TIMEOUT_MS;
      idleGame.registry.runIdleSweep();

      const released = await b.waitForType("released");
      expect(released).toMatchObject({ type: "released", groupId: "0-0" });
    } finally {
      await idleGame.close();
    }
  });

  it("flushes and evicts on last leave, then revives from the store", async () => {
    const a = await join(ROOM);
    a.client.send({ type: "grab", groupId: "0-0" });
    await a.client.waitForType("grab_result");
    a.client.send({ type: "drop", groupId: "0-0", x: 0, y: 0 });
    await a.client.waitForType("snap_result");
    a.client.close();
    await a.client.closed();

    const persisted = await pollUntil(async () => {
      const state = await store.load(ROOM);
      return state !== null && state.groups.length > 0 ? state : null;
    });
    expect(persisted.groups[0]).toMatchObject({ pieces: [0], lockedToFrame: true });
    expect(persisted.creditedPieces).toEqual([0]);
    expect(game.registry.activeRoomIds()).not.toContain(ROOM);

    const revived = await join(ROOM);
    if (revived.snapshot.type !== "snapshot") throw new Error("unreachable");
    const lockedGroup = revived.snapshot.groups.find((g) => g.id === "0-0");
    expect(lockedGroup).toMatchObject({ lockedToFrame: true });
  });
});

async function pollUntil<T>(fn: () => Promise<T | null>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("pollUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface NormGroup {
  id: string;
  pieces: { row: number; col: number }[];
  position: { x: number; y: number } | undefined;
  lockedToFrame: boolean;
  heldBy: string | null;
}

function piecesFromSingletonId(id: string): { row: number; col: number }[] {
  const [row, col] = id.split("-").map(Number);
  return [{ row: row!, col: col! }];
}

function normalizeGroups(groups: Map<string, NormGroup>): NormGroup[] {
  return [...groups.values()]
    .map((g) => ({
      ...g,
      pieces: [...g.pieces].sort((p, q) => p.row - q.row || p.col - q.col),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Replay a client's message history into the board state it would render (the NFR-6 derived state). */
function foldEvents(messages: ServerMessage[]): {
  groups: NormGroup[];
  scores: Map<string, number>;
  progress: { placedPieces: number; totalPieces: number } | undefined;
} {
  const groups = new Map<string, NormGroup>();
  const scores = new Map<string, number>();
  let progress: { placedPieces: number; totalPieces: number } | undefined;

  for (const m of messages) {
    switch (m.type) {
      case "snapshot":
        for (const g of m.groups) {
          groups.set(g.id, { id: g.id, pieces: g.pieces, position: g.position, lockedToFrame: g.lockedToFrame, heldBy: g.heldBy });
        }
        for (const p of m.scoreboard.players) scores.set(p.guestId, p.placedCount);
        progress = m.scoreboard.progress;
        break;
      case "held": {
        const existing = groups.get(m.groupId) ?? {
          id: m.groupId,
          pieces: piecesFromSingletonId(m.groupId),
          position: undefined,
          lockedToFrame: false,
          heldBy: null,
        };
        existing.heldBy = m.playerId;
        groups.set(m.groupId, existing);
        break;
      }
      case "group_moved": {
        const existing = groups.get(m.groupId);
        if (existing !== undefined) existing.position = { x: m.x, y: m.y };
        break;
      }
      case "released": {
        const existing = groups.get(m.groupId);
        if (existing !== undefined) {
          existing.heldBy = null;
          existing.position = { x: m.x, y: m.y };
        }
        break;
      }
      case "snap_result": {
        for (const id of m.mergedGroupIds) groups.delete(id);
        if (m.droppedGroupId !== m.group.id) groups.delete(m.droppedGroupId);
        groups.set(m.group.id, {
          id: m.group.id,
          pieces: m.group.pieces,
          position: m.group.position,
          lockedToFrame: m.group.lockedToFrame,
          heldBy: null,
        });
        for (const credit of m.scoreCredits) scores.set(credit.guestId, (scores.get(credit.guestId) ?? 0) + credit.piecesCredited);
        progress = m.progress;
        break;
      }
      default:
        break;
    }
  }
  return { groups: normalizeGroups(groups), scores, progress };
}

function projectSnapshot(snapshot: Extract<ServerMessage, { type: "snapshot" }>): {
  groups: NormGroup[];
  scores: Map<string, number>;
  progress: { placedPieces: number; totalPieces: number };
} {
  const groups = new Map<string, NormGroup>();
  for (const g of snapshot.groups) {
    groups.set(g.id, { id: g.id, pieces: g.pieces, position: g.position, lockedToFrame: g.lockedToFrame, heldBy: g.heldBy });
  }
  const scores = new Map<string, number>();
  for (const p of snapshot.scoreboard.players) scores.set(p.guestId, p.placedCount);
  return { groups: normalizeGroups(groups), scores, progress: snapshot.scoreboard.progress };
}
