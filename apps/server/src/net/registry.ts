import type { ClientMessage, ErrorCode, ServerMessage } from "@puzzlewithme/shared";
import { ensureUserDisplayName } from "../engine/names.js";
import { RoomEngine } from "../engine/room.js";
import type { MutationRejectionReason } from "../engine/types.js";
import { recordMembershipWithRetry } from "../store/record-membership.js";
import type { RoomStore } from "../store/room-store.js";

/**
 * A single client's outbound channel, decoupled from `ws` so the registry can
 * be driven and asserted in tests without real sockets. The WebSocket layer
 * (ws.ts) adapts each socket into one of these.
 */
export interface RoomConnection {
  send(message: ServerMessage): void;
}

/**
 * A joined player's handle on their room: the proof of a completed join, so
 * holders never juggle nullable roomId/playerId. Everything after the join
 * handshake flows through `apply`; `leave` releases the connection.
 */
export interface RoomSession {
  readonly roomId: string;
  readonly playerId: string;
  apply(message: ClientMessage): Promise<void>;
  leave(): void;
}

export type JoinOutcome =
  | { ok: true; session: RoomSession }
  | { ok: false; reason: "room_full" | "room_not_found" };

/**
 * What one intent does to the room, declaratively: who gets which messages,
 * and how the mutation persists. runEffect is the single executor, so the
 * fan-out policy of every intent reads (and changes) in one place.
 */
interface Effect {
  sends: Array<{ to: "sender" | "all" | "others"; message: ServerMessage }>;
  persist: "none" | "debounced" | "immediate";
  /**
   * Broadcast only after an immediate persist completes. Completion's slot
   * (§7.6): a completed room is permanently read-only (FR-25), so losing it
   * to a crash after players saw the completion would violate NFR-5.
   */
  afterPersist?: ServerMessage;
}

const NO_EFFECT: Effect = { sends: [], persist: "none" };

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
    if (userId !== null) await recordMembershipWithRetry(this.store, roomId, userId, false);

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
    return {
      ok: true,
      session: {
        roomId,
        playerId,
        apply: (message) => this.apply(conn, roomId, playerId, message),
        leave: () => this.leave(conn, roomId, playerId),
      },
    };
  }

  /** One joined intent: resolve the room once, decide the effect, execute it. */
  private async apply(
    conn: RoomConnection,
    roomId: string,
    playerId: string,
    message: ClientMessage,
  ): Promise<void> {
    // join and ping never reach a session: the WebSocket layer owns the join
    // handshake and liveness.
    if (message.type === "join" || message.type === "ping") return;
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    const effect = this.effectFor(room, playerId, message);
    await this.runEffect(room, conn, effect);
  }

  private effectFor(
    room: LiveRoom,
    playerId: string,
    message: Exclude<ClientMessage, { type: "join" } | { type: "ping" }>,
  ): Effect {
    switch (message.type) {
      /** grab: granted -> `held` to all + `grab_result granted` to requester; held_by -> `grab_result held_by`; rule rejection -> `error`. */
      case "grab": {
        const result = room.engine.grab(playerId, message.groupId);
        if (result.outcome === "granted") {
          return {
            sends: [
              { to: "all", message: { type: "held", groupId: message.groupId, playerId } },
              { to: "sender", message: { type: "grab_result", groupId: message.groupId, outcome: "granted" } },
            ],
            persist: "none",
          };
        }
        if (result.outcome === "held_by") {
          return {
            sends: [
              {
                to: "sender",
                message: {
                  type: "grab_result",
                  groupId: message.groupId,
                  outcome: "held_by",
                  holderName: result.holderName,
                },
              },
            ],
            persist: "none",
          };
        }
        return rejection(result.reason);
      }

      // move (§6.2's relaxed path): relay `group_moved` to everyone but the
      // mover. A rejected move (non-holder, locked, completed) is dropped
      // silently, not errored: the input parsed fine and is a rule rejection
      // the engine already blocks by not relaying, so the group simply
      // doesn't move for others.
      case "move": {
        const result = room.engine.move(playerId, message.groupId, message.x, message.y);
        if (!result.ok) return NO_EFFECT;
        return {
          sends: [
            { to: "others", message: { type: "group_moved", groupId: message.groupId, x: message.x, y: message.y } },
          ],
          persist: "debounced",
        };
      }

      // drop (§7.3 step 4): broadcast the authoritative `snap_result` to all.
      // A completing drop persists immediately and announces completion only
      // after the save (see Effect.afterPersist); others ride the debounce.
      case "drop": {
        const result = room.engine.drop(playerId, message.groupId, message.x, message.y);
        if (!result.ok) return rejection(result.reason);
        // Desync diagnostics: one line per placement naming every connection
        // the snap_result went to, so a report of "player X never saw player
        // Y's pieces" can be checked against what the server actually fanned out.
        console.log(
          `[room ${room.roomId}] snap_result group=${result.result.group.id} by=${playerId} recipients=${room.connections.size}`,
        );
        if (result.completion !== null) {
          return {
            sends: [{ to: "all", message: result.result }],
            persist: "immediate",
            afterPersist: result.completion,
          };
        }
        return { sends: [{ to: "all", message: result.result }], persist: "debounced" };
      }

      // cursor: relay to others (FR-17). Ephemeral, never persisted (§6.2).
      case "cursor":
        return {
          sends: [{ to: "others", message: { type: "cursor", guestId: playerId, x: message.x, y: message.y } }],
          persist: "none",
        };

      // rename: broadcast `presence renamed`; a completed room rejects it.
      case "rename": {
        const result = room.engine.rename(playerId, message.name);
        if (!result.ok) return rejection(result.reason);
        // A rename is also the user's app-wide display name (one name per
        // person across rooms; future joins anywhere start with it).
        // Best-effort, like every session-history write: a store failure
        // must not break the rename.
        if (result.userId !== undefined) {
          void this.store.setUserDisplayName(result.userId, result.name).catch((err: unknown) => {
            console.error(`persisting display name failed for user ${result.userId}`, err);
          });
        }
        return {
          sends: [
            {
              to: "others",
              message: { type: "presence", event: "renamed", guestId: playerId, name: result.name },
            },
          ],
          persist: "debounced",
        };
      }
    }
  }

  private async runEffect(room: LiveRoom, conn: RoomConnection, effect: Effect): Promise<void> {
    for (const send of effect.sends) {
      if (send.to === "sender") conn.send(send.message);
      else this.broadcast(room, send.message, send.to === "others" ? conn : undefined);
    }
    if (effect.persist === "debounced") {
      this.markDirty(room);
    } else if (effect.persist === "immediate") {
      this.clearCheckpoint(room);
      await this.saveRoom(room);
    }
    if (effect.afterPersist !== undefined) this.broadcast(room, effect.afterPersist);
  }

  /**
   * Disconnect (§7.4). Only the player's last connection triggers engine.leave,
   * so a second tab doesn't strand the shared identity; on the real leave we
   * broadcast `released` for freed holds (FR-14) and `presence left` (FR-18).
   * Evicts + flushes the room once its last connection is gone (§7.5).
   */
  private leave(conn: RoomConnection, roomId: string, playerId: string): void {
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

/** A rule rejection: the sender alone hears about it, nothing persists. */
function rejection(reason: MutationRejectionReason): Effect {
  return {
    sends: [{ to: "sender", message: errorFor(mutationReasonToCode(reason)) }],
    persist: "none",
  };
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
