"use client";

import { useEffect, useState } from "react";

export interface PlayerView {
  id: string;
  name: string;
  color: string;
  placedCount: number;
}

/** A player's colour, always with their initial on it, so the colour is never the only thing that tells players apart. */
export function PlayerMark({ name, color }: { name: string; color: string }) {
  return (
    <span className="player-mark" style={{ color }} aria-hidden="true">
      <b>{name.charAt(0).toUpperCase()}</b>
    </span>
  );
}

/**
 * Who's here (FR-20): everyone at the table with their placed count and
 * share. The local player's name is edited inline and committed via
 * onRename. Opened from the menu; closed by its × or Escape.
 */
export function PlayersPanel({
  players,
  localGuestId,
  placed,
  onRename,
  onClose,
}: {
  players: PlayerView[];
  localGuestId: string | null;
  placed: number;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // The rename field handles its own Escape (cancel) and stops there.
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="players" id="players" aria-label="Who's here">
      <button type="button" className="players-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <div className="players-head">
        <h2>Who&apos;s here</h2>
        <span>{players.length} at the table</span>
      </div>
      <div className="player-rows">
        {players.map((p) => (
          <PlayerRow
            key={p.id}
            player={p}
            isSelf={p.id === localGuestId}
            share={placed > 0 ? Math.round((p.placedCount / placed) * 100) : 0}
            onRename={onRename}
          />
        ))}
      </div>
      <p className="players-foot">Tap your own name to change it. Counts are pieces placed.</p>
    </aside>
  );
}

function PlayerRow({
  player,
  isSelf,
  share,
  onRename,
}: {
  player: PlayerView;
  isSelf: boolean;
  share: number;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(player.name);

  useEffect(() => {
    if (!editing) setDraft(player.name);
  }, [player.name, editing]);

  function commit(): void {
    const trimmed = draft.trim().slice(0, 40);
    if (trimmed && trimmed !== player.name) onRename(trimmed);
    else setDraft(player.name);
    setEditing(false);
  }

  return (
    <div className="player">
      <PlayerMark name={player.name} color={player.color} />
      {editing ? (
        <span className="player-name">
          <input
            autoFocus
            aria-label="Your name"
            value={draft}
            maxLength={40}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(player.name);
                setEditing(false);
              }
            }}
          />
        </span>
      ) : isSelf ? (
        <button type="button" className="player-name self" title="Click to rename" onClick={() => setEditing(true)}>
          {player.name}
          <span className="you">you</span>
        </button>
      ) : (
        <span className="player-name">{player.name}</span>
      )}
      <span className="player-score">
        {player.placedCount}
        {share > 0 ? ` · ${share}%` : ""}
      </span>
    </div>
  );
}
