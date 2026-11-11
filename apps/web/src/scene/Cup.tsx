/**
 * A cup and saucer standing on the table, its ring in the player's colour.
 * The `.stand` wrapper turns it back upright against the table's tilt.
 */
export function Cup({ color, steam = true }: { color: string; steam?: boolean }) {
  return (
    <div className="stand" aria-hidden="true">
      <div className="cup" style={{ color }}>
        <svg viewBox="0 0 64 64">
          <use href="#cup-shape" />
        </svg>
        {steam && (
          <span className="steam">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
    </div>
  );
}
