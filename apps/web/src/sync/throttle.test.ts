import { describe, expect, it } from "vitest";
import { backoffDelay } from "./backoff";
import { Throttle } from "./throttle";

describe("Throttle", () => {
  it("emits on the first call, then suppresses until the window elapses", () => {
    const t = new Throttle(100);
    expect(t.tryEmit(0)).toBe(true);
    expect(t.tryEmit(50)).toBe(false);
    expect(t.tryEmit(99)).toBe(false);
    expect(t.tryEmit(100)).toBe(true); // exactly one window later
    expect(t.tryEmit(150)).toBe(false);
  });

  it("reset() lets the next call emit immediately", () => {
    const t = new Throttle(100);
    expect(t.tryEmit(0)).toBe(true);
    expect(t.tryEmit(10)).toBe(false);
    t.reset();
    expect(t.tryEmit(10)).toBe(true);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and caps", () => {
    const cfg = { baseMs: 500, factor: 2, capMs: 15_000 };
    expect(backoffDelay(0, cfg)).toBe(500);
    expect(backoffDelay(1, cfg)).toBe(1000);
    expect(backoffDelay(2, cfg)).toBe(2000);
    expect(backoffDelay(10, cfg)).toBe(15_000); // capped
  });

  it("applies equal jitter within [delay/2, delay] when a random source is given", () => {
    const cfg = { baseMs: 1000, factor: 2, capMs: 15_000 };
    expect(backoffDelay(0, { ...cfg, random: () => 0 })).toBe(500);
    expect(backoffDelay(0, { ...cfg, random: () => 0.5 })).toBe(750);
    expect(backoffDelay(0, { ...cfg, random: () => 0.999 })).toBeCloseTo(999.5, 1);
  });
});
