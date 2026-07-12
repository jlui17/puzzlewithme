import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { RoomSettings } from "@puzzlewithme/shared";
import type { RoomDeviations, SerializedRoomState } from "../engine/types.js";
import { emptyRoomState, type RoomStore, type UserRoomSummary } from "./room-store.js";

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
 * SQLite-backed RoomStore (§6.1.3): the zero-setup durable default (no
 * external database to install for local dev/self-host). Mirrors
 * PostgresRoomStore's table shape (rooms: id, settings, state, status,
 * created_at/updated_at) but stores the two JSON columns as TEXT — SQLite has
 * no native JSONB type, so settings/state are JSON.stringify'd on write and
 * JSON.parse'd on read here instead of relying on driver-level
 * serialization like node-postgres does for JSONB.
 *
 * better-sqlite3's API is synchronous; every method below just wraps a sync
 * call in an already-resolved Promise to satisfy the async RoomStore
 * interface, so callers can't tell this store apart from Postgres by timing.
 */
export class SqliteRoomStore implements RoomStore {
  private readonly db: Database.Database;

  constructor(options: SqliteRoomStoreOptions) {
    // better-sqlite3 doesn't create missing parent directories for a file
    // path (unlike ":memory:", which needs none); Postgres has no analogous
    // step since its data directory always predates any connection.
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
        PRIMARY KEY (room_id, user_id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS room_members_user_id ON room_members (user_id)`);
  }

  async create(settings: RoomSettings): Promise<SerializedRoomState> {
    const state = emptyRoomState(settings);
    // Mirrors PostgresRoomStore.create's rest-destructuring so both derive
    // the stored `deviations` payload the same way.
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
                m.created_by_user AS created_by_user
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
      };
    });
  }

  /** Closes the underlying file handle; call once on shutdown (or test teardown). */
  close(): void {
    this.db.close();
  }
}
