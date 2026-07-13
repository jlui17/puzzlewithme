import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { RoomSettings } from "@puzzlewithme/shared";
import type { RoomDeviations, SerializedRoomState } from "../engine/types.js";
import { emptyRoomState, type RoomStore, type UserImageSummary, type UserRoomSummary } from "./room-store.js";

/** SQLite has no unique_violation code; better-sqlite3 throws this message for a PK collision. */
const CONSTRAINT_ERROR = "SQLITE_CONSTRAINT_PRIMARYKEY";

function isPrimaryKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === CONSTRAINT_ERROR;
}

export interface SqliteRoomStoreOptions {
  /** Path to the db file, or ":memory:" for an ephemeral, process-local database (tests). */
  path: string;
}

/**
 * SQLite-backed RoomStore (§6.1.3): the durable store for both local dev and
 * production (no external database to install or operate). Two JSON columns
 * stored as TEXT — SQLite has no native JSONB type, so settings/state are
 * JSON.stringify'd on write and JSON.parse'd on read.
 *
 * better-sqlite3's API is synchronous; every method below just wraps a sync
 * call in an already-resolved Promise to satisfy the async RoomStore
 * interface, which keeps the door open for a network-backed store.
 */
export class SqliteRoomStore implements RoomStore {
  private readonly db: Database.Database;

