"use client";

import { useEffect, useState } from "react";
import { applyTheme, currentTheme, subscribeTheme, THEMES } from "./theme";

/**
 * Renders a stable default on the server (currentTheme() needs the DOM), then
 * syncs to the real choice after mount to avoid a hydration mismatch when
 * localStorage holds a non-default theme.
 */
export function useThemeId(): string {
  const [id, setId] = useState(THEMES[0]!.id);
  useEffect(() => {
    setId(currentTheme().id);
    return subscribeTheme(() => setId(currentTheme().id));
  }, []);
  return id;
}

/** The menu's light switch icon for each light: a moon for the evening, a cloud for the morning. */
const LIGHT_ICONS: Record<string, string> = {
  evening: "M12 3a7 7 0 1 0 9 9 8 8 0 0 1-9-9z",
  morning: "M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 2A3 3 0 0 0 7 18z",
};

/**
 * One button that steps to the next light. It shows the light you are in;
 * its accessible name also says where it takes you. Cycles rather than flips,
 * so a third light would need no change here.
 */
export function ThemeSwitch({ className }: { className?: string }) {
  const activeId = useThemeId();
  const activeIndex = THEMES.findIndex((t) => t.id === activeId);
  const active = THEMES[activeIndex]!;
  const next = THEMES[(activeIndex + 1) % THEMES.length]!;
  return (
    <button
      type="button"
      className={className ?? "theme-switch"}
      aria-label={`${active.label} now. ${active.switchLabel}.`}
      onClick={() => applyTheme(next.id)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={LIGHT_ICONS[active.id]} />
      </svg>
      <span>{active.label}</span>
    </button>
  );
}
