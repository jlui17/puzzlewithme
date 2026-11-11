/** One press of + or − zooms by this factor, eased by the board. */
const ZOOM_STEP = 1.25;

/**
 * The zoom buttons beside the table and the zoom readout under them. The
 * board writes the readout through `hintRef` as the camera moves, so a
 * wheel or pinch zoom updates it without re-rendering the room.
 */
export function ZoomControl({
  zoomRef,
  hintRef,
}: {
  zoomRef: React.RefObject<((factor: number) => void) | null>;
  hintRef: React.RefObject<HTMLSpanElement | null>;
}) {
  return (
    <div className="zoom-ctl">
      <button type="button" className="zoom-btn" aria-label="Lean in (zoom in)" onClick={() => zoomRef.current?.(ZOOM_STEP)}>
        +
      </button>
      <button
        type="button"
        className="zoom-btn"
        aria-label="Lean back (zoom out)"
        onClick={() => zoomRef.current?.(1 / ZOOM_STEP)}
      >
        −
      </button>
      <span className="zoom-hint" ref={hintRef}>
        1.0×
      </span>
    </div>
  );
}
