/**
 * Core room/board state shapes (§8 conceptual data model).
 *
 * These are plain types, not zod schemas: state is produced and mutated only
 * by the game server (§6.2, "the game server is the only component that
 * mutates room state"), so it's a trusted producer and doesn't need runtime
 * validation the way inbound client messages do (NFR-7).
 */

/** A single jigsaw piece's position in the grid. Piece shape/geometry itself is derived from the seed, not stored (§8). */
export interface PieceCoord {
  row: number;
  col: number;
}

/**
 * Group id convention, shared so client and server derive identical ids for
 * seeded state without exchanging them (§2's determinism principle applied to
 * ids): every piece starts as its own group with id `"${row}-${col}"`. Merged
 * groups keep the id of the group that was dropped (SnapResultMessage.group.id
 * equals droppedGroupId), so every id in play originates here and stays
 * unique: a merge retires the absorbed ids and never mints a new one.
 */
export function singletonGroupId(row: number, col: number): string {
  return `${row}-${col}`;
}

export type RoomStatus = "active" | "completed";

/** Immutable per-room configuration (FR-4). Everything needed to regenerate the puzzle's geometry deterministically (§2, §6.1.5). */
export interface RoomSettings {
  roomId: string;
  imageRef: string;
  rows: number;
  cols: number;
  seed: string;
  status: RoomStatus;
}

/**
 * A set of one or more correctly-joined pieces that moves as a single unit
 * (§4.3). Every piece starts as its own group; groups merge on snap (FR-11)
 * and lock permanently once placed in the frame (FR-12).
 */
export interface Group {
  id: string;
  pieces: PieceCoord[];
  position: { x: number; y: number };
  lockedToFrame: boolean;
  /** Guest identity id currently holding this group, or null if free (FR-9). */
  heldBy: string | null;
}

/** A player's identity within one room. Resumable via browser association (FR-24), never shared across rooms (FR-22). */
export interface GuestIdentity {
  id: string;
  name: string;
  color: string;
  placedCount: number;
}

/** Room-wide progress summary shown alongside per-player counts (FR-20). */
export interface RoomProgress {
  placedPieces: number;
  totalPieces: number;
}

/** Per-player score entry, paired with room-wide progress for the "314 / 588" style display (FR-20). */
export interface PlayerScore {
  guestId: string;
  placedCount: number;
}

export interface Scoreboard {
  players: PlayerScore[];
  progress: RoomProgress;
}
