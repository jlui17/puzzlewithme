/**
 * Seeded PRNG for the deterministic puzzle core (§6.1.5). Client and server
 * must produce bit-identical geometry from the same seed, so every random
 * value flows through this generator and nothing here may call Math.random,
 * Date.now, or any I/O.
 *
 * Engine-identity: mulberry32 and the xmur3 string hash use only integer and
 * bitwise ops (Math.imul, >>>, ^, |0). These are specified by ECMAScript to
 * produce the same result on every conforming engine, so V8 (Node/Chrome) and
 * the client's JS engine can't diverge. We deliberately avoid deriving any
 * geometry from Math.sin / Math.pow / other transcendental functions, whose
 * last-ULP results are not guaranteed identical across engines.
 */

/**
 * xmur3: hash a string seed to a uint32. Room seeds are unguessable strings
 * (RoomSettings.seed), but mulberry32 needs a 32-bit integer, so we fold the
 * string down deterministically. A plain `number` seed is coerced to uint32
 * directly (fractional/large values fold via `>>> 0`).
 */
export function hashSeed(seed: string | number): number {
  if (typeof seed === "number") {
    return seed >>> 0;
  }
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A deterministic random source. Each method advances the internal state. */
export interface Rng {
  /** Uniform float in [0, 1). */
  float(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number;
  /** Fair coin. */
  bool(): boolean;
}

/**
 * Create an Rng from a seed and an optional `salt`. The salt lets independent
 * phases (edge shapes vs. scatter) draw from decorrelated streams derived from
 * the one room seed, so changing one phase's consumption order can't shift the
 * other. 2654435761 is Knuth's multiplicative-hash constant (2^32 / golden
 * ratio), chosen because it spreads sequential salt values across the 32-bit
 * space well; the exact constant only needs to be stable, not optimal.
 */
export function createRng(seed: string | number, salt = 0): Rng {
  let a = (hashSeed(seed) ^ Math.imul(salt >>> 0, 2654435761)) >>> 0;
  const float = (): number => {
    // mulberry32.
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float,
    range: (min, max) => min + float() * (max - min),
    int: (minInclusive, maxExclusive) =>
      minInclusive + Math.floor(float() * (maxExclusive - minInclusive)),
    bool: () => float() < 0.5,
  };
}

/** In-place Fisher-Yates shuffle driven by an Rng (deterministic given the Rng). */
export function shuffleInPlace<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i + 1);
    const a = items[i]!;
    const b = items[j]!;
    items[i] = b;
    items[j] = a;
  }
  return items;
}
