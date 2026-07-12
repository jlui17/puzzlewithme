/**
 * Test doubles for the injected seams. Not a test file (no *.test.ts), so it
 * never runs as a suite; imported by the colocated tests to drive fake time and
 * a fake socket. Kept out of index.ts so it isn't part of the public API.
 */
import type { Clock, Scheduler, SocketFactory, SyncSocket, TimerHandle, TokenStorage } from "./interfaces";

export class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

interface ScheduledTimer {
  callback: () => void;
  delayMs: number;
}

/** Records scheduled timers so a test fires them explicitly (no real time). */
export class FakeScheduler implements Scheduler {
  private readonly timers = new Map<number, ScheduledTimer>();
  private nextId = 1;

  setTimer(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  clearTimer(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  get pending(): number {
    return this.timers.size;
  }

  /** Fire the single pending timer (the reconnect timer is one-shot). */
  runNext(): void {
    const [id, timer] = [...this.timers.entries()][0] ?? [];
    if (id === undefined || timer === undefined) throw new Error("no pending timer");
    this.timers.delete(id);
    timer.callback();
  }

  /**
   * Fire the oldest pending timer scheduled with exactly this delay. Needed
   * once the client arms more than one recurring timer (cursor tick + heartbeat
   * watchdog): the delay identifies which one a test means to advance.
   */
  runByDelay(delayMs: number): void {
    for (const [id, timer] of this.timers) {
      if (timer.delayMs !== delayMs) continue;
      this.timers.delete(id);
      timer.callback();
      return;
    }
    throw new Error(`no pending timer with delay ${delayMs}`);
  }

  lastDelay(): number | undefined {
    return [...this.timers.values()].at(-1)?.delayMs;
  }
}

export class FakeTokenStorage implements TokenStorage {
  saved: string | null;
  loadCount = 0;
  constructor(initial: string | null = null) {
    this.saved = initial;
  }
  load(): string | null {
    this.loadCount++;
    return this.saved;
  }
  save(token: string): void {
    this.saved = token;
  }
}

/** In-memory socket: capture sent frames, drive open/message/close from a test. */
export class FakeSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }
  receive(message: unknown): void {
    this.onmessage?.(JSON.stringify(message));
  }
  /** Simulate a transport drop (server restart / network loss) without a local close() call. */
  drop(): void {
    this.closed = true;
    this.onclose?.();
  }

  /** Parsed frames the client sent, in order. */
  sentMessages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sentMessages().filter((m) => m["type"] === type);
  }
}

/** A factory that hands out fresh FakeSockets and records them for the test. */
export function fakeSocketFactory(): { factory: SocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  return { factory, sockets };
}
