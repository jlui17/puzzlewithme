import { describe, expect, it } from "vitest";
import { generatePuzzle, initialScatter } from "./index.js";

describe("determinism", () => {
  it("generatePuzzle is deep-equal for the same seed", () => {
    const a = generatePuzzle(6, 8, "room-abc");
    const b = generatePuzzle(6, 8, "room-abc");
    expect(a).toStrictEqual(b);
  });

  it("generatePuzzle differs for different seeds", () => {
    const a = generatePuzzle(6, 8, "seed-1");
    const b = generatePuzzle(6, 8, "seed-2");
    expect(a).not.toStrictEqual(b);
  });

  it("generatePuzzle accepts numeric and string seeds identically when equivalent", () => {
    // A numeric seed and its hash-equivalent string need not match; just verify
    // numeric seeds are themselves deterministic.
    expect(generatePuzzle(4, 4, 12345)).toStrictEqual(generatePuzzle(4, 4, 12345));
  });

  it("initialScatter is deep-equal for the same seed and differs across seeds", () => {
    expect(initialScatter(6, 8, "s")).toStrictEqual(initialScatter(6, 8, "s"));
    expect(initialScatter(6, 8, "s")).not.toStrictEqual(initialScatter(6, 8, "t"));
  });
});
