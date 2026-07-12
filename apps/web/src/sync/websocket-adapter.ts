/**
 * Browser implementations of the injected seams (deliverable 4). This is the
 * ONLY file in the module allowed to touch browser globals (WebSocket,
 * localStorage, performance, setTimeout); the core imports the interfaces, the
 * UI imports these adapters. Keeping the globals here is what lets the core run
 * DOM-free under vitest's node environment.
 */
import type { Clock, Scheduler, SocketFactory, SyncSocket, TimerHandle, TokenStorage } from "./interfaces";

/** A SocketFactory backed by the browser WebSocket at `url`. */
export function createBrowserSocketFactory(url: string): SocketFactory {
  return () => {
    const ws = new WebSocket(url);
    const socket: SyncSocket = {
      send: (data) => ws.send(data),
      close: () => ws.close(),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    ws.onopen = () => socket.onopen?.();
    ws.onmessage = (event) =>
      socket.onmessage?.(typeof event.data === "string" ? event.data : String(event.data));
    ws.onclose = () => socket.onclose?.();
    ws.onerror = (event) => socket.onerror?.(event);
    return socket;
  };
}

export const browserClock: Clock = {
  now: () => performance.now(),
};

export const browserScheduler: Scheduler = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as TimerHandle,
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Stable localStorage key for the persistent anonymous user id. Global (not
 * per-room) so one browser is the same "person" across every room, which is
 * what the session-history list keys on.
 */
const USER_ID_KEY = "pwm:uid";

/**
 * Load the persistent anonymous user id, minting and storing one on first ever
 * visit (FR-22 stays intact: this identifies a browser, never links to a real
 * account). try/catch because private mode or disabled storage throws; a null
 * return degrades to the pre-userId flow (server falls back to resume-token
 * identity and skips session-history membership) rather than breaking the join.
 */
export function loadOrCreateUserId(): string | null {
  try {
    const existing = localStorage.getItem(USER_ID_KEY);
    if (existing !== null && existing !== "") return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(USER_ID_KEY, id);
    return id;
  } catch {
    return null;
  }
}

/**
 * TokenStorage over localStorage (FR-24). Wrapped in try/catch because a
 * browser in private mode or with storage disabled throws on access; a missing
 * token just means "first visit", which is a valid state.
 */
export function createLocalStorageTokenStorage(key: string): TokenStorage {
  return {
    load: () => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    save: (token) => {
      try {
        localStorage.setItem(key, token);
      } catch {
        // Non-persistent resume is acceptable; the player just gets a new
        // identity next visit rather than resuming (FR-24 best-effort).
      }
    },
  };
}
