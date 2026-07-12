/**
 * Public API of the sync module. The UI imports from here: construct a
 * SyncClient with the browser adapters, subscribe to board state, drive
 * intents. The core (BoardStore, SyncClient) is DOM-free; the browser adapters
 * are re-exported for convenience but only reference globals when called.
 */
export { BoardStore } from "./board-store";
export { SyncClient } from "./sync-client";
export type { SyncClientConfig } from "./sync-client";
export { Throttle } from "./throttle";
export { backoffDelay } from "./backoff";
export type { BackoffConfig } from "./backoff";

export type {
  Clock,
  Scheduler,
  SocketFactory,
  SyncSocket,
  TimerHandle,
  TokenStorage,
} from "./interfaces";

export type {
  BoardState,
  ConnectionStatus,
  MotionSample,
  MotionState,
  RemoteCursor,
  RenderGroup,
  SyncEvent,
  Vec2,
} from "./state";

export {
  browserClock,
  browserScheduler,
  createBrowserSocketFactory,
  createLocalStorageTokenStorage,
  loadOrCreateUserId,
} from "./websocket-adapter";
