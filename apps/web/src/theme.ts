/**
 * Theme registry shared by CSS and the Pixi board. CSS reads the palette from
 * `:root[data-theme=...]` blocks in globals.css; the board canvas can't use CSS
 * variables, so each theme also carries its board colors here as 0xRRGGBB ints.
 * The two must stay in sync by hand: each BoardTheme mirrors the same-named
 * CSS block's background/border tones.
 */

export interface BoardTheme {
  /** Pixi Application background — the "table" the pieces scatter on. */
  canvas: number;
  /** Scatter-area rect behind the board (slightly recessed from the table). */
  well: number;
  wellAlpha: number;
  /** Board outline stroke + faint board fill tint. */
  frameStroke: number;
  /** Pill behind remote players' cursor name labels; text on it is white. */
  cursorLabelBg: number;
}

export interface Theme {
  id: string;
  /** Menu label, e.g. "Latte". */
  label: string;
  /** One emoji for compact toggles (room menu bar). */
  emoji: string;
  board: BoardTheme;
}

/*
 * Palettes picked by eye around a café-menu concept: warm low-saturation
 * neutrals, one muted accent per theme, nothing neon. Board colors sit a step
 * darker than the page background so the play area reads as a table surface,
 * with the well a step darker again. Not derived from any formula.
 */
export const THEMES: readonly Theme[] = [
  {
    id: "latte",
    label: "Latte",
    emoji: "🥛",
    board: {
      canvas: 0xede3d3,
      well: 0xe0d2bb,
      wellAlpha: 0.55,
      frameStroke: 0xc4ad8e,
      cursorLabelBg: 0x46392e,
    },
  },
  {
    id: "matcha",
    label: "Matcha",
    emoji: "🍵",
    board: {
      canvas: 0xe4ead4,
      well: 0xd6dfc0,
      wellAlpha: 0.55,
      frameStroke: 0xafbe93,
      cursorLabelBg: 0x3c4636,
    },
  },
  {
    id: "taro",
    label: "Taro",
    emoji: "🧋",
    board: {
      canvas: 0xe7e1f0,
      well: 0xdad0e9,
      wellAlpha: 0.55,
      frameStroke: 0xb5a3d2,
      cursorLabelBg: 0x453e56,
    },
  },
  {
    id: "espresso",
    label: "Espresso",
    emoji: "🌙",
    board: {
      canvas: 0x211c15,
      well: 0x17130d,
      wellAlpha: 0.6,
      frameStroke: 0x5b4c3b,
      cursorLabelBg: 0x37302a,
    },
  },
];

export const DEFAULT_THEME_ID = "latte";

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
