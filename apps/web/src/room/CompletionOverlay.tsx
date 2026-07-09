"use client";

import Link from "next/link";

export interface Contribution {
  name: string;
  color: string;
  placedCount: number;
}

/**
 * Completion moment (§3.4, FR-25). Driven by room status === "completed" so it
 * covers both the live finish and loading an already-done room read-only. Elapsed
 * time is shown only when present: a fresh read-only load has no completion event
 * and the GET carries no solving time (advisor note), so we omit it rather than
 * render a bogus 0:00.
 */
export function CompletionOverlay({
  imageUrl,
  elapsedMs,
  total,
  contributions,
  onClose,
}: {
  imageUrl: string;
  elapsedMs: number | null;
  total: number;
  contributions: Contribution[];
  /** Dismiss to reveal the read-only assembled board beneath (FR-25 "viewable"). */
  onClose: () => void;
}) {
  const shareBase = contributions.reduce((s, c) => s + c.placedCount, 0);
  return (
    <div className="completion-overlay">
      <div className="completion-card">
        <button className="overlay-close" onClick={onClose} aria-label="View the board">
          ×
        </button>
        <h2>Puzzle complete</h2>
        <p className="sub">Every piece is placed.</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="full-image" src={imageUrl} alt="The completed puzzle" />
        <div className="stat-row">
          <div className="stat">
            <div className="value">{total}</div>
            <div className="key">Pieces</div>
          </div>
          {elapsedMs !== null && (
            <div className="stat">
              <div className="value">{formatElapsed(elapsedMs)}</div>
              <div className="key">Active time</div>
            </div>
          )}
          <div className="stat">
            <div className="value">{contributions.length}</div>
            <div className="key">Players</div>
          </div>
        </div>
        {contributions.length > 0 && (
          <div className="contrib-list">
            {contributions.map((c, i) => (
              <div className="contrib-row" key={i}>
                <span className="player-dot" style={{ background: c.color }} />
                <span className="player-name">{c.name}</span>
                <span className="player-score">
                  {c.placedCount}
                  {shareBase > 0 ? ` · ${Math.round((c.placedCount / shareBase) * 100)}%` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
        <Link className="new-room" href="/">
          Create a new puzzle
        </Link>
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
