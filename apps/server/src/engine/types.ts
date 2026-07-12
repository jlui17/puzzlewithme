/**
 * Engine result types. Every mutating RoomEngine method returns one of these
 * plain objects; the (future) network layer translates them into the shared
 * package's ServerMessage broadcasts. Where a shared payload shape already
 * says what a result must carry (SnapResultMessage, CompletionMessage,
 * SnapshotMessage), the result embeds it verbatim so translation is a
 * pass-through.
 */
import type {
  CompletionMessage,
  GuestIdentity,
  RoomSettings,
  SnapResultMessage,
  SnapshotMessage,
} from "@puzzlewithme/shared";

/**
 * One persisted group deviating from the seeded layout (§8: "only groups
 * deviating from the initial seeded layout need storing"). Pieces are numeric
 * ids (row * cols + col), the geometry module's native currency — the wire
 * protocol's PieceCoord form is derived at the snapshot/broadcast boundary.
 * Holds are transient (§8) and never serialized.
 */
export interface SerializedGroup {
  id: string;
  pieces: number[];
  position: { x: number; y: number };
  lockedToFrame: boolean;
}

/** A guest identity plus its private resume credential (FR-24). The token never leaves the server except to its own client. */
export interface SerializedIdentity extends GuestIdentity {
  resumeToken: string;
  /** Persistent client user id this identity belongs to, when the joining client sent one; absent for pre-userId clients. */
  userId?: string;
}

/**
 * Everything a room persists beyond its immutable settings: the §8 deviation
 * record. An untouched room serializes to empty arrays and zero time.
 */
export interface RoomDeviations {
  groups: SerializedGroup[];
  /** Piece ids already credited to some player (FR-21's credit-once set). */
  creditedPieces: number[];
  identities: SerializedIdentity[];
  /** Accumulated time with at least one player connected (§8 "total active solving time"). */
  activeSolvingTimeMs: number;
}

/** The room store's unit of persistence: settings + deviations (§6.1.3). */
export interface SerializedRoomState extends RoomDeviations {
  settings: RoomSettings;
}

/**
 * Rejection reasons for mutations, named to match shared ErrorCode values
 * where one exists (room_completed, group_locked, not_holder) so the network
 * layer's translation is a lookup, not a mapping.
 */
export type MutationRejectionReason =
  | "room_completed"
  | "unknown_player"
  | "unknown_group"
  | "group_locked"
  | "not_holder";

export interface MutationRejected {
  ok: false;
  reason: MutationRejectionReason;
}

export type JoinResult =
  | {
      ok: true;
      identity: GuestIdentity;
      resumeToken: string;
      /** True when the token re-associated an existing identity (FR-24). */
      resumed: boolean;
      snapshot: SnapshotMessage;
    }
  | { ok: false; reason: "room_full" };

export type GrabResult =
  | { outcome: "granted"; groupId: string }
  | { outcome: "held_by"; groupId: string; holderId: string; holderName: string }
  | {
      outcome: "rejected";
      groupId: string;
      reason: Exclude<MutationRejectionReason, "not_holder">;
    };

export type MoveResult =
  | { ok: true; groupId: string; x: number; y: number }
  | MutationRejected;

export type DropResult =
  | {
      ok: true;
      result: SnapResultMessage;
      /** Non-null exactly when this drop locked the final piece (§7.6). */
      completion: CompletionMessage | null;
    }
  | MutationRejected;

export type RenameResult =
  | { ok: true; guestId: string; name: string }
  | MutationRejected;

/** A hold ended without a drop; feeds a GroupReleasedMessage broadcast (FR-14, §9). */
export interface ReleasedHold {
  groupId: string;
  holderId: string;
  /** The group's rest position: where the holder last moved it. */
  position: { x: number; y: number };
}

export interface LeaveResult {
  /** False when the player wasn't connected (duplicate leave is a no-op). */
  left: boolean;
  releasedHolds: ReleasedHold[];
}
