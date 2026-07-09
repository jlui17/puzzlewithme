import { CELL_SIZE, TAB_HEIGHT_RATIO } from "@puzzlewithme/geometry";

/**
 * Tab overhang in world units: how far a tab pokes past its cell edge. Matches
 * the geometry module's own overhang (snap.ts / scatter.ts), so a baked piece
 * tile is exactly large enough to hold the widest possible tab.
 */
export const OVERHANG = TAB_HEIGHT_RATIO * CELL_SIZE;

/** A baked piece tile spans the cell plus a tab's worth of overhang on every side. */
export const TILE_WORLD = CELL_SIZE + 2 * OVERHANG;

/**
 * Atlas edge length in pixels. 4096 is the min guaranteed WebGL2 max texture
 * size across the evergreen browsers/GPUs NFR-8 targets, so a single atlas is
 * always uploadable; larger risks silent failures on weaker mobile GPUs.
 */
export const ATLAS_SIZE = 4096;

/**
 * Per-piece texel budget bounds. The bake resolution follows the source image
 * (imagePixelsPerWorldUnit), but is clamped to this range so:
 *  - MIN keeps a tiny-image / 1000-piece puzzle legible when zoomed in.
 *  - MAX bounds atlas memory: at 128px a 4096 atlas holds ~32*32≈1024 tiles in
 *    one texture, so even a 1000-piece puzzle fits in ~2 atlases (~34 MB RGBA
 *    each). Higher wastes VRAM past what a piece is ever shown at.
 * Guessed from the tile-count/VRAM tradeoff above, not measured on-device.
 */
export const MIN_TILE_PX = 48;
export const MAX_TILE_PX = 128;

/**
 * Zoom clamps, as world-units-to-screen-pixels scale. Recomputed against the
 * live viewport (see camera.ts): MIN fits the whole board with a margin (FR-27
 * "see the whole board at once"); MAX magnifies one CELL_SIZE cell to a
 * comfortable fraction of the viewport (FR-27 "comfortable working size").
 */
export const MIN_ZOOM_BOARD_MARGIN = 0.92;
/** A single cell fills this fraction of the smaller viewport dimension at max zoom. */
export const MAX_ZOOM_CELL_FILL = 0.45;

/** Wheel zoom multiplier per notch; ~1.0015^deltaY gives smooth trackpad + mouse feel. */
export const WHEEL_ZOOM_RATE = 0.0015;

/**
 * Render-time delay for interpolating remote motion, in ms. Remote holders relay
 * at 30 Hz (~33 ms/sample), so rendering ~100 ms in the past almost always
 * leaves the two newest samples bracketing the render time, giving jitter-free
 * lerp instead of extrapolation. 100 ms is well inside NFR-2's 200 ms budget.
 * Guessed from the 33 ms sample gap plus typical network jitter, not measured.
 */
export const INTERP_DELAY_MS = 100;
