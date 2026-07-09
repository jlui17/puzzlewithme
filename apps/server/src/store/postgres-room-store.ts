import type { RoomSettings } from "@puzzlewithme/shared";
import pg from "pg";
import type { RoomDeviations, SerializedRoomState } from "../engine/types.js";
import { migrate } from "./migrate.js";
import { emptyRoomState, type RoomStore } from "./room-store.js";

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

  /** Releases the connection pool; call once on shutdown (or test teardown). */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
