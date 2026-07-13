"use client";

import { useEffect, useState } from "react";

export interface PlayerView {
  id: string;
  name: string;
  color: string;
  placedCount: number;
}

/**
 * Presence + scoring panel (FR-18/20): room progress bar, then each present
 * player with color, placed count and share. The local player's name is edited
 * inline and committed via onRename. "Held by" is intentionally not shown here —
 * cursor proximity already carries it (spec: don't over-engineer).
 *
 * When collapsed, only the progress row renders (a slim strip) — used on
 * phones, where the full list covers too much of the board.
 */
export function PlayersPanel({
  players,
  localGuestId,
  placed,
  total,
  onRename,
  collapsed,
}: {
  players: PlayerView[];
  localGuestId: string | null;
  placed: number;
  total: number;
  onRename: (name: string) => void;
  collapsed: boolean;
}) {
  const pct = total > 0 ? Math.round((placed / total) * 100) : 0;
  return (
    <div className={`players-panel${collapsed ? " collapsed" : ""}`}>
      <div className="progress-head">
        <span className="label">Progress</span>
        <span className="count">
          {placed} / {total}
        </span>
      </div>
      <div className="progress-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      {!collapsed &&
        players.map((p) => (
          <PlayerRow
            key={p.id}
            player={p}
            isSelf={p.id === localGuestId}
            share={placed > 0 ? Math.round((p.placedCount / placed) * 100) : 0}
            onRename={onRename}
          />
        ))}
    </div>
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
    <div className="player-row">
      <span className="player-dot" style={{ background: player.color }} />
      {editing ? (
        <span className="player-name">
          <input
            autoFocus
            value={draft}
            maxLength={40}
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
      ) : (
        <span
          className={`player-name${isSelf ? " self" : ""}`}
          onClick={isSelf ? () => setEditing(true) : undefined}
          title={isSelf ? "Click to rename" : undefined}
          style={isSelf ? { cursor: "text" } : undefined}
        >
          {player.name}
          {isSelf && <span className="edit-hint">you</span>}
        </span>
      )}
      <span className="player-score">
        {player.placedCount}
        {share > 0 ? ` · ${share}%` : ""}
      </span>
    </div>
  );
}
