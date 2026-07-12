import type { RoomSettings, RoomStatus } from "@puzzlewithme/shared";
import type { SerializedRoomState } from "../engine/types.js";

/**
 * One entry in a user's session history. Every RoomStore normalizes to this
 * exact shape regardless of backend: timestamps are ISO-8601 strings (Postgres
 * returns TIMESTAMPTZ as Date, SQLite as text; both are coerced here) and
 * progress is derived, not raw JSON. Sorted newest-active first by the store.
 */
export interface UserRoomSummary {
  roomId: string;
  status: RoomStatus;
  /** True when this user created the room (sticky once set). */
  createdByUser: boolean;
  /** Room creation time (ISO-8601). */
  createdAt: string;
  /** Last time the room's state was persisted, i.e. last activity (ISO-8601). */
  lastActiveAt: string;
  placedPieces: number;
  totalPieces: number;
}

/**
 * Durable record of every room (§6.1.3); the game server is its only writer.
 * Signatures are async because the production implementation is Postgres
 * (§6.3); InMemoryRoomStore exists for tests and local dev.
 */
export interface RoomStore {
  /** Create the initial, deviation-free record for a new room (§7.1). Rejects a duplicate roomId. */
  create(settings: RoomSettings): Promise<SerializedRoomState>;
  /** A room's persisted state, or null for an unknown id (room_not_found upstream). */
  load(roomId: string): Promise<SerializedRoomState | null>;
  /** Persist a room's current state: the periodic checkpoint and the dormancy flush (§7.5, NFR-5). */
  save(roomId: string, state: SerializedRoomState): Promise<void>;
  /**
   * Record that a persistent user created or joined a room (session history).
   * Idempotent per (roomId, userId); `createdByUser` is sticky-OR'd so a
   * creator who later rejoins as a participant stays flagged as the creator.
   */
  recordMembership(roomId: string, userId: string, createdByUser: boolean): Promise<void>;
  /** A user's rooms (created or joined), newest-active first; empty for an unknown user. */
  listUserRooms(userId: string): Promise<UserRoomSummary[]>;
  /**
   * The user's app-wide display name, or null when they never set one. The
   * name is an attribute of the persistent userId (one name per person across
   * every room), not the identity key itself — keying on the name would break
   * a user's history on rename and collide two people who pick the same name.
   */
  getUserDisplayName(userId: string): Promise<string | null>;
  /** Upsert the user's app-wide display name (written on every in-room rename). */
  setUserDisplayName(userId: string, displayName: string): Promise<void>;
}

/** A brand-new room's state: settings and nothing else (§8: an untouched room stores no groups). */
export function emptyRoomState(settings: RoomSettings): SerializedRoomState {
  return {
    settings: { ...settings },
    groups: [],
    creditedPieces: [],
    identities: [],
    activeSolvingTimeMs: 0,
  };
}

interface RoomTimestamps {
  createdAt: string;
  updatedAt: string;
}

export class InMemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, SerializedRoomState>();
  private readonly timestamps = new Map<string, RoomTimestamps>();
  /** roomId -> (userId -> createdByUser). Mirrors the SQL stores' room_members table. */
  private readonly memberships = new Map<string, Map<string, boolean>>();
  /** userId -> display name. Mirrors the SQL stores' users table. */
  private readonly displayNames = new Map<string, string>();

  // structuredClone at every boundary so callers and the store never share
  // object graphs — mutating a loaded state must not silently mutate the
  // store, mirroring the isolation a real database gives for free.
  async create(settings: RoomSettings): Promise<SerializedRoomState> {
    if (this.rooms.has(settings.roomId)) {
      throw new Error(`room ${settings.roomId} already exists`);
    }
    const state = emptyRoomState(settings);
    this.rooms.set(settings.roomId, structuredClone(state));
    const now = new Date().toISOString();
    this.timestamps.set(settings.roomId, { createdAt: now, updatedAt: now });
    return state;
  }

  async load(roomId: string): Promise<SerializedRoomState | null> {
    const state = this.rooms.get(roomId);
    return state === undefined ? null : structuredClone(state);
  }

  async save(roomId: string, state: SerializedRoomState): Promise<void> {
    const ts = this.timestamps.get(roomId);
    if (!this.rooms.has(roomId) || ts === undefined) {
      throw new Error(`room ${roomId} does not exist`);
    }
    this.rooms.set(roomId, structuredClone(state));
    ts.updatedAt = new Date().toISOString();
  }

  async recordMembership(roomId: string, userId: string, createdByUser: boolean): Promise<void> {
    let members = this.memberships.get(roomId);
    if (members === undefined) {
      members = new Map();
      this.memberships.set(roomId, members);
    }
    members.set(userId, (members.get(userId) ?? false) || createdByUser);
  }

  async listUserRooms(userId: string): Promise<UserRoomSummary[]> {
    const summaries: UserRoomSummary[] = [];
    for (const [roomId, members] of this.memberships) {
      const createdByUser = members.get(userId);
      if (createdByUser === undefined) continue;
      const state = this.rooms.get(roomId);
      const ts = this.timestamps.get(roomId);
      if (state === undefined || ts === undefined) continue;
      summaries.push({
        roomId,
        status: state.settings.status,
        createdByUser,
        createdAt: ts.createdAt,
        lastActiveAt: ts.updatedAt,
        placedPieces: state.creditedPieces.length,
        totalPieces: state.settings.rows * state.settings.cols,
      });
    }
    return summaries.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
  }

  async getUserDisplayName(userId: string): Promise<string | null> {
    return this.displayNames.get(userId) ?? null;
  }

  async setUserDisplayName(userId: string, displayName: string): Promise<void> {
    this.displayNames.set(userId, displayName);
  }
}
