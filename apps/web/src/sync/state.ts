/**
 * The renderer-agnostic board state (deliverable 1). Plain data behind a
 * subscribe/notify store (board-store.ts); a later PixiJS layer and the tests
 * both read it via getState(). Maps (not arrays) key groups/players/cursors by
 * id so event application is O(1) and the renderer can diff by key.
 */
import type {
  ErrorCode,
  GuestIdentity,
  PieceCoord,
  RoomSettings,
  RoomStatus,
  Scoreboard,
} from "@puzzlewithme/shared";

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * A group as the renderer consumes it: the shared `Group` shape with
 * `lockedToFrame` flattened to `locked` and `heldBy` carrying a guest id (or
 * null). Untouched groups are derived from the seed's scatter; deviations come
 * from the snapshot and the live event stream.
 */
export interface RenderGroup {
  id: string;
  pieces: PieceCoord[];
  position: Vec2;
  locked: boolean;
  /** Guest id holding this group, or null. Locally set optimistically during a drag. */
  heldBy: string | null;
}

/** Another player's live cursor (FR-17). Ephemeral, never persisted (§6.2). */
export interface RemoteCursor {
  guestId: string;
  x: number;
  y: number;
}

/** One position sample with the local clock time it was received. */
export interface MotionSample {
  position: Vec2;
  timestamp: number;
}

/**
 * Motion smoothing support (deliverable 3, extended to cursors): the latest
 * relayed target plus the previous sample, timestamped on the local clock, for
 * either a remotely-held group or another player's cursor. The renderer
 * interpolates `previous`→`current` over the sample gap so relayed motion
 * looks continuous (NFR-2) at either source's send rate; this module never
 * renders.
 */
export interface MotionState {
  current: MotionSample;
  previous: MotionSample | null;
}

/**
 * Connection lifecycle as the UI sees it. Distinct from the room's play
 * `status`: a room can be `active` while the socket is `reconnecting`.
 */
export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "room_full";

export interface BoardState {
  connection: ConnectionStatus;
  /** Room play status (§8): active or permanently completed (FR-25). */
  status: RoomStatus;
  settings: RoomSettings | null;
  /** This browser's guest id once joined; null before the first `joined`. */
  localGuestId: string | null;
  groups: Map<string, RenderGroup>;
  /** Players currently present (FR-18), keyed by guest id. */
  players: Map<string, GuestIdentity>;
  /** Authoritative scores + room progress (FR-20); the single source for counts. */
  scoreboard: Scoreboard;
  cursors: Map<string, RemoteCursor>;
  /** Interpolation samples for remotely-held groups (deliverable 3). */
  motion: Map<string, MotionState>;
  /** Interpolation samples for other players' cursors, keyed by guest id (mirrors `motion`). */
  cursorMotion: Map<string, MotionState>;
  /** Set once on the completion event (§7.6); null while playing. */
  completion: { totalActiveSolvingTimeMs: number } | null;
}

/**
 * Transient notifications that aren't part of the board snapshot: a grab the
 * server refused (surfacing the holder's name, FR-9), a server error, room-full
 * (NFR-3), and completion. Delivered via SyncClient.onEvent, separate from the
 * state subscription because they're one-shot signals, not durable state.
 */
export type SyncEvent =
  | { type: "grab_rejected"; groupId: string; holderName: string }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "room_full" }
  | { type: "completion"; totalActiveSolvingTimeMs: number };
