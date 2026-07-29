import { CELL_SIZE, matBounds, scatterBounds } from "@puzzlewithme/geometry";
import {
  BOARD_FIT_TRAY_INSET_PX,
  MAX_ZOOM_CELL_FILL,
  MIN_ZOOM_BOARD_MARGIN,
  PAN_OVERSCROLL_PX,
} from "./constants";

/**
 * Pan/zoom camera mapping world (puzzle-space) coordinates to screen pixels
 * (FR-26/27). Kept as a plain value object with pure transforms so input.ts and
 * the renderer share one source of truth and it stays unit-testable in
 * principle. `scale` is world-units→screen-pixels; `x`/`y` is the screen
 * position of the world origin.
 *
 *   screen = world * scale + offset
 *   world  = (screen - offset) / scale
 */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export function worldToScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.scale + cam.x, y: wy * cam.scale + cam.y };
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
}

/**
 * The area the mat is fit and centered in: the viewport minus the band the
 * tray occupies along the bottom. Panning still uses the full viewport, so
 * pieces can be dragged under the tray and back out — this only keeps the
 * fit-to-screen view from placing the mat's hem against it.
 */
function fitBox(vp: Viewport): Viewport {
  return { width: vp.width, height: Math.max(1, vp.height - BOARD_FIT_TRAY_INSET_PX) };
}

/**
 * Smallest scale that still fits the whole mat in the clear area (FR-27 "see
 * the whole board at once" — the mat contains the scatter area, so fitting it
 * fits every piece).
 */
export function minScale(rows: number, cols: number, vp: Viewport): number {
  const b = matBounds(rows, cols);
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  const box = fitBox(vp);
  const fit = Math.min(box.width / bw, box.height / bh) * MIN_ZOOM_BOARD_MARGIN;
  // Guard against a zero-sized viewport during first layout.
  return fit > 0 ? fit : 0.01;
}

/** Largest scale: one cell fills a comfortable fraction of the smaller viewport (FR-27). */
export function maxScale(vp: Viewport): number {
  const smaller = Math.min(vp.width, vp.height) || 1;
  return (smaller * MAX_ZOOM_CELL_FILL) / CELL_SIZE;
}

export function clampScale(scale: number, rows: number, cols: number, vp: Viewport): number {
  const lo = minScale(rows, cols, vp);
  const hi = Math.max(lo, maxScale(vp));
  return Math.min(hi, Math.max(lo, scale));
}

/**
 * Clamp the pan offset so the mat can't be dragged entirely out of view
 * (FR-26 "within the board bounds"), while still leaving PAN_OVERSCROLL_PX of
 * slack on every side (see constants.ts) so the camera always has *some* pan
 * range to escape fixed UI overlays, even on axes where the mat is smaller
 * than the viewport.
 */
export function clampCamera(cam: Camera, rows: number, cols: number, vp: Viewport): Camera {
  const b = matBounds(rows, cols);
  const worldW = (b.maxX - b.minX) * cam.scale;
  const worldH = (b.maxY - b.minY) * cam.scale;

  const left = b.minX * cam.scale + cam.x;
  const top = b.minY * cam.scale + cam.y;

  const clampedLeft = clampEdge(left, worldW, vp.width);
  const clampedTop = clampEdge(top, worldH, vp.height);

  return {
    x: cam.x + (clampedLeft - left),
    y: cam.y + (clampedTop - top),
    scale: cam.scale,
  };
}

/**
 * Clamp one axis's mat-edge screen position. The mat's near edge may
 * range between flush-far and flush-near (whichever order `worldSize` vs.
 * `vpSize` puts them in), expanded by PAN_OVERSCROLL_PX on each end.
 */
function clampEdge(edge: number, worldSize: number, vpSize: number): number {
  const lo = Math.min(0, vpSize - worldSize) - PAN_OVERSCROLL_PX;
  const hi = Math.max(0, vpSize - worldSize) + PAN_OVERSCROLL_PX;
  return Math.min(hi, Math.max(lo, edge));
}

/**
 * Initial camera: the pieces and the frame they ring, centered in the area
 * above the tray. Fits scatterBounds rather than the whole mat, because the mat
 * is always landscape while the work is the picture's shape — fitting the cloth
 * on a tall phone screen shrank the pieces to specks between two bands of empty
 * table. The mat's spare corners are still reachable, just by zooming out
 * (minScale) or panning, rather than being on screen from the first frame.
 */
export function fitCamera(rows: number, cols: number, vp: Viewport): Camera {
  const b = scatterBounds(rows, cols);
  const box = fitBox(vp);
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  const fit = Math.min(box.width / bw, box.height / bh) * MIN_ZOOM_BOARD_MARGIN;
  const scale = clampScale(fit > 0 ? fit : 0.01, rows, cols, vp);
  const x = (box.width - bw * scale) / 2 - b.minX * scale;
  const y = (box.height - bh * scale) / 2 - b.minY * scale;
  return { x, y, scale };
}

/** Zoom around a screen anchor (cursor), keeping the world point under it fixed. */
export function zoomAt(
  cam: Camera,
  factor: number,
  anchorX: number,
  anchorY: number,
  rows: number,
  cols: number,
  vp: Viewport,
): Camera {
  const newScale = clampScale(cam.scale * factor, rows, cols, vp);
  const world = screenToWorld(cam, anchorX, anchorY);
  // Solve offset so `world` maps back to the anchor at the new scale.
  const x = anchorX - world.x * newScale;
  const y = anchorY - world.y * newScale;
  return clampCamera({ x, y, scale: newScale }, rows, cols, vp);
}
