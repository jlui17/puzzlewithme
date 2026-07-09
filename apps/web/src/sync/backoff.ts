/**
 * Capped exponential backoff for reconnect (§7.4, NFR-5). Pure function of the
 * attempt number; the caller schedules the delay via the injected Scheduler.
 */
export interface BackoffConfig {
  baseMs: number;
  factor: number;
  capMs: number;
  /**
   * Optional jitter source in [0, 1). When present, applies equal jitter
   * (half fixed + half random) so a server restart doesn't trigger a
   * synchronized reconnect stampede from every client at once (NFR-5). Omitted
   * in tests to keep delays deterministic; the browser adapter passes
   * Math.random.
   */
  random?: () => number;
}

/** Delay for a given zero-based retry attempt. `attempt` 0 is the first retry. */
export function backoffDelay(attempt: number, config: BackoffConfig): number {
  const capped = Math.min(config.baseMs * config.factor ** attempt, config.capMs);
  if (!config.random) return capped;
  return capped / 2 + config.random() * (capped / 2);
}
