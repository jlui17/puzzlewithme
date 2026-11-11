import { Cup } from "../scene/Cup";
import type { PlayerView } from "./PlayersPanel";

/**
 * The far side of the table: the way out, how far along the puzzle is, the
 * other players' cups across the table, and your own cup at the near edge.
 * It lies on the plane over the board, so only its parts take the pointer.
 */
export function RoomHeader({
  placed,
  total,
  completed,
  others,
  me,
}: {
  placed: number;
  total: number;
  completed: boolean;
  others: PlayerView[];
  me: PlayerView | null;
}) {
  const pct = total > 0 ? Math.round((placed / total) * 100) : 0;
  return (
    <header className="room-top">
      <a className="leave" href="/">
        &larr; Leave the table
      </a>
      <div className="room-title">
        <div className="prog">
          <span className="prog-bar">
            <i style={{ width: `${pct}%` }} />
          </span>
          <span className="prog-text">
            {completed ? `All ${total} pieces placed` : `${placed} of ${total} pieces placed`}
          </span>
        </div>
        <span className="pan-hint">Drag the table to pan</span>
      </div>
      <ul className="cups" aria-label="Friends at the table">
        {others.map((p) => (
          <li key={p.id}>
            <Cup color={p.color} steam={false} />
            <span className="cup-name">{p.name}</span>
            <span className="cup-count">{p.placedCount} placed</span>
          </li>
        ))}
      </ul>
      {me && (
        <div className="my-cup">
          <Cup color={me.color} />
          <div className="cup-label">
            <b>{me.name}</b>you, {me.placedCount} placed
          </div>
        </div>
      )}
    </header>
  );
}
