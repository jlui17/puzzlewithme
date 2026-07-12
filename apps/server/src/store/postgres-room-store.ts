import type { RoomSettings } from "@puzzlewithme/shared";
import pg from "pg";
import type { RoomDeviations, SerializedRoomState } from "../engine/types.js";
import { migrate } from "./migrate.js";
import { emptyRoomState, type RoomStore, type UserRoomSummary } from "./room-store.js";

const { Pool } = pg;

/** Postgres unique_violation SQLSTATE (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
}

export interface PostgresRoomStoreOptions {
  connectionString: string;
}

/**
 * Postgres-backed RoomStore (§6.1.3, §6.3): one row per room. `settings` and
 * `state` are stored as separate JSONB columns per the schema even though
 * SerializedRoomState nests settings inside the deviation record — decomposed
 * on write and reassembled on read (see toRow/fromRow) so `status` can live
 * in its own column for cheap indexing/filtering later (e.g. "all active
 * rooms") without unpacking JSONB.
 *
 * node-postgres serializes plain JS objects passed as query parameters to
 * JSON text automatically (see pg's lib/utils.js prepareValue), and parses
 * jsonb columns back into objects on read, so no manual JSON.stringify/parse
 * is needed here.
 */
export class PostgresRoomStore implements RoomStore {
  private readonly pool: pg.Pool;

  constructor(options: PostgresRoomStoreOptions) {
    this.pool = new Pool({ connectionString: options.connectionString });
  }

  /** Idempotent; safe to call on every boot (see migrate.ts). */
  async migrate(): Promise<void> {
    await migrate(this.pool);
  }

  async create(settings: RoomSettings): Promise<SerializedRoomState> {
    const state = emptyRoomState(settings);
    // Mirrors save()'s rest-destructuring so both derive the stored
    // `deviations` payload the same way and can't drift if RoomDeviations
    // grows a field.
    const { settings: _settings, ...deviations } = state;
    try {
      await this.pool.query(
        `INSERT INTO rooms (id, settings, state, status) VALUES ($1, $2, $3, $4)`,
        [settings.roomId, settings, deviations, settings.status],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(`room ${settings.roomId} already exists`);
      }
      throw err;
    }
    return state;
  }

  async load(roomId: string): Promise<SerializedRoomState | null> {
    const result = await this.pool.query<{ settings: RoomSettings; state: RoomDeviations }>(
      `SELECT settings, state FROM rooms WHERE id = $1`,
      [roomId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { settings: row.settings, ...row.state };
  }

  async save(roomId: string, state: SerializedRoomState): Promise<void> {
    const { settings, ...deviations } = state;
    const result = await this.pool.query(
      `UPDATE rooms SET settings = $2, state = $3, status = $4, updated_at = now() WHERE id = $1`,
      [roomId, settings, deviations, settings.status],
    );
    if (result.rowCount === 0) {
      throw new Error(`room ${roomId} does not exist`);
    }
  }

  async recordMembership(roomId: string, userId: string, createdByUser: boolean): Promise<void> {
    // OR keeps created_by_user sticky: a later participant write (false) can't
    // clear a creator's true, so the flag survives rejoins.
    await this.pool.query(
      `INSERT INTO room_members (room_id, user_id, created_by_user) VALUES ($1, $2, $3)
       ON CONFLICT (room_id, user_id)
       DO UPDATE SET created_by_user = room_members.created_by_user OR excluded.created_by_user`,
      [roomId, userId, createdByUser],
    );
  }

  async listUserRooms(userId: string): Promise<UserRoomSummary[]> {
    const result = await this.pool.query<{
      settings: RoomSettings;
      state: RoomDeviations;
      created_at: Date;
      updated_at: Date;
      created_by_user: boolean;
    }>(
      `SELECT r.settings AS settings, r.state AS state,
              r.created_at AS created_at, r.updated_at AS updated_at,
              m.created_by_user AS created_by_user
       FROM room_members m
       JOIN rooms r ON r.id = m.room_id
       WHERE m.user_id = $1
       ORDER BY r.updated_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({
      roomId: row.settings.roomId,
      status: row.settings.status,
      createdByUser: row.created_by_user,
      // node-postgres parses TIMESTAMPTZ to a Date; normalize to the ISO string
      // the UserRoomSummary contract promises (SQLite already returns text).
      createdAt: row.created_at.toISOString(),
      lastActiveAt: row.updated_at.toISOString(),
      placedPieces: row.state.creditedPieces.length,
      totalPieces: row.settings.rows * row.settings.cols,
    }));
  }

  /** Releases the connection pool; call once on shutdown (or test teardown). */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
