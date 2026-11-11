"use client";

import { applyTheme, THEMES } from "../theme";
import { useThemeId } from "../theme-switcher";

const LAMP_LABELS: Record<string, string> = {
  evening: "Switch the light. It is a rainy evening now.",
  morning: "Switch the light. It is an overcast morning now.",
};

/** The window sill with the lamp and a plant on it, and the strip of wall below it down to the table. */
export function Sill() {
  return (
    <>
      <div className="sill">
        <div className="lamp-glow" aria-hidden="true" />
        <Lamp />
        <Plant />
      </div>
      <div className="wall" aria-hidden="true" />
    </>
  );
}

/** The lamp is the light switch: pressing it changes the room to the next light. */
function Lamp() {
  const activeId = useThemeId();
  const activeIndex = THEMES.findIndex((t) => t.id === activeId);
  const active = THEMES[activeIndex]!;
  const next = THEMES[(activeIndex + 1) % THEMES.length]!;
  return (
    <button type="button" className="lamp" aria-label={LAMP_LABELS[active.id]} onClick={() => applyTheme(next.id)}>
      <svg viewBox="0 0 150 178">
        <use href="#lamp-shape" />
      </svg>
      <span className="light-label">
        <b>{active.label}</b>
        <i>·</i>
        {active.switchLabel}
      </span>
    </button>
  );
}

function Plant() {
  return (
    <div className="plant" aria-hidden="true">
      <svg viewBox="0 0 50 58">
        <ellipse cx="26" cy="55" rx="18" ry="3.5" fill="rgba(0,0,0,.5)" filter="url(#soft)" />
        <path d="M25 34 C 14 30, 8 20, 12 8 C 20 12, 26 22, 25 34 Z" fill="var(--leaf)" />
        <path d="M26 34 C 36 30, 44 22, 42 10 C 33 14, 27 24, 26 34 Z" fill="var(--leaf)" opacity=".85" />
        <path d="M25 36 C 24 26, 27 16, 30 12 C 32 20, 30 30, 26 36 Z" fill="var(--leaf)" opacity=".7" />
        <path d="M13 34 H37 L34 54 H16 Z" fill="var(--pot)" />
        <rect x="11" y="32" width="28" height="5" rx="1.5" fill="var(--pot)" />
        <path d="M13 34 H20 L18 54 H16 Z" fill="rgba(255,255,255,.08)" />
      </svg>
    </div>
  );
}
