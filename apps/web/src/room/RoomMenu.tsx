"use client";

import { useEffect, useState } from "react";
import { ThemeSwitch } from "../theme-switcher";

/**
 * The tray at the bottom of the table. Every label is an action ("See the
 * picture", not "The picture"), and the players toggle says "who's here"
 * rather than "the table" — the walnut table is the background of every
 * screen, so "hide the table" read as hiding that instead of the roster.
 */
export function RoomMenu({
  imageUrl,
  playersCollapsed,
  onTogglePlayers,
  completed,
  onShowStats,
}: {
  imageUrl: string;
  playersCollapsed: boolean;
  onTogglePlayers: () => void;
  completed: boolean;
  onShowStats: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <>
      <div className="room-menu">
        <button
          type="button"
          className="room-menu-btn"
          aria-label="See the picture"
          onClick={() => setPreviewOpen(true)}
        >
          🖼️ <span className="room-menu-btn-label">See the picture</span>
        </button>
        <button
          type="button"
          className="room-menu-btn"
          aria-pressed={!playersCollapsed}
          aria-label={playersCollapsed ? "Show who's here" : "Hide who's here"}
          onClick={onTogglePlayers}
        >
          👥{" "}
          <span className="room-menu-btn-label">
            {playersCollapsed ? "Show who's here" : "Hide who's here"}
          </span>
        </button>
        {completed && (
          <button
            type="button"
            className="room-menu-btn"
            aria-label="Read the receipt"
            onClick={onShowStats}
          >
            📋 <span className="room-menu-btn-label">Read the receipt</span>
          </button>
        )}
        <div className="room-menu-sep" aria-hidden="true" />
        <ThemeSwitch className="room-menu-btn" />
        <div className="room-menu-sep" aria-hidden="true" />
        <a href="/" className="room-menu-btn" aria-label="Head out">
          🏠 <span className="room-menu-btn-label">Head out</span>
        </a>
      </div>

      {previewOpen && (
        <ImagePreviewOverlay imageUrl={imageUrl} onClose={() => setPreviewOpen(false)} />
      )}
    </>
  );
}

function ImagePreviewOverlay({ imageUrl, onClose }: { imageUrl: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="image-preview-overlay" onClick={onClose}>
      <div className="image-preview-mat">
        {/* Full-resolution room image; next/image adds no value for a same-origin API route. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="Full puzzle image" />
        <div className="image-preview-cap">
          <span className="script">what you&apos;re building</span>
          <span>tap anywhere to put it back down</span>
        </div>
      </div>
    </div>
  );
}
