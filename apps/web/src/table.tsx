/**
 * The walnut table every screen sits on. One fixed, non-interactive stack of
 * gradient layers (figure, grain, rays, flecks, two knots, sheen, vignette)
 * whose colors come from the active theme's `.table` block in globals.css, so
 * home, the board, and the in-between states are visibly the same surface.
 */
export function TableSurface() {
  return (
    <div className="table" aria-hidden="true">
      <div className="table-figure" />
      <div className="table-grain" />
      <div className="table-rays" />
      <div className="table-fleck" />
      <div className="table-knots" />
      <div className="table-checks" />
      <div className="table-lamp" />
      <div className="table-sheen" />
      <div className="table-vignette" />
    </div>
  );
}

/**
 * Things left lying on the table around the mat: a mug, a notebook with a pen
 * across it, and an AirPods case. Painted between the table and the board
 * canvas, so the mat covers whichever ones the puzzle's cloth reaches over.
 */
export function TableProps() {
  return (
    <div className="table-props" aria-hidden="true">
      <div className="prop prop-notebook">
        <span className="notebook-pages" />
        <span className="notebook-band" />
      </div>
      <div className="prop prop-pen">
        <span className="pen-tip" />
        <span className="pen-cap" />
      </div>
      <div className="prop prop-pods">
        <span className="pods-hinge" />
        <span className="pods-seam" />
      </div>
      <Cup className="prop-mug" />
    </div>
  );
}

/** Cup of coffee seen from above, with two rising wisps. Pure CSS, no asset. */
export function Cup({ className }: { className?: string }) {
  return (
    <div className={className ? `cup ${className}` : "cup"} aria-hidden="true">
      <span className="steam steam-a" />
      <span className="steam steam-b" />
      <span className="cup-saucer">
        <span className="cup-crema" />
      </span>
    </div>
  );
}
