import type { ReactNode } from "react";

/**
 * A card lying in the middle of the table, for every room state with no board
 * to play: loading, not found, full, and the errors. Children carry the
 * heading, the line under it, and an optional action.
 */
export function TableCard({ children }: { children: ReactNode }) {
  return (
    <div className="table-card-wrap">
      <div className="table-card" role="status">
        {children}
      </div>
    </div>
  );
}
