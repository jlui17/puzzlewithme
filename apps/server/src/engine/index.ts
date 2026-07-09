export { HOLD_TIMEOUT_MS, NAME_SALT, ROOM_CAP } from "./constants.js";
export { CURSOR_COLORS, assignCursorColor, createNameGenerator } from "./names.js";
export { RoomEngine, type RoomEngineOptions } from "./room.js";
export type {
  DropResult,
  GrabResult,
  JoinResult,
  LeaveResult,
  MoveResult,
  MutationRejected,
  MutationRejectionReason,
  ReleasedHold,
  RenameResult,
  RoomDeviations,
  SerializedGroup,
  SerializedIdentity,
  SerializedRoomState,
} from "./types.js";
