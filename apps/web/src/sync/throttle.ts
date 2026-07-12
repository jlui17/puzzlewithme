/**
 * Leading-edge token bucket over an injected clock (deliverable 2's throttle
 * requirement). `tryEmit(now)` returns true at most once per `intervalMs`
 * window and records the emit time; callers pass clock.now() so tests use fake
 * time. No timers, no setInterval.
 *
 * Leading-edge (emit the first call in a window, drop the rest) is safe for
 * drag moves because the authoritative position always reconciles regardless
 * of whether the last in-burst sample was relayed: a drop's final position
 * comes back via snap_result broadcast to every client (§7.3 step 5). So
 * dropping the trailing sample costs at most one frame of staleness on a
 * remote view, never a divergent placement (NFR-6).
 *
 * Cursor relaying does not use this class: it runs on its own fixed timer
 * (SyncClient.cursorTick) decoupled from mousemove entirely, so it needs no
 * per-call gating.
 */
export class Throttle {
  private lastEmit = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs: number) {}

  tryEmit(now: number): boolean {
    if (now - this.lastEmit >= this.intervalMs) {
      this.lastEmit = now;
      return true;
    }
    return false;
  }

  /** Clear the bucket so the next tryEmit fires immediately (call at drag start). */
  reset(): void {
    this.lastEmit = Number.NEGATIVE_INFINITY;
  }
}
