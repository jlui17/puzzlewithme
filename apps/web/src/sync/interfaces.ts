/**
 * Injected-dependency seams for the sync module. Everything the core needs
 * from the outside world (a socket, a clock, a timer, token persistence) is
 * an interface here so the core stays DOM-free and framework-free (SPEC §6.1):
 * tests pass fakes, the UI passes the browser adapters in websocket-adapter.ts.
 */

/**
 * A duplex text channel to the game server (§6.1.2 requires a persistent
 * bidirectional channel). Modeled on the browser WebSocket callback surface so
 * the adapter is a thin pass-through, but with no WebSocket types leaking into
 * the core. A fresh instance is created per connection attempt (see
 * SocketFactory) so auto-reconnect never reuses a dead socket.
 */
export interface SyncSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onerror: ((error?: unknown) => void) | null;
}

/** Creates a new, not-yet-open socket per call so reconnect gets a clean one. */
export type SocketFactory = () => SyncSocket;

/**
 * Monotonic millisecond clock used for throttle token buckets. Injected (rather
 * than calling performance.now directly) so tests drive throttling with fake
 * time; the browser adapter supplies performance.now.
 */
export interface Clock {
  now(): number;
}

/** Opaque timer handle; the concrete type is the scheduler's business. */
export type TimerHandle = unknown;

/**
 * One-shot timer seam for reconnect backoff (§7.4). Injected instead of using
 * setTimeout so tests advance reconnect timing deterministically with fake time
 * (SPEC: "no bare setInterval").
 */
export interface Scheduler {
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

/**
 * Persistence for the resume token (FR-24): the server issues one on join and
 * the same browser replays it to resume its guest identity. Injected so the
 * core never touches localStorage; the browser adapter wraps it.
 */
export interface TokenStorage {
  load(): string | null;
  save(token: string): void;
}
