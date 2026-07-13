import type { ErrorCode, ServerMessage } from "@puzzlewithme/shared";
import { ensureUserDisplayName } from "../engine/names.js";
import { RoomEngine } from "../engine/room.js";
import type { MutationRejectionReason } from "../engine/types.js";
import type { RoomStore } from "../store/room-store.js";

/**
 * A single client's outbound channel, decoupled from `ws` so the registry can
 * be driven and asserted in tests without real sockets. The WebSocket layer
 * (ws.ts) adapts each socket into one of these.
 */
export interface RoomConnection {
  send(message: ServerMessage): void;
}

export type JoinOutcome =
  | { ok: true; playerId: string }
  | { ok: false; reason: "room_full" | "room_not_found" };

interface LiveRoom {
  roomId: string;
  engine: RoomEngine;
  /** conn -> guest identity id. Object identity is the connection key; a player may hold >1 connection (multiple tabs resuming one identity). */
  connections: Map<RoomConnection, string>;
  /** Pending debounced checkpoint, or null when state is clean since the last save. */
  checkpointTimer: ReturnType<typeof setTimeout> | null;
}

export interface RoomRegistryOptions {
  store: RoomStore;
  /** Injected clock shared with every RoomEngine (tests control time). Defaults to Date.now. */
  now?: () => number;
  /**
   * Debounced-checkpoint window. On the first mutation since a save, a save is
   * scheduled this far out; further mutations in the window ride the same save.
   * This is a throttle (fixed leading delay), not a resetting debounce, so a
   * continuously-mutated room still checkpoints on schedule and crash loss is
   * bounded to at most this interval of piece movement (NFR-5: "loses at most
   * the last few seconds"). 5s guessed against that "few seconds" wording, not
   * measured; tune down if a benchmark shows saves are cheap enough.
   */
  checkpointIntervalMs?: number;
  /**
   * Idle-hold sweep cadence. The engine's hold timeout is minutes (HOLD_TIMEOUT_MS);
   * sweeping once a minute means an AFK hold releases within one timeout plus at
   * most one interval, comfortably inside §9's "minutes, not seconds" budget while
   * keeping the periodic wakeup cheap. Tunable; not measured.
   */
  sweepIntervalMs?: number;
  /** Snap-tolerance override forwarded to every engine (FR-13 server-side tunability). */
  snapTolerance?: number;
}

const DEFAULT_CHECKPOINT_INTERVAL_MS = 5_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Load-on-demand room registry: the bridge between durable RoomStore state and
 * live RoomEngine instances (§7.5). First join for a roomId loads its serialized
 * state and constructs an engine; the last leave flushes and evicts it. Owns the
 * room's connection set and all broadcast fan-out, so the WebSocket layer only
 * parses frames and calls these methods.
 */
export class RoomRegistry {
  private readonly store: RoomStore;
  private readonly now: () => number;
  private readonly checkpointIntervalMs: number;
  private readonly snapTolerance: number | undefined;
  private readonly rooms = new Map<string, LiveRoom>();
  /** In-flight loads, so concurrent joins for one roomId share a single store.load. */
  private readonly loading = new Map<string, Promise<LiveRoom | null>>();
  /** In-flight evict flushes, so a join arriving mid-flush waits rather than double-loading or losing writes. */
  private readonly evicting = new Map<string, Promise<void>>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private closing = false;

  constructor(options: RoomRegistryOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
    this.snapTolerance = options.snapTolerance;
    const sweepMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    // Don't let the periodic sweep hold the process (or a test runner) open.
    this.sweepTimer.unref?.();
  }

  /**
   * Join or resume (§7.2). Loads/revives the room, runs engine.join, sends the
   * joining connection `joined` + `snapshot`, and broadcasts `presence joined`
   * to everyone else. Enforces the room cap (NFR-3) and unknown rooms.
   */
  async join(
    conn: RoomConnection,
    roomId: string,
    resumeToken: string | null,
    userId: string | null = null,
  ): Promise<JoinOutcome> {
    if (this.closing) return { ok: false, reason: "room_not_found" };
    const room = await this.getOrLoad(roomId);
    if (room === null) return { ok: false, reason: "room_not_found" };

    // The user's app-wide display name: existing profile name, or one minted
    // and persisted right here on the user's first-ever join (names live on
    // the profile, not per room). Best-effort — a store failure degrades to
    // the engine's per-room generated name rather than failing the join.
    let displayName: string | null = null;
    if (userId !== null) {
      try {
        displayName = await ensureUserDisplayName(this.store, userId);
      } catch (err) {
        console.error(`ensuring display name failed for user ${userId}`, err);
      }
    }

    const result = room.engine.join(resumeToken, userId, displayName);
    if (!result.ok) return { ok: false, reason: "room_full" };

    // Session history: a join is participation, not creation (creation is
    // recorded at room-create with created=true; the store OR's the flag, so
    // this false never clears it). Best-effort — a failed write must not fail
    // the join, matching saveRoom's non-fatal contract.
    if (userId !== null) await this.recordMembership(roomId, userId, false);

    const playerId = result.identity.id;
    // Whether this identity was already on the board (another tab); if so its
    // presence was already announced, so we don't re-broadcast a join for it.
    const alreadyPresent = this.hasPlayer(room, playerId);
    room.connections.set(conn, playerId);

    conn.send({ type: "joined", identity: result.identity, resumeToken: result.resumeToken });
    conn.send(result.snapshot);
    if (!alreadyPresent) {
      this.broadcast(
        room,
        { type: "presence", event: "joined", player: result.identity },
        conn,
      );
    }
    return { ok: true, playerId };
  }

