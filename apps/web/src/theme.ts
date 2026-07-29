/**
 * Theme registry shared by CSS and the Pixi board. CSS reads the palette from
 * `:root[data-theme=...]` blocks in globals.css; the board canvas can't use CSS
 * variables, so each theme also carries its board colors here as 0xRRGGBB ints.
 * The two must stay in sync by hand: each BoardTheme mirrors the same-named
 * CSS block's mat/border tones.
 *
 * The Pixi app runs with a transparent background — the walnut table behind it
 * is a CSS layer (.table in globals.css), so no canvas color lives here.
 */

/**
 * The two tones a linen thread is drawn from. Canvas fill styles, not Pixi
 * ints, because the weave is baked to a texture on a 2D canvas (board/linen.ts)
 * — they carry alpha, and they sit over `mat` rather than replacing it.
 */
export interface LinenWeave {
  /** Between the threads. */
  shadow: string;
  /** The lit side of each thread. */
  highlight: string;
}

export interface BoardTheme {
  /** Linen mat the puzzle is laid out on, over the table. */
  mat: number;
  matAlpha: number;
  weave: LinenWeave;
  /** Dashed stitch line inset from the mat's hem. */
  stitch: number;
  /** Board outline stroke + faint board fill tint. */
  frameStroke: number;
  /** Text on remote players' cursor name pills, which take the player's color. */
  cursorLabelText: number;
}

export interface Theme {
  id: string;
  /** Toggle label, e.g. "Day". */
  label: string;
  /** One glyph for the segmented day/night control. */
  emoji: string;
  board: BoardTheme;
}

/*
 * Two lights on one café table: daylight and lamplight. Mat and stroke mirror
 * the linen-mat colors the design draws on the walnut (globals.css .table),
 * a step lighter than the wood so the play area reads as cloth on furniture.
 */
export const THEMES: readonly Theme[] = [
  {
    id: "day",
    label: "Day",
    emoji: "☀",
    board: {
      mat: 0xdccaa4,
      matAlpha: 1,
      weave: { shadow: "rgba(150,124,84,0.16)", highlight: "rgba(255,247,230,0.18)" },
      stitch: 0x78603c,
      frameStroke: 0x5a4426,
      cursorLabelText: 0xfff8ef,
    },
  },
  {
    id: "night",
    label: "Night",
    emoji: "☾",
    board: {
      mat: 0x8e7d5f,
      matAlpha: 1,
      weave: { shadow: "rgba(30,20,8,0.22)", highlight: "rgba(255,235,200,0.07)" },
      stitch: 0x281c0c,
      frameStroke: 0x1e1408,
      cursorLabelText: 0x12202f,
    },
  },
];

export const DEFAULT_THEME_ID = "day";

/** Also referenced verbatim by the no-flash inline script in app/layout.tsx. */
export const THEME_STORAGE_KEY = "pwm-theme";

const THEME_EVENT = "pwm-theme-change";

export function getTheme(id: string | null): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/** The active theme, from the DOM attribute the no-flash script / applyTheme set. */
export function currentTheme(): Theme {
  if (typeof document === "undefined") return getTheme(DEFAULT_THEME_ID);
  return getTheme(document.documentElement.dataset["theme"] ?? null);
}

export function applyTheme(id: string): void {
  const theme = getTheme(id);
  document.documentElement.dataset["theme"] = theme.id;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme.id);
  } catch {
    // Persistence is a convenience; private browsing just resets on reload.
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT));
}

/** Notifies on applyTheme; returns an unsubscribe. The board uses this to repaint. */
export function subscribeTheme(listener: () => void): () => void {
  window.addEventListener(THEME_EVENT, listener);
  return () => window.removeEventListener(THEME_EVENT, listener);
}
