/**
 * Theme registry: the sole palette home for the Pixi board (0xRRGGBB ints, or
 * CSS color strings where a color carries alpha — the canvas can't read CSS
 * variables). CSS reads its palette from
 * `:root[data-theme=...]` blocks in globals.css; theme.test.ts pins the
 * pairing (every theme id here has a CSS block with the full var set).
 *
 * The Pixi app runs with a transparent background — the table behind it is a
 * CSS layer, so no canvas color lives here.
 */

/** Where loose pieces' shadows fall from: the evening lamp, or the morning's overcast sky. */
export type ShadowFrom = "lamp" | "overhead";

export interface BoardTheme {
  /** Dashed picture outline. */
  frameStroke: string;
  frameFill: string;
  /** The dark side face showing below a loose piece. */
  pieceSide: number;
  /** The thin light edge that keeps loose pieces visible on the wood. */
  pieceEdge: string;
  /** Opacity of a loose piece's shadow. */
  shadowAlpha: number;
  /** "lamp": shadows fall away from the lamp; "overhead": straight down and softer. */
  shadowFrom: ShadowFrom;
  /** Text on remote players' cursor name pills, which take the player's color. */
  cursorLabelText: number;
}

export interface Theme {
  id: string;
  /** Name of this light, e.g. "Rainy evening". */
  label: string;
  /** Label of the control that leaves this light for the next one, e.g. "Switch to morning". */
  switchLabel: string;
  board: BoardTheme;
}

/*
 * Two lights at the window seat: a rainy evening (the default, listed first so
 * it is also the fallback) and an overcast morning. Board values are the
 * Window Seat mock's (designs/window-seat/index.html) for each light.
 */
export const THEMES: readonly Theme[] = [
  {
    id: "evening",
    label: "Rainy evening",
    switchLabel: "Switch to morning",
    board: {
      frameStroke: "rgba(246,238,224,0.16)",
      frameFill: "rgba(255,255,255,0.025)",
      pieceSide: 0x1a1008,
      pieceEdge: "rgba(255,238,214,0.75)",
      shadowAlpha: 0.62,
      shadowFrom: "lamp",
      cursorLabelText: 0x1b1410,
    },
  },
  {
    id: "morning",
    label: "Overcast morning",
    switchLabel: "Switch to evening",
    board: {
      frameStroke: "rgba(248,242,232,0.2)",
      frameFill: "rgba(255,255,255,0.025)",
      pieceSide: 0x2a2019,
      pieceEdge: "rgba(255,238,214,0.75)",
      shadowAlpha: 0.38,
      shadowFrom: "overhead",
      cursorLabelText: 0x1b1410,
    },
  },
];

export const DEFAULT_THEME_ID = "evening";

/** Also referenced verbatim by the no-flash inline script in app/layout.tsx. */
export const THEME_STORAGE_KEY = "pwm-theme";

const THEME_EVENT = "pwm-theme-change";

/** Ids stored before the rename; layout.tsx's no-flash script maps the same pairs. */
const LEGACY_THEME_IDS: Record<string, string> = { day: "morning", night: "evening" };

export function getTheme(id: string | null): Theme {
  const current = id === null ? null : (LEGACY_THEME_IDS[id] ?? id);
  return THEMES.find((t) => t.id === current) ?? THEMES[0]!;
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
