"use client";

import Link from "next/link";
import { useEffect } from "react";
import { getTheme } from "../theme";
import { useThemeId } from "../theme-switcher";
import { PlayerMark } from "./PlayersPanel";

export interface Contribution {
  id: string;
  name: string;
  color: string;
  placedCount: number;
}

/**
 * The finish (§3.4, FR-25): who did what, over the finished board. Driven by
 * room status === "completed" so it covers both the live finish and loading an
 * already-done room read-only. Elapsed time is shown only when present: a
 * fresh read-only load has no completion event and the GET carries no solving
 * time, so we omit it rather than render a bogus 0:00.
 */
export function CompletionOverlay({
  elapsedMs,
  total,
  contributions,
  localGuestId,
  onClose,
}: {
  elapsedMs: number | null;
  total: number;
  contributions: Contribution[];
  localGuestId: string | null;
  /** Dismiss to reveal the read-only assembled board beneath (FR-25 "viewable"). */
  onClose: () => void;
}) {
  const light = getTheme(useThemeId()).label.toLowerCase();
  const shareBase = contributions.reduce((s, c) => s + c.placedCount, 0);
  const top = Math.max(1, ...contributions.map((c) => c.placedCount));
  const hands = contributions.length;

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="finish-card" role="dialog" aria-labelledby="finish-title">
        <button type="button" className="finish-close" aria-label="Close and look at the finished picture" onClick={onClose}>
          ×
        </button>
        <h2 id="finish-title">Finished.</h2>
        <p className="finish-sub">
          {total} pieces, {hands === 1 ? "on your own" : `${hands} of us`}, one {light}.
        </p>
        <div className="stats">
          <div className="stat">
            <div className="value">{total}</div>
            <div className="key">pieces</div>
          </div>
          {elapsedMs !== null && (
            <div className="stat">
              <div className="value">{formatElapsed(elapsedMs)}</div>
              <div className="key">at the table</div>
            </div>
          )}
          <div className="stat">
            <div className="value">{hands}</div>
            <div className="key">hands</div>
          </div>
        </div>
        {contributions.length > 0 && (
          <div className="contrib">
            {contributions.map((c) => (
              <div className="player" key={c.id} style={{ color: c.color }}>
                <PlayerMark name={c.name} color={c.color} />
                <span className="player-name">
                  {c.name}
                  {c.id === localGuestId && <span className="you">you</span>}
                </span>
                <span className="player-score">
                  {c.placedCount}
                  {shareBase > 0 ? ` · ${Math.round((c.placedCount / shareBase) * 100)}%` : ""}
                </span>
                <span className="contrib-bar">
                  <i style={{ width: `${Math.round((c.placedCount / top) * 100)}%` }} />
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="finish-actions">
          <Link className="start-btn" href="/">
            Put another one on the table
          </Link>
          <p className="finish-foot">Or close this to look at the finished picture.</p>
        </div>
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
