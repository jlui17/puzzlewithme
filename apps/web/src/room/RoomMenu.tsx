"use client";

import { useState } from "react";
import { useEscapeToClose } from "./escape";
import { ThemeSwitch } from "../theme-switcher";

/**
 * The pill along the table's near edge. Every label is an action ("See the
 * picture", not "The picture"). "Who did what" appears once the puzzle is
 * done and brings the finish card back.
 */
export function RoomMenu({
  imageUrl,
  playerCount,
  playersOpen,
  onTogglePlayers,
  completed,
  onShowStats,
}: {
  imageUrl: string;
  playerCount: number;
  playersOpen: boolean;
  onTogglePlayers: () => void;
  completed: boolean;
  onShowStats: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <>
      <nav className="room-menu" aria-label="Room menu">
        <button type="button" className="menu-btn" aria-label="See the picture" onClick={() => setPreviewOpen(true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M3 16l5-5 4 4 3-3 6 6" />
            <circle cx="16" cy="9" r="1.5" />
          </svg>
          <span>See the picture</span>
        </button>
        <button
          type="button"
          className="menu-btn"
          aria-label="Who's here"
          aria-expanded={playersOpen}
          aria-controls="players"
          onClick={onTogglePlayers}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="9" cy="8" r="3.5" />
            <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
            <circle cx="17" cy="9" r="2.5" />
            <path d="M16 14.5c3 0 5.5 2 5.5 5" />
          </svg>
          <span>Who&apos;s here · {playerCount}</span>
        </button>
        {completed && (
          <button type="button" className="menu-btn" aria-label="Who did what" onClick={onShowStats}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
              <path d="M9 8h6M9 12h6" />
            </svg>
            <span>Who did what</span>
          </button>
        )}
        <span className="menu-sep" aria-hidden="true" />
        <ThemeSwitch className="menu-btn" />
        <span className="menu-sep" aria-hidden="true" />
        <a href="/" className="menu-btn" aria-label="Leave the table">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10 4H5v16h5" />
            <path d="M14 8l4 4-4 4M18 12H9" />
          </svg>
          <span>Leave</span>
        </a>
      </nav>

      {previewOpen && <ImagePreviewOverlay imageUrl={imageUrl} onClose={() => setPreviewOpen(false)} />}
    </>
  );
}

/** The picture held up to the lamp, like a print. Any click or Escape puts it back down. */
function ImagePreviewOverlay({ imageUrl, onClose }: { imageUrl: string; onClose: () => void }) {
  useEscapeToClose(onClose);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="preview-print">
        {/* Full-resolution room image; next/image adds no value for a same-origin API route. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="The picture you're building" />
        <div className="preview-cap">
          <b>The picture you&apos;re building</b>
          <span>Tap anywhere to put it back down</span>
        </div>
      </div>
    </div>
  );
}
