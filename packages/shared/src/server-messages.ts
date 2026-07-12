/**
 * Server→client event messages (§6.2, §7). The server is the sole writer of
 * room state (§6.1.2); every message here is either a snapshot of that state
 * or a broadcast outcome of a state mutation. Unlike client messages, these
 * cross a trusted boundary (the server producing them), so they're plain
 * types rather than zod schemas — nothing here needs runtime validation on
 * the client, which is free to trust its own server.
 */
import type { Group, GuestIdentity, PieceCoord, RoomSettings, Scoreboard } from "./state.js";

/** Sent once, immediately after a successful `join` intent (§7.2). */
export interface JoinedMessage {
  type: "joined";
  identity: GuestIdentity;
  /** Opaque token the client stores and replays on a future `join` to resume this identity (FR-24). */
  resumeToken: string;
}

/**
 * Full state snapshot sent on join/resume (§7.2). `groups` carries every
 * group worth transmitting: anything deviating from the seeded initial
 * layout (§8 — "only groups deviating from the initial seeded layout need
 * storing") plus any group currently held (holding is itself a deviation
 * worth showing immediately, even before a drop). An untouched room sends
 * an empty `groups` array; the client derives the rest of the board from
 * the seed via the geometry module.
 */
export interface SnapshotMessage {
  type: "snapshot";
  settings: RoomSettings;
  groups: Group[];
  scoreboard: Scoreboard;
  players: GuestIdentity[];
}

/**
 * Outcome of a `grab` intent (FR-9: first grab wins). Both variants share
 * `type: "grab_result"`; callers switch on the nested `outcome` field.
 */
export type GrabResultMessage =
  | { type: "grab_result"; groupId: string; outcome: "granted" }
  | { type: "grab_result"; groupId: string; outcome: "held_by"; holderName: string };

/**
 * Relayed holder motion (§6.2: "the one relaxed path" — the server relays
 * positions without evaluating them; correctness is only checked at drop).
 */
export interface GroupMovedMessage {
  type: "group_moved";
  groupId: string;
  x: number;
  y: number;
}

/**
 * A `mergedGroupIds` entry (its pieces, position, and lock state) never
 * needs re-derivation on the client, so pieces credit for it is also final.
 */
export interface ScoreCredit {
  guestId: string;
  piecesCredited: number;
}

/**
 * Authoritative outcome of a `drop` intent (FR-11, §7.3 step 4). Carries the
 * fully resolved post-drop state for the one group a drop can ever produce
 * (the dropped group plus everything it merged with in this single
 * evaluation), so a client applies it directly: remove every id in
 * `mergedGroupIds` (and `droppedGroupId` if it differs from `group.id`) from
 * local state, then upsert `group`. No snap-tolerance or neighbor logic is
 * ever re-run on the client.
 */
export interface SnapResultMessage {
  type: "snap_result";
  /** The group id the client used when it sent the `drop` intent, so it can find its optimistic local copy even if the id didn't survive the merge. */
  droppedGroupId: string;
  group: {
    id: string;
    pieces: PieceCoord[];
    position: { x: number; y: number };
    lockedToFrame: boolean;
  };
  /** Other groups' ids absorbed into `group` by this drop (empty if nothing merged). */
  mergedGroupIds: string[];
  scoreCredits: ScoreCredit[];
  progress: Scoreboard["progress"];
}

/**
 * Broadcast when a grab is granted, so every player can see who is holding a
 * group (FR-19). The grabber additionally gets a GrabResultMessage; this is
 * the room-wide attribution.
 */
export interface GroupHeldMessage {
  type: "held";
  groupId: string;
  /** Guest identity id of the holder. */
  playerId: string;
}

/**
 * Broadcast when a hold ends WITHOUT a drop evaluation: holder disconnected
 * (FR-14, §7.4) or idled past the hold timeout (§9). A normal drop's release
 * is implied by its SnapResultMessage instead. Carries the group's rest
 * position (its last relayed position) so a client that missed the final
 * group_moved still converges (NFR-6).
 */
export interface GroupReleasedMessage {
  type: "released";
  groupId: string;
  x: number;
  y: number;
}

/** Another player's live cursor position (FR-17). */
export interface CursorBroadcastMessage {
  type: "cursor";
  guestId: string;
  x: number;
  y: number;
}

/** Player-list changes (FR-18). */
export type PresenceMessage =
  | { type: "presence"; event: "joined"; player: GuestIdentity }
  | { type: "presence"; event: "left"; guestId: string }
  | { type: "presence"; event: "renamed"; guestId: string; name: string };

/** Sent once, when a drop locks the final piece (§7.6, §3.4). */
export interface CompletionMessage {
  type: "completion";
  scoreboard: Scoreboard;
  totalActiveSolvingTimeMs: number;
}

/** Sent instead of `joined` when a room is already at NFR-3's player cap. */
export interface RoomFullMessage {
  type: "room_full";
}

/**
 * Codes map directly to the untrusted-client rejections NFR-7 calls out
 * (locked-group moves, drops by non-holders, malformed events) plus the
 * join-time failures §9 lists (bad room id, room already full) and mutations
 * attempted on a completed, read-only room (FR-25).
 */
export type ErrorCode =
  | "invalid_message"
  | "room_not_found"
  | "room_full"
  | "room_completed"
  | "group_locked"
  | "not_holder"
  | "internal";

export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
}

/** Reply to a client `ping` (§7.4). Carries no payload; its arrival is the signal — it proves the client's receive path is still alive so its heartbeat watchdog stays fed. */
export interface PongMessage {
  type: "pong";
}

export type ServerMessage =
  | JoinedMessage
  | SnapshotMessage
  | GrabResultMessage
  | GroupMovedMessage
  | GroupHeldMessage
  | GroupReleasedMessage
  | SnapResultMessage
  | CursorBroadcastMessage
  | PresenceMessage
  | CompletionMessage
  | RoomFullMessage
  | ErrorMessage
  | PongMessage;
