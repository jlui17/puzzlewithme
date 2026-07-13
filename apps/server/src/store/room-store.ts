import type { RoomSettings, RoomStatus } from "@puzzlewithme/shared";
import type { SerializedRoomState } from "../engine/types.js";

/**
 * One entry in a user's session history. Every RoomStore normalizes to this
 * exact shape regardless of backend: timestamps are ISO-8601 strings and
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
  /**
   * The user's own label for this room in their session list, or null when
   * never set. Per-membership, not per-room: it's a personal bookmark name,
   * so two members renaming their own lists must not overwrite each other.
   */
  name: string | null;
}

/**
 * One image in a user's upload gallery. `width`/`height` are the ORIGINAL
 * upload's dimensions, not the stored (downscaled) file's: creating a new
 * room from a gallery image re-runs the same grid derivation and
 * min-cell-resolution check the first upload passed, and those are defined
 * against what the user uploaded (see process-image.ts's validatePieceGrid).
 */
export interface UserImageSummary {
  imageId: string;
  /** Upload time (ISO-8601). */
  createdAt: string;
  width: number;
  height: number;
}

/**
 * Durable record of every room (§6.1.3); the game server is its only writer.
 * Signatures are async so a future network-backed implementation fits the
 * interface; production is SqliteRoomStore, and InMemoryRoomStore exists for
 * tests and local dev.
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
   * Set (or clear, with null) the user's personal name for a room they are a
   * member of. Returns false when no such membership exists, so the HTTP
   * layer can 404 instead of silently minting a membership for a room the
   * user never touched.
   */
  setRoomName(roomId: string, userId: string, name: string | null): Promise<boolean>;
  /**
   * The user's app-wide display name, or null when they never set one. The
   * name is an attribute of the persistent userId (one name per person across
   * every room), not the identity key itself — keying on the name would break
   * a user's history on rename and collide two people who pick the same name.
   */
  getUserDisplayName(userId: string): Promise<string | null>;
  /** Upsert the user's app-wide display name (written on every in-room rename). */
  setUserDisplayName(userId: string, displayName: string): Promise<void>;
  /**
   * Record who uploaded an image (gallery). One row per upload; imageId is
   * the ImageStore key the bytes live under. Rejects a duplicate imageId —
   * ids are minted fresh per upload, so a collision is a caller bug.
   */
  recordImage(imageId: string, ownerUserId: string, width: number, height: number): Promise<void>;
  /** The user's uploaded images, newest first; empty for an unknown user. */
  listUserImages(userId: string): Promise<UserImageSummary[]>;
  /**
   * One gallery image, ownership-checked: null when the id is unknown OR
   * belongs to someone else, so create-from-gallery can't reference another
   * user's image even with a leaked id.
   */
  getUserImage(imageId: string, userId: string): Promise<UserImageSummary | null>;
  /**
   * Remove an image from the user's gallery. Returns false when no such
   * owned image exists (404 upstream). Deletes only the gallery row, never
   * the bytes: every upload backs at least one room, and rooms are viewable
   * forever (FR-25), so the stored file must outlive its gallery entry.
   */
  deleteUserImage(imageId: string, userId: string): Promise<boolean>;
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
  /** roomId -> (userId -> membership row). Mirrors the SQL stores' room_members table. */
  private readonly memberships = new Map<string, Map<string, { createdByUser: boolean; name: string | null }>>();
  /** userId -> display name. Mirrors the SQL stores' users table. */
  private readonly displayNames = new Map<string, string>();
  /** imageId -> gallery row. Mirrors the SQL stores' images table. */
  private readonly images = new Map<string, { ownerUserId: string; width: number; height: number; createdAt: string }>();

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
    const existing = members.get(userId);
    members.set(userId, {
      createdByUser: (existing?.createdByUser ?? false) || createdByUser,
      name: existing?.name ?? null,
    });
  }

  async listUserRooms(userId: string): Promise<UserRoomSummary[]> {
    const summaries: UserRoomSummary[] = [];
    for (const [roomId, members] of this.memberships) {
      const membership = members.get(userId);
      if (membership === undefined) continue;
      const state = this.rooms.get(roomId);
      const ts = this.timestamps.get(roomId);
      if (state === undefined || ts === undefined) continue;
      summaries.push({
        roomId,
        status: state.settings.status,
        createdByUser: membership.createdByUser,
        createdAt: ts.createdAt,
        lastActiveAt: ts.updatedAt,
        placedPieces: state.creditedPieces.length,
        totalPieces: state.settings.rows * state.settings.cols,
        name: membership.name,
      });
    }
    return summaries.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
  }

  async setRoomName(roomId: string, userId: string, name: string | null): Promise<boolean> {
    const membership = this.memberships.get(roomId)?.get(userId);
    if (membership === undefined) return false;
    membership.name = name;
    return true;
  }

  async getUserDisplayName(userId: string): Promise<string | null> {
    return this.displayNames.get(userId) ?? null;
  }

  async setUserDisplayName(userId: string, displayName: string): Promise<void> {
    this.displayNames.set(userId, displayName);
  }

  async recordImage(imageId: string, ownerUserId: string, width: number, height: number): Promise<void> {
    if (this.images.has(imageId)) {
      throw new Error(`image ${imageId} already exists`);
    }
    this.images.set(imageId, { ownerUserId, width, height, createdAt: new Date().toISOString() });
  }

  async listUserImages(userId: string): Promise<UserImageSummary[]> {
    const summaries: UserImageSummary[] = [];
    for (const [imageId, row] of this.images) {
      if (row.ownerUserId !== userId) continue;
      summaries.push({ imageId, createdAt: row.createdAt, width: row.width, height: row.height });
    }
    return summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async getUserImage(imageId: string, userId: string): Promise<UserImageSummary | null> {
    const row = this.images.get(imageId);
    if (row === undefined || row.ownerUserId !== userId) return null;
    return { imageId, createdAt: row.createdAt, width: row.width, height: row.height };
  }

  async deleteUserImage(imageId: string, userId: string): Promise<boolean> {
    const row = this.images.get(imageId);
    if (row === undefined || row.ownerUserId !== userId) return false;
    this.images.delete(imageId);
    return true;
  }
}
