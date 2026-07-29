"use client";

import { useEffect, useState } from "react";

export interface PlayerView {
  id: string;
  name: string;
  color: string;
  placedCount: number;
}

/**
 * "Still brewing" slip (FR-18): room progress as a share of the pot. Always
 * on screen — hiding the table (below) never hides how far along the puzzle is.
 */
export function BrewSlip({ placed, total }: { placed: number; total: number }) {
  const pct = total > 0 ? Math.round((placed / total) * 100) : 0;
  return (
    <div className="brew-slip">
      <div className="brew-head">
        <span className="script">still brewing…</span>
        <span className="brew-pct">{pct}%</span>
        <div className="brew-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="brew-count">
        {placed} <span>of {total} pieces placed</span>
      </div>
    </div>
  );
}

/**
 * Presence + scoring card (FR-20): everyone at the table with their color,
 * placed count and share. The local player's name is edited inline and
 * committed via onRename. "Held by" is intentionally not shown here — cursor
 * proximity already carries it (spec: don't over-engineer).
 */
export function PlayersPanel({
  players,
  localGuestId,
  placed,
  onRename,
}: {
  players: PlayerView[];
  localGuestId: string | null;
  placed: number;
  onRename: (name: string) => void;
}) {
  return (
    <div className="players-panel">
      <div className="players-head">
        <span className="serif">At the table</span>
        <span className="script">{players.length}</span>
      </div>
      {players.map((p) => (
        <PlayerRow
          key={p.id}
          player={p}
          isSelf={p.id === localGuestId}
          share={placed > 0 ? Math.round((p.placedCount / placed) * 100) : 0}
          onRename={onRename}
        />
      ))}
      <div className="players-foot">tap your own name to change it</div>
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