  constructor(options: SqliteRoomStoreOptions) {
    // better-sqlite3 doesn't create missing parent directories for a file
    // path (":memory:" needs none).
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.db = new Database(options.path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  /** Idempotent; run on every open since there's no separate deploy-time migration step for SQLite. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        settings TEXT NOT NULL,
        state TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    // Session-history membership: one row per (room, persistent user). No FK to
    // rooms — a membership write must never fail the join/create it rides on,
    // and listUserRooms already inner-joins rooms so an orphan row is invisible.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_members (
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_by_user INTEGER NOT NULL DEFAULT 0,
        name TEXT,
        PRIMARY KEY (room_id, user_id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS room_members_user_id ON room_members (user_id)`);
    // Databases created before the per-user room name existed lack the column
    // (CREATE TABLE IF NOT EXISTS won't add it). SQLite has no ADD COLUMN IF
    // NOT EXISTS, so probe the schema instead of catching a duplicate error.
    const memberColumns = this.db.prepare(`PRAGMA table_info(room_members)`).all() as Array<{ name: string }>;
    if (!memberColumns.some((c) => c.name === "name")) {
      this.db.exec(`ALTER TABLE room_members ADD COLUMN name TEXT`);
    }
    // App-wide user attributes keyed by the persistent anonymous userId. Today
    // just the display name; the natural place for future sign-up fields.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL
      )
    `);
    // Upload gallery: who uploaded which image (id = the ImageStore key).
    // width/height are the ORIGINAL upload's dimensions (see UserImageSummary
    // for why). No FK from rooms' imageRef — it lives inside the settings
    // JSON, and a deleted gallery row must not affect the rooms that still
    // render the image.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS images_owner_user_id ON images (owner_user_id)`);
  }

  async create(settings: RoomSettings): Promise<SerializedRoomState> {
    const state = emptyRoomState(settings);
    // Same rest-destructuring as save() so both derive the stored
    // `deviations` payload the same way and can't drift if RoomDeviations
    // grows a field.
    const { settings: _settings, ...deviations } = state;
    try {
      this.db
        .prepare(`INSERT INTO rooms (id, settings, state, status) VALUES (?, ?, ?, ?)`)
        .run(settings.roomId, JSON.stringify(settings), JSON.stringify(deviations), settings.status);
    } catch (err) {
      if (isPrimaryKeyViolation(err)) {
        throw new Error(`room ${settings.roomId} already exists`);
      }
      throw err;
    }
    return state;
  }

  async load(roomId: string): Promise<SerializedRoomState | null> {
    const row = this.db
      .prepare<[string], { settings: string; state: string }>(`SELECT settings, state FROM rooms WHERE id = ?`)
      .get(roomId);
    if (row === undefined) return null;
    const settings = JSON.parse(row.settings) as RoomSettings;
    const state = JSON.parse(row.state) as RoomDeviations;
    return { settings, ...state };
  }

  async save(roomId: string, state: SerializedRoomState): Promise<void> {
    const { settings, ...deviations } = state;
    const result = this.db
      .prepare(
        `UPDATE rooms SET settings = ?, state = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(JSON.stringify(settings), JSON.stringify(deviations), settings.status, roomId);
    if (result.changes === 0) {
      throw new Error(`room ${roomId} does not exist`);
    }
  }

  async recordMembership(roomId: string, userId: string, createdByUser: boolean): Promise<void> {
    // MAX(...) keeps created_by_user sticky: once 1, a later participant write
    // (0) can't clear it, so the creator flag survives rejoins.
    this.db
      .prepare(
        `INSERT INTO room_members (room_id, user_id, created_by_user) VALUES (?, ?, ?)
         ON CONFLICT (room_id, user_id)
         DO UPDATE SET created_by_user = MAX(created_by_user, excluded.created_by_user)`,
      )
      .run(roomId, userId, createdByUser ? 1 : 0);
  }

  async listUserRooms(userId: string): Promise<UserRoomSummary[]> {
    const rows = this.db
      .prepare<
        [string],
        { settings: string; status: string; created_at: string; updated_at: string; created_by_user: number }
      >(
        `SELECT r.settings AS settings, r.state AS state, r.status AS status,
                r.created_at AS created_at, r.updated_at AS updated_at,
                m.created_by_user AS created_by_user, m.name AS name
         FROM room_members m
         JOIN rooms r ON r.id = m.room_id
         WHERE m.user_id = ?
         ORDER BY r.updated_at DESC`,
      )
      .all(userId) as Array<{
      settings: string;
      state: string;
      status: string;
      created_at: string;
      updated_at: string;
      created_by_user: number;
      name: string | null;
    }>;
    return rows.map((row) => {
      const settings = JSON.parse(row.settings) as RoomSettings;
      const state = JSON.parse(row.state) as RoomDeviations;
      return {
        roomId: settings.roomId,
        status: settings.status,
        createdByUser: row.created_by_user === 1,
        createdAt: row.created_at,
        lastActiveAt: row.updated_at,
        placedPieces: state.creditedPieces.length,
        totalPieces: settings.rows * settings.cols,
        name: row.name,
      };
    });
  }

  async setRoomName(roomId: string, userId: string, name: string | null): Promise<boolean> {
    const result = this.db
      .prepare(`UPDATE room_members SET name = ? WHERE room_id = ? AND user_id = ?`)
      .run(name, roomId, userId);
    return result.changes > 0;
  }

  async getUserDisplayName(userId: string): Promise<string | null> {
    const row = this.db
      .prepare<[string], { display_name: string }>(`SELECT display_name FROM users WHERE user_id = ?`)
      .get(userId);
    return row?.display_name ?? null;
  }

  async setUserDisplayName(userId: string, displayName: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO users (user_id, display_name) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name`,
      )
      .run(userId, displayName);
  }

  async recordImage(imageId: string, ownerUserId: string, width: number, height: number): Promise<void> {
    try {
      this.db
        .prepare(`INSERT INTO images (id, owner_user_id, width, height) VALUES (?, ?, ?, ?)`)
        .run(imageId, ownerUserId, width, height);
    } catch (err) {
      if (isPrimaryKeyViolation(err)) {
        throw new Error(`image ${imageId} already exists`);
      }
      throw err;
    }
  }

  async listUserImages(userId: string): Promise<UserImageSummary[]> {
    const rows = this.db
      .prepare<[string], { id: string; created_at: string; width: number; height: number }>(
        `SELECT id, created_at, width, height FROM images WHERE owner_user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId);
    return rows.map((row) => ({ imageId: row.id, createdAt: row.created_at, width: row.width, height: row.height }));
  }

  async getUserImage(imageId: string, userId: string): Promise<UserImageSummary | null> {
    const row = this.db
      .prepare<[string, string], { id: string; created_at: string; width: number; height: number }>(
        `SELECT id, created_at, width, height FROM images WHERE id = ? AND owner_user_id = ?`,
      )
      .get(imageId, userId);
    if (row === undefined) return null;
    return { imageId: row.id, createdAt: row.created_at, width: row.width, height: row.height };
  }

  async deleteUserImage(imageId: string, userId: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM images WHERE id = ? AND owner_user_id = ?`).run(imageId, userId);
    return result.changes > 0;
  }

  /** Closes the underlying file handle; call once on shutdown (or test teardown). */
  close(): void {
    this.db.close();
  }
}
