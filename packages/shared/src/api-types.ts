/**
 * Wire types for the REST API (room creation, session history, gallery,
 * profile). Owned here so the server's handlers and the web client's api
 * module type the same shapes and drift is a tsc error.
 */
import type { RoomSettings, RoomStatus } from "./state.js";

/**
 * Caps a user-chosen session name (PATCH …/rooms/:roomId). 80 chars fits any
 * reasonable title on one list row while bounding what a malicious client can
 * store; picked to match the room list UI, not measured.
 */
export const MAX_ROOM_NAME_LENGTH = 80;

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

/** GET /api/rooms/:roomId — existence probe + the settings a client joins with. */
export interface RoomInfoResponse {
  exists: true;
  status: RoomStatus;
  settings: RoomSettings;
}
