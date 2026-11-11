import { fitPlaneHeight } from "../board/tilt";

/** Below this much room for the plane, the table lies flat instead of tilting into a sliver. */
const MIN_TILTED_SPACE = 240;

export interface TableSize {
  /** The tilt the plane is drawn at: the requested one, or 0 when it lies flat. */
  tiltDeg: number;
  /** Height of the plane before the tilt. */
  planeHeight: number;
  /** Height of the perspective view: the plane as projected, plus the edge below it. */
  viewHeight: number;
}

/**
 * Sizes the table so its near edge, and the edge's thickness below it, land
 * at the bottom of the screen. With `growWithContent` (the home) the plane is
 * at least that deep and grows with its content, and the page scrolls to the
 * near edge; otherwise (the room) it is exactly that deep.
 *
 * A plane deeper than the fit would bring its near edge closer to the viewer,
 * magnified wider than the screen, so it tilts less instead: just enough that
 * its near edge comes no closer than the fitted plane's. The longer the page,
 * the flatter the table.
 */
export function sizeTable({
  space,
  content,
  tiltDeg,
  perspective,
  edge,
  growWithContent,
}: {
  /** From the top of the view to the bottom of the screen. */
  space: number;
  /** The height the plane's content needs; read only with `growWithContent`. */
  content: number;
  tiltDeg: number;
  perspective: number;
  /** Thickness of the near edge. */
  edge: number;
  growWithContent: boolean;
}): TableSize {
  const available = space - edge;
  if (tiltDeg < 0.05 || available < MIN_TILTED_SPACE) {
    // Flat: the edge would stand straight at the viewer, so the plane takes its space too.
    const planeHeight = growWithContent ? Math.max(content, space) : space;
    return { tiltDeg: 0, planeHeight, viewHeight: planeHeight };
  }
  const fit = fitPlaneHeight(available, tiltDeg, perspective);
  const planeHeight = growWithContent ? Math.max(content, fit) : fit;
  // The near edge is magnified by P / (P − depth · sin tilt); a deeper plane keeps depth · sin tilt at the fit's.
  const tilt =
    planeHeight > fit ? (Math.asin((fit * Math.sin((tiltDeg * Math.PI) / 180)) / planeHeight) * 180) / Math.PI : tiltDeg;
  const a = (tilt * Math.PI) / 180;
  const projected = (planeHeight * Math.cos(a) * perspective) / (perspective - planeHeight * Math.sin(a));
  return { tiltDeg: tilt, planeHeight, viewHeight: projected + edge };
}
