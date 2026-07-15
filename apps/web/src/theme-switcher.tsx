"use client";

import { useEffect, useRef, useState } from "react";
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
 * Theme dropdown, shared by the menu page (opens down) and the room's bottom
 * bar (opens up, so the list isn't clipped by the viewport edge). Custom
 * popover rather than a native <select> so the options can show emoji + active
 * check and match the themed chrome on both platforms.
 */
export function ThemeDropdown({
  direction = "down",
  /** Extra class for the trigger, e.g. "room-menu-btn" to blend into the bar. */
  triggerClassName,
}: {
  direction?: "down" | "up";
  triggerClassName?: string;
}) {
  const active = useThemeId();
  const theme = THEMES.find((t) => t.id === active) ?? THEMES[0]!;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="theme-dropdown" ref={rootRef}>
      <button
        type="button"
        className={triggerClassName ?? "theme-trigger"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${theme.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{theme.emoji}</span> {theme.label}{" "}
        <span className="theme-caret" aria-hidden="true">
          {direction === "up" ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div className={`theme-menu theme-menu--${direction}`} role="menu" aria-label="Color theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className="theme-option"
              role="menuitemradio"
              aria-checked={t.id === active}
              onClick={() => {
                applyTheme(t.id);
                setOpen(false);
              }}
            >
              <span aria-hidden="true">{t.emoji}</span>
              <span className="theme-option-label">{t.label}</span>
              {t.id === active && (
                <span className="theme-option-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
