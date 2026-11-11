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
 * One button that steps to the next light. Its label names where it will take
 * you, not where you are. Cycles rather than flips, so a third light would
 * need no change here.
 */
export function ThemeSwitch({ className }: { className?: string }) {
  const activeId = useThemeId();
  const activeIndex = THEMES.findIndex((t) => t.id === activeId);
  const next = THEMES[(activeIndex + 1) % THEMES.length]!;
  const label = THEMES[activeIndex]!.switchLabel;
  return (
    <button
      type="button"
      className={className ?? "theme-switch"}
      aria-label={label}
      onClick={() => applyTheme(next.id)}
    >
      {label}
    </button>
  );
}
