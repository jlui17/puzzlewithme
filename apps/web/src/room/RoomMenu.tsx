"use client";

import { useEffect, useState } from "react";
import { ThemeDropdown } from "../theme-switcher";

/**
 * Bottom-center menu bar for the room screen: full-image preview, players
 * panel toggle, stats re-open (only once the room is completed), and a link
 * back to the main menu (create, session history, identity).
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
        <button type="button" className="room-menu-btn" onClick={() => setPreviewOpen(true)}>
          🖼️ Preview
        </button>
        <button
          type="button"
          className="room-menu-btn"
          aria-pressed={!playersCollapsed}
          onClick={onTogglePlayers}
        >
          👥 {playersCollapsed ? "Show players" : "Hide players"}
        </button>
        {completed && (
          <button type="button" className="room-menu-btn" onClick={onShowStats}>
            📊 Stats
          </button>
        )}
        <ThemeDropdown direction="up" triggerClassName="room-menu-btn" />
        <a href="/" className="room-menu-btn">
          🏠 Menu
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
      {/* Full-resolution room image; next/image adds no value for a same-origin API route. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageUrl} alt="Full puzzle image" />
    </div>
  );
}
