/**
 * Theme registry: the sole palette home for the Pixi board (0xRRGGBB ints —
 * the canvas can't use CSS variables). CSS reads its palette from
 * `:root[data-theme=...]` blocks in globals.css; theme.test.ts pins the
 * pairing (every theme id here has a CSS block with the full var set).
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

/** Walnut tones for the world-space table slab (board/table-surface.ts). */
export interface WoodPalette {
  base: number;
  band: number;
  /** Canvas fill styles with alpha: the grain swatch is baked on a 2D canvas. */
  dark: string;
  light: string;
  knot: number;
  knotRing: number;
  check: number;
}

/** Colors for the loose table objects (board/table-props.ts). */
export interface PropPalette {
  notebook: number;
  notebookEdge: number;
  pages: number;
  band: number;
  pen: number;
  penHighlight: number;
  brass: number;
  pods: number;
  podsShade: number;
  coffee: number;
  crema: number;
  porcelain: number;
}

export interface Theme {
  id: string;
  /** Toggle label, e.g. "Day". */
  label: string;
  /** One glyph for the segmented day/night control. */
  emoji: string;
  board: BoardTheme;
  wood: WoodPalette;
  props: PropPalette;
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
    wood: {
      base: 0x5a3821,
      band: 0x6b4527,
      dark: "rgba(34,18,7,0.48)",
      light: "rgba(214,163,106,0.16)",
      knot: 0x231205,
      knotRing: 0x4b2d16,
      check: 0x1a0c03,
    },
    props: {
      notebook: 0x8e4536,
      notebookEdge: 0x66301f,
      pages: 0xeaddc7,
      band: 0x2f190b,
      pen: 0x1e2836,
      penHighlight: 0x3a4759,
      brass: 0xcfa860,
      pods: 0xf3ede4,
      podsShade: 0xb8ac9d,
      coffee: 0x6a4527,
      crema: 0xd6a870,
      porcelain: 0xefe3d0,
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
    wood: {
      base: 0x2e1c0d,
      band: 0x3a2412,
      dark: "rgba(5,2,0,0.58)",
      light: "rgba(176,128,78,0.1)",
      knot: 0x120802,
      knotRing: 0x2e1c0d,
      check: 0x080300,
    },
    props: {
      notebook: 0x613329,
      notebookEdge: 0x452219,
      pages: 0xb9aa93,
      band: 0x2f190b,
      pen: 0x141c27,
      penHighlight: 0x293543,
      brass: 0xcfa860,
      pods: 0xcfc5b7,
      podsShade: 0x8f8578,
      coffee: 0x6a4527,
      crema: 0xd6a870,
      porcelain: 0xc9b89e,
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
