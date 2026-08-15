import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { THEMES } from "./theme";

/**
 * Pins the pairing between the theme registry and globals.css: the CSS blocks
 * are hand-written (no generation), so this is what keeps a new theme from
 * shipping without its CSS half, or a renamed var from drifting between blocks.
 */

const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");

/** CSS custom-property names declared in rules selected by [data-theme="<id>"], per id. */
function themeVars(source: string): Map<string, Set<string>> {
  const vars = new Map<string, Set<string>>();
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of source.matchAll(rule)) {
    const selector = match[1]!;
    const body = match[2]!;
    const ids = [...selector.matchAll(/data-theme="([a-z0-9-]+)"/g)].map((m) => m[1]!);
    if (ids.length === 0) continue;
    for (const id of ids) {
      const set = vars.get(id) ?? new Set<string>();
      for (const declaration of body.matchAll(/--([a-z0-9-]+)\s*:/g)) set.add(declaration[1]!);
      vars.set(id, set);
    }
  }
  return vars;
}

describe("theme/CSS parity", () => {
  const cssThemes = themeVars(css);

  it("every registered theme has a [data-theme] CSS block", () => {
    for (const theme of THEMES) {
      expect(cssThemes.has(theme.id), `globals.css has no [data-theme="${theme.id}"] block`).toBe(true);
    }
  });

  it("every CSS theme block is registered", () => {
    for (const id of cssThemes.keys()) {
      expect(
        THEMES.some((t) => t.id === id),
        `globals.css styles [data-theme="${id}"] but THEMES has no such theme`,
      ).toBe(true);
    }
  });

  it("all themes declare the same CSS variable set", () => {
    const [first, ...rest] = THEMES;
    const reference = cssThemes.get(first!.id)!;
    for (const theme of rest) {
      const own = cssThemes.get(theme.id)!;
      const missing = [...reference].filter((v) => !own.has(v));
      const extra = [...own].filter((v) => !reference.has(v));
      expect(missing, `vars in ${first!.id} but not ${theme.id}`).toEqual([]);
      expect(extra, `vars in ${theme.id} but not ${first!.id}`).toEqual([]);
    }
  });
});