  /** grab intent: granted -> `held` to all + `grab_result granted` to requester; held_by -> `grab_result held_by`; rule rejection -> `error`. */
  grab(conn: RoomConnection, roomId: string, playerId: string, groupId: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    const result = room.engine.grab(playerId, groupId);
    if (result.outcome === "granted") {
      this.broadcast(room, { type: "held", groupId, playerId });
      conn.send({ type: "grab_result", groupId, outcome: "granted" });
    } else if (result.outcome === "held_by") {
      conn.send({ type: "grab_result", groupId, outcome: "held_by", holderName: result.holderName });
    } else {
      conn.send(errorFor(mutationReasonToCode(result.reason)));
    }
  }

  /**
   * move intent (§6.2's relaxed path): relay `group_moved` to everyone but the
   * mover. A rejected move (non-holder, locked, completed) is dropped silently,
   * not errored: the input parsed fine and is a rule rejection the engine
   * already blocks by not relaying, so the group simply doesn't move for others.
   */
  move(
    conn: RoomConnection,
    roomId: string,
    playerId: string,
    groupId: string,
    x: number,
    y: number,
  ): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    const result = room.engine.move(playerId, groupId, x, y);
    if (!result.ok) return;
    this.broadcast(room, { type: "group_moved", groupId, x, y }, conn);
    this.markDirty(room);
  }

  /**
   * drop intent (§7.3 step 4): broadcast the authoritative `snap_result` to all.
   * On completion, persist before announcing it (§7.6): a completed room is
   * permanently read-only (FR-25), so losing it to a crash after players saw the
   * completion would violate NFR-5. Non-completing drops ride the debounce.
   */
  async drop(
    conn: RoomConnection,
    roomId: string,
    playerId: string,
    groupId: string,
    x: number,
    y: number,
  ): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    const result = room.engine.drop(playerId, groupId, x, y);
    if (!result.ok) {
      conn.send(errorFor(mutationReasonToCode(result.reason)));
      return;
    }
    // Desync diagnostics: one line per placement naming every connection the
    // snap_result went to, so a report of "player X never saw player Y's
    // pieces" can be checked against what the server actually fanned out.
    console.log(
      `[room ${roomId}] snap_result group=${result.result.group.id} by=${playerId} recipients=${room.connections.size}`,
    );
    this.broadcast(room, result.result);
    if (result.completion !== null) {
      this.clearCheckpoint(room);
      await this.saveRoom(room);
      this.broadcast(room, result.completion);
    } else {
      this.markDirty(room);
    }
  }

  /** cursor intent: relay to others (FR-17). Ephemeral, never persisted (§6.2). */
  cursor(conn: RoomConnection, roomId: string, playerId: string, x: number, y: number): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    this.broadcast(room, { type: "cursor", guestId: playerId, x, y }, conn);
  }

  /** rename intent: broadcast `presence renamed`; a completed room rejects it. */
  rename(conn: RoomConnection, roomId: string, playerId: string, name: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    const result = room.engine.rename(playerId, name);
    if (!result.ok) {
      conn.send(errorFor(mutationReasonToCode(result.reason)));
      return;
    }
    // A rename is also the user's app-wide display name (one name per person
    // across rooms; future joins anywhere start with it). Best-effort, like
    // every session-history write: a store failure must not break the rename.
    if (result.userId !== undefined) {
      void this.store.setUserDisplayName(result.userId, result.name).catch((err: unknown) => {
        console.error(`persisting display name failed for user ${result.userId}`, err);
      });
    }
    this.broadcast(room, { type: "presence", event: "renamed", guestId: playerId, name: result.name }, conn);
    this.markDirty(room);
  }

  /**
   * Disconnect (§7.4). Only the player's last connection triggers engine.leave,
   * so a second tab doesn't strand the shared identity; on the real leave we
   * broadcast `released` for freed holds (FR-14) and `presence left` (FR-18).
   * Evicts + flushes the room once its last connection is gone (§7.5).
   */
  leave(conn: RoomConnection, roomId: string, playerId: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    room.connections.delete(conn);
    if (!this.hasPlayer(room, playerId)) {
      const result = room.engine.leave(playerId);
      if (result.left) {
        for (const hold of result.releasedHolds) {
          this.broadcast(room, { type: "released", groupId: hold.groupId, x: hold.position.x, y: hold.position.y });
        }
        this.broadcast(room, { type: "presence", event: "left", guestId: playerId });
      }
    }
    if (room.connections.size === 0 && !this.closing) this.evict(room);
  }

  /** Force the pending checkpoint for a room now (test hook; also lets callers flush on demand). */
  async checkpointNow(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    this.clearCheckpoint(room);
    await this.saveRoom(room);
  }

  /** Run the idle-hold sweep immediately (test hook for the §9 AFK path without waiting on the interval). */
  runIdleSweep(): void {
    this.sweep();
  }

  /** Room ids currently resident in memory. Tests poll this to observe eviction deterministically. */
  activeRoomIds(): string[] {
    return [...this.rooms.keys()];
  }

  /** Graceful shutdown (§7.5 flush): stop timers and persist every live room. Further joins are refused. */
  async shutdown(): Promise<void> {
    this.closing = true;
    clearInterval(this.sweepTimer);
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    for (const room of rooms) {
      this.clearCheckpoint(room);
      await this.saveRoom(room);
    }
  }

  private async getOrLoad(roomId: string): Promise<LiveRoom | null> {
    // An in-flight evict is deleting-then-saving this room; wait for the save so
    // we reload the freshest persisted state instead of racing it.
    const evicting = this.evicting.get(roomId);
    if (evicting !== undefined) await evicting;

    const existing = this.rooms.get(roomId);
    if (existing !== undefined) return existing;

    let pending = this.loading.get(roomId);
    if (pending === undefined) {
      pending = (async (): Promise<LiveRoom | null> => {
        const state = await this.store.load(roomId);
        if (state === null) return null;
        const engine = new RoomEngine({
          settings: state.settings,
          now: this.now,
          persisted: state,
          snapTolerance: this.snapTolerance,
        });
        const room: LiveRoom = { roomId, engine, connections: new Map(), checkpointTimer: null };
        this.rooms.set(roomId, room);
        return room;
      })().finally(() => this.loading.delete(roomId));
      this.loading.set(roomId, pending);
    }
    return pending;
  }

  private evict(room: LiveRoom): void {
    this.clearCheckpoint(room);
    // Remove from the live map synchronously so a concurrent join can't grab a
    // room that's being torn down; the evicting promise gates its reload.
    this.rooms.delete(room.roomId);
    const flush = this.saveRoom(room).finally(() => this.evicting.delete(room.roomId));
    this.evicting.set(room.roomId, flush);
  }

  private sweep(): void {
    for (const room of this.rooms.values()) {
      const released = room.engine.expireIdleHolds();
      for (const hold of released) {
        this.broadcast(room, { type: "released", groupId: hold.groupId, x: hold.position.x, y: hold.position.y });
      }
    }
  }

  private hasPlayer(room: LiveRoom, playerId: string): boolean {
    for (const id of room.connections.values()) if (id === playerId) return true;
    return false;
  }

  private broadcast(room: LiveRoom, message: ServerMessage, except?: RoomConnection): void {
    for (const conn of room.connections.keys()) {
      if (conn === except) continue;
      conn.send(message);
    }
  }

  private markDirty(room: LiveRoom): void {
    if (room.checkpointTimer !== null) return;
    room.checkpointTimer = setTimeout(() => {
      room.checkpointTimer = null;
      void this.saveRoom(room);
    }, this.checkpointIntervalMs);
    room.checkpointTimer.unref?.();
  }

  private clearCheckpoint(room: LiveRoom): void {
    if (room.checkpointTimer !== null) {
      clearTimeout(room.checkpointTimer);
      room.checkpointTimer = null;
    }
  }

  private async recordMembership(roomId: string, userId: string, createdByUser: boolean): Promise<void> {
    try {
      await this.store.recordMembership(roomId, userId, createdByUser);
    } catch (err) {
      // Session history is a nice-to-have; a write failure must not break play.
      console.error(`recording membership failed for room ${roomId}`, err);
    }
  }

  private async saveRoom(room: LiveRoom): Promise<void> {
    try {
      await this.store.save(room.roomId, room.engine.serialize());
    } catch (err) {
      // A failed checkpoint must not crash the server; the next checkpoint or the
      // eviction flush retries, and worst case we lose bounded recent movement (NFR-5).
      console.error(`checkpoint failed for room ${room.roomId}`, err);
    }
  }
}

function errorFor(code: ErrorCode): ServerMessage {
  return { type: "error", code, message: code };
}

/** Engine rejection reasons -> wire ErrorCodes. unknown_group/unknown_player mean the client sent a stale/bogus id, i.e. malformed intent. */
function mutationReasonToCode(reason: MutationRejectionReason): ErrorCode {
  switch (reason) {
    case "room_completed":
      return "room_completed";
    case "group_locked":
      return "group_locked";
    case "not_holder":
      return "not_holder";
    case "unknown_group":
    case "unknown_player":
      return "invalid_message";
  }
}
