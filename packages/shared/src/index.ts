// apps/web's placeholder page imports this to prove workspace resolution
// works; kept alongside the real protocol API until that placeholder goes.
export const PACKAGE_NAME = "@puzzlewithme/shared";

export type {
  Group,
  GuestIdentity,
  PieceCoord,
  PlayerScore,
  RoomProgress,
  RoomSettings,
  RoomStatus,
  Scoreboard,
} from "./state.js";
export { singletonGroupId } from "./state.js";

export type {
  ClientMessage,
  CursorMessage,
  DropMessage,
  GrabMessage,
  JoinMessage,
  MoveMessage,
  PingMessage,
  RenameMessage,
} from "./client-messages.js";
export {
  clientMessageSchema,
  cursorMessageSchema,
  dropMessageSchema,
  grabMessageSchema,
  joinMessageSchema,
  MAX_NAME_LENGTH,
  moveMessageSchema,
  renameMessageSchema,
} from "./client-messages.js";

export type {
  CompletionMessage,
  CursorBroadcastMessage,
  ErrorCode,
  ErrorMessage,
  GrabResultMessage,
  GroupHeldMessage,
  GroupMovedMessage,
  GroupReleasedMessage,
  JoinedMessage,
  PongMessage,
  PresenceMessage,
  RoomFullMessage,
  ScoreCredit,
  ServerMessage,
  SnapResultMessage,
  SnapshotMessage,
} from "./server-messages.js";

export type { ParseClientMessageResult } from "./validation.js";
export { parseClientMessage } from "./validation.js";
