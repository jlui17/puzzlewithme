import { describe, expect, it } from "vitest";
import { MOCK_UNIT } from "./constants";
import { shadowOffset } from "./shadow";

const LAMP = { x: 500, y: -220 };

describe("shadowOffset", () => {
  it("falls away from the lamp: left of it to the left, right of it to the right", () => {
    const left = shadowOffset("lamp", { x: 100, y: 300 }, LAMP, 1);
    const right = shadowOffset("lamp", { x: 900, y: 300 }, LAMP, 1);
    expect(left.x).toBeLessThan(0);
    expect(right.x).toBeGreaterThan(0);
    expect(left.y).toBeGreaterThan(0);
    expect(right.y).toBeCloseTo(left.y);
  });

  it("grows 1 unit per 200 px of distance from the lamp, on top of 3 units", () => {
    // Straight below the lamp, 400 px away: 3 + 2 units, pointing down.
    const o = shadowOffset("lamp", { x: 500, y: 180 }, LAMP, 1);
    expect(o.x).toBeCloseTo(0);
    expect(o.y).toBeCloseTo(5 * MOCK_UNIT);
  });

  it("drops straight down under the overcast sky, wherever the piece is", () => {
    expect(shadowOffset("overhead", { x: 100, y: 300 }, LAMP, 1)).toEqual({ x: 0, y: 3 * MOCK_UNIT });
    expect(shadowOffset("overhead", { x: 900, y: 0 }, LAMP, 1)).toEqual({ x: 0, y: 3 * MOCK_UNIT });
  });

  it("stretches with lift", () => {
    const resting = shadowOffset("lamp", { x: 100, y: 300 }, LAMP, 1);
    const held = shadowOffset("lamp", { x: 100, y: 300 }, LAMP, 2.6);
    expect(held.x).toBeCloseTo(resting.x * 2.6);
    expect(held.y).toBeCloseTo(resting.y * 2.6);
  });
});
