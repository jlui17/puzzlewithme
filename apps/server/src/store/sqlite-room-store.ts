import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { RoomSettings } from "@puzzlewithme/shared";
import type { RoomDeviations, SerializedRoomState } from "../engine/types.js";
import { emptyRoomState, type RoomStore } from "./room-store.js";

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

  /** Closes the underlying file handle; call once on shutdown (or test teardown). */
  close(): void {
    this.db.close();
  }
}
