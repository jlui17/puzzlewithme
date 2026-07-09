import { createRng } from "@puzzlewithme/geometry";
import { NAME_SALT, ROOM_CAP } from "./constants.js";

/**
 * Guest-name word lists ("EerieAcorn-J93" style). 32x32 words plus a
 * letter+2-digit suffix give ~2.7M distinct names, so a fresh draw colliding
 * with an existing identity in a room of at most dozens is practically
 * impossible (uniqueness is still enforced by the `taken` check below). Words
 * are short and family-friendly since names render publicly next to cursors.
 */
const ADJECTIVES = [
  "Amber", "Bold", "Brave", "Breezy", "Calm", "Cozy", "Dapper", "Dusty",
  "Eerie", "Fabled", "Foggy", "Gentle", "Golden", "Grand", "Happy", "Humble",
  "Jolly", "Keen", "Lively", "Lucky", "Mellow", "Merry", "Nimble", "Plucky",
  "Quiet", "Rustic", "Silver", "Sunny", "Tidy", "Vivid", "Witty", "Zesty",
] as const;

const NOUNS = [
  "Acorn", "Badger", "Beacon", "Cedar", "Comet", "Dune", "Ember", "Falcon",
  "Fern", "Grove", "Harbor", "Heron", "Juniper", "Kestrel", "Lantern", "Maple",
  "Marble", "Meadow", "Nutmeg", "Otter", "Pebble", "Pine", "Quill", "Raven",
  "Sparrow", "Thistle", "Tulip", "Walnut", "Willow", "Wren", "Yarrow", "Zephyr",
] as const;

/**
 * Per-room seeded name generator. Seeding on the room seed (with NAME_SALT)
 * makes a room's name sequence reproducible, which tests rely on and players
 * never notice. Uniqueness comes from the `taken` check, not the stream: a
 * revived room restarts the stream, so a repeat of an existing player's name
 * is possible and simply re-drawn.
 */
export function createNameGenerator(seed: string): (taken: ReadonlySet<string>) => string {
  const rng = createRng(seed, NAME_SALT);
  const pick = <T>(list: readonly T[]): T => list[rng.int(0, list.length)]!;
  return (taken) => {
    // 100 draws bounds the loop defensively; with ~2.7M names and at most a
    // few dozen identities per room, needing even one retry is unlikely.
    for (let attempt = 0; attempt < 100; attempt++) {
      const suffix = `${String.fromCharCode(65 + rng.int(0, 26))}${rng.int(0, 10)}${rng.int(0, 10)}`;
      const name = `${pick(ADJECTIVES)}${pick(NOUNS)}-${suffix}`;
      if (!taken.has(name)) return name;
    }
    // Deterministic escape hatch; unreachable unless the word lists shrink.
    let i = 0;
    let name: string;
    do {
      i += 1;
      name = `Guest-${i}`;
    } while (taken.has(name));
    return name;
  };
}

/**
 * Cursor color palette: exactly ROOM_CAP entries so every simultaneous player
 * (NFR-3 caps connected players at 20) can hold a unique color. Hues step by
 * 137° (≈ the golden angle), which keeps consecutive assignments far apart on
 * the wheel and yields 20 distinct hues (gcd(137, 360) = 1); alternating
 * lightness further separates hues that land near each other. Distinctness
 * was eyeballed for a dark board (§11 visual direction), not measured
 * perceptually.
 */
export const CURSOR_COLORS: readonly string[] = Array.from(
  { length: ROOM_CAP },
  (_, i) => `hsl(${(i * 137) % 360}, 75%, ${i % 2 === 0 ? 62 : 48}%)`,
);

/**
 * First unused palette color; identities beyond the palette size (possible
 * over a room's lifetime, since disconnected identities persist) reuse colors
 * round-robin — only 20 can be on screen at once, so visible duplicates stay
 * rare.
 */
export function assignCursorColor(used: ReadonlySet<string>, identityCount: number): string {
  for (const color of CURSOR_COLORS) {
    if (!used.has(color)) return color;
  }
  return CURSOR_COLORS[identityCount % CURSOR_COLORS.length]!;
}
