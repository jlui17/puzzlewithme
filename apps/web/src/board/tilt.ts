/**
 * The tilted table: the element holding the board canvas is a CSS 3D plane,
 * rotated about its top edge (transform-origin 50% 0%) inside a container
 * with `perspective` and `perspective-origin`. The browser draws it; this
 * module is the same projection in numbers, so pointer input can be mapped
 * from the screen back onto the plane (canvas pixels), and so layout can
 * size the plane to land its near edge where it should.
 *
 * All lengths in CSS px of the perspective container ("the view").
 */
export interface TiltView {
  /** CSS `perspective`: the camera's distance from the view. */
  perspective: number;
  /** CSS `perspective-origin`, within the view. */
  originX: number;
  originY: number;
  /** The plane's layout box (before transform) within the view. */
  planeLeft: number;
  planeTop: number;
  /** Rotation about the plane's top edge, in degrees; positive brings the bottom toward the viewer. */
  tiltDeg: number;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** A point on the plane (canvas pixels) to where the browser draws it in the view. */
export function planeToView(t: TiltView, u: number, v: number): { x: number; y: number } {
  const a = rad(t.tiltDeg);
  const x = t.planeLeft + u;
  const y = t.planeTop + v * Math.cos(a);
  const z = v * Math.sin(a);
  const s = t.perspective / (t.perspective - z);
  return { x: t.originX + (x - t.originX) * s, y: t.originY + (y - t.originY) * s };
}

/** A point in the view (e.g. a pointer) back to the plane (canvas pixels). Inverse of planeToView. */
export function viewToPlane(t: TiltView, sx: number, sy: number): { x: number; y: number } {
  const a = rad(t.tiltDeg);
  const dy = sy - t.originY;
  const v = (t.perspective * (sy - t.planeTop)) / (t.perspective * Math.cos(a) + dy * Math.sin(a));
  const s = t.perspective / (t.perspective - v * Math.sin(a));
  const u = (sx - t.originX) / s + t.originX - t.planeLeft;
  return { x: u, y: v };
}

/**
 * A client (viewport) point back to the plane, given where an element lying
 * at the plane's top-left corner is drawn (its getBoundingClientRect) and its
 * layout height. The box places the view on the page: the element's top edge
 * lies on the tilt axis, so it is drawn at the plane's top, and its left is
 * its near-left corner, which perspective pushes outward.
 */
export function clientToPlane(
  t: TiltView,
  box: { left: number; top: number },
  height: number,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const viewLeft = box.left - planeToView(t, 0, height).x;
  const viewTop = box.top - t.planeTop;
  return viewToPlane(t, clientX - viewLeft, clientY - viewTop);
}

/** A point on the plane back to a client point: the inverse of clientToPlane, from the same box and height. */
export function planeToClient(
  t: TiltView,
  box: { left: number; top: number },
  height: number,
  u: number,
  v: number,
): { x: number; y: number } {
  const viewLeft = box.left - planeToView(t, 0, height).x;
  const viewTop = box.top - t.planeTop;
  const drawn = planeToView(t, u, v);
  return { x: drawn.x + viewLeft, y: drawn.y + viewTop };
}

/**
 * Plane height whose projected near edge lands `available` px below the
 * plane's top, for a plane whose top sits on the perspective origin's row.
 * (The mock's fitPlane: a depth H projects to H cos t · P/(P − H sin t).)
 */
export function fitPlaneHeight(available: number, tiltDeg: number, perspective: number): number {
  const a = rad(tiltDeg);
  return (available * perspective) / (perspective * Math.cos(a) + available * Math.sin(a));
}
