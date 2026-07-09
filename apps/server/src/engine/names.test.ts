import { describe, expect, it } from "vitest";
import { ROOM_CAP } from "./constants.js";
import { CURSOR_COLORS, assignCursorColor, createNameGenerator } from "./names.js";

describe("createNameGenerator", () => {
  it("produces adjective+noun-suffix names", () => {
    const next = createNameGenerator("seed-a");
    for (let i = 0; i < 50; i++) {
      expect(next(new Set())).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+-[A-Z][0-9]{2}$/);
    }
  });

  it("is deterministic per seed and differs across seeds", () => {
    const a1 = createNameGenerator("seed-a")(new Set());
    const a2 = createNameGenerator("seed-a")(new Set());
    const b = createNameGenerator("seed-b")(new Set());
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("never returns a taken name", () => {
    const next = createNameGenerator("seed-a");
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const name = next(taken);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });
});

describe("cursor colors", () => {
  it("provides one distinct color per possible simultaneous player", () => {
    expect(CURSOR_COLORS).toHaveLength(ROOM_CAP);
    expect(new Set(CURSOR_COLORS).size).toBe(ROOM_CAP);
  });

  it("assigns the first unused color, then reuses round-robin once exhausted", () => {
    expect(assignCursorColor(new Set(), 0)).toBe(CURSOR_COLORS[0]);
    expect(assignCursorColor(new Set([CURSOR_COLORS[0]!]), 1)).toBe(CURSOR_COLORS[1]);
    const all = new Set(CURSOR_COLORS);
    expect(assignCursorColor(all, ROOM_CAP + 3)).toBe(CURSOR_COLORS[3]);
  });
});
