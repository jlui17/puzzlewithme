"use client";

import { useEffect, useState } from "react";
import { applyTheme, currentTheme, subscribeTheme, THEMES } from "./theme";

/**
 * Renders a stable default on the server (currentTheme() needs the DOM), then
 * syncs to the real choice after mount to avoid a hydration mismatch when
 * localStorage holds a non-default theme.
 */
function useThemeId(): string {
  const [id, setId] = useState(THEMES[0]!.id);
  useEffect(() => {
    setId(currentTheme().id);
    return subscribeTheme(() => setId(currentTheme().id));
  }, []);
  return id;
}

/**
 * One button that steps to the next light. It shows where it will take you
 * rather than where you are, so the glyph and the label say the same thing —
 * which matters in the phone tray, where the label is dropped. Cycles rather
 * than flips, so a third light would need no change here.
 */
export function ThemeSwitch({ className }: { className?: string }) {
  const active = useThemeId();
  const next = THEMES[(THEMES.findIndex((t) => t.id === active) + 1) % THEMES.length]!;
  const label = `Switch to ${next.label.toLowerCase()}`;
  return (
    <button
      type="button"
      className={className ?? "theme-switch"}
      aria-label={label}
      onClick={() => applyTheme(next.id)}
    >
      <span aria-hidden="true">{next.emoji}</span>{" "}
      <span className="theme-switch-label">{label}</span>
    </button>
  );
}
