import { boardBounds, CELL_SIZE } from "@puzzlewithme/geometry";
import {
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

/** Smallest scale that still fits the whole board in the viewport (FR-27). */
export function minScale(rows: number, cols: number, vp: Viewport): number {
  const b = boardBounds(rows, cols);
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  const fit = Math.min(vp.width / bw, vp.height / bh) * MIN_ZOOM_BOARD_MARGIN;
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
 * Clamp the pan offset so the board can't be dragged entirely out of view
 * (FR-26 "within the board bounds"), while still leaving PAN_OVERSCROLL_PX of
 * slack on every side (see constants.ts) so the camera always has *some* pan
 * range to escape fixed UI overlays, even on axes where the board is smaller
 * than the viewport.
 */
export function clampCamera(cam: Camera, rows: number, cols: number, vp: Viewport): Camera {
  const b = boardBounds(rows, cols);
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
 * Clamp one axis's board-edge screen position. The board's near edge may
 * range between flush-far and flush-near (whichever order `worldSize` vs.
 * `vpSize` puts them in), expanded by PAN_OVERSCROLL_PX on each end.
 */
function clampEdge(edge: number, worldSize: number, vpSize: number): number {
  const lo = Math.min(0, vpSize - worldSize) - PAN_OVERSCROLL_PX;
  const hi = Math.max(0, vpSize - worldSize) + PAN_OVERSCROLL_PX;
  return Math.min(hi, Math.max(lo, edge));
}

/** Initial camera: whole board fit, centered. */
export function fitCamera(rows: number, cols: number, vp: Viewport): Camera {
  const scale = minScale(rows, cols, vp);
  const b = boardBounds(rows, cols);
  const worldW = (b.maxX - b.minX) * scale;
  const worldH = (b.maxY - b.minY) * scale;
  const x = (vp.width - worldW) / 2 - b.minX * scale;
  const y = (vp.height - worldH) / 2 - b.minY * scale;
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
