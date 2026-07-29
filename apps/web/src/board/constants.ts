import { CELL_SIZE, TAB_MAX_HEIGHT_RATIO } from "@puzzlewithme/geometry";

/**
 * Tab overhang in world units: how far a tab pokes past its cell edge. Uses
 * TAB_MAX_HEIGHT_RATIO (base height plus the largest possible size jitter),
 * matching the geometry module's own overhang (snap.ts / scatter.ts), so a
 * baked piece tile is exactly large enough to hold the widest possible tab —
 * sizing against the base ratio alone would clip the rare piece whose tab
 * drew a near-maximum size jitter.
 */
export const OVERHANG = TAB_MAX_HEIGHT_RATIO * CELL_SIZE;

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

/**
 * Screen pixels held clear below the board when fitting it, so the fit view
 * never butts the mat's hem up against the tray. Sized from the tray's own
 * geometry in globals.css (.room-menu: 24px bottom inset + 9px padding + a
 * 42px button + 9px padding = 84px) plus ~20px of visible table between the
 * two. Only the tray gets this clearance: the floating paper (brew slip,
 * players card) is meant to lie ON the mat, so it keeps overlapping.
 */
export const BOARD_FIT_TRAY_INSET_PX = 104;
/** A single cell fills this fraction of the smaller viewport dimension at max zoom. */
export const MAX_ZOOM_CELL_FILL = 0.45;

/**
 * How much the mat's linen weave scales with the camera, as an exponent on the
 * camera scale: 0 pins the texture to screen space (the mat stops reading as
 * an object lying on the table), 1 locks it to world space (zooming in on a
 * single piece magnifies a 4-thread weave into burlap). 0.35 keeps the threads
 * visibly attached to the mat while holding the on-screen pitch to roughly
 * 1.5–6 px across the whole zoom range. Picked by eye against that range.
 */
export const WEAVE_ZOOM_DAMPING = 0.35;

/**
 * Zoom window over which the weave fades into the mat's flat color, measured
 * as one cell's on-screen size (CELL_SIZE * camera scale). Below the low end
 * the thread pitch is finer than the pixel grid, where it reads as moiré
 * competing with the pieces rather than as cloth; above the high end the mat
 * is fully woven. The window has to sit under the fit-to-screen zoom of a
 * mid-size board (~20 px/cell for 100 pieces on a laptop) or the default view
 * — the one players spend the most time in — would always be flat cloth,
 * while a 1000-piece board still fits at ~12 px/cell and stays nearly flat.
 * Derived from those two fit zooms, not measured on-device.
 */
export const WEAVE_FADE_MIN_CELL_PX = 10;
export const WEAVE_FADE_MAX_CELL_PX = 22;

/**
 * The hem's stitching, in screen pixels: redrawn against the camera so it
 * reads as the same dashed line at every zoom, the way the weave holds a
 * near-constant thread pitch. Sized in world units instead, it would be a
 * sub-pixel hairline at the fit-to-screen zoom where the hem is most visible.
 * Its POSITION is world-space (the playArea rect from @puzzlewithme/geometry),
 * so the line a player sees is exactly the limit pieces scatter and clamp to.
 */
export const HEM_DASH_PX = 10;
export const HEM_GAP_PX = 7;
export const HEM_WIDTH_PX = 1;

/**
 * Fractional zoom change that triggers a hem redraw. The hem is hundreds of
 * dash segments, so it is rebuilt on a ratio step rather than every frame of a
 * pinch; 3% is far below the ~1px of drift a viewer could notice at these
 * dash sizes. Picked from that visibility floor, not measured.
 */
export const HEM_REDRAW_RATIO = 0.03;

/** Wheel zoom multiplier per notch; ~1.0015^deltaY gives smooth trackpad + mouse feel. */
export const WHEEL_ZOOM_RATE = 0.0015;

/**
 * Extra pan slack (screen pixels, independent of zoom) added on every side of
 * the camera clamp in clampCamera. Without it, whenever the board fits the
 * viewport on an axis (e.g. at min zoom) the camera is locked to a single
 * centered position with zero pan range on that axis, so a piece rendered
 * under a fixed corner overlay could never be dragged clear of it by panning
 * alone. Sized to clear the widest such overlay, the PlayersPanel
 * (.players-panel in globals.css: 256px wide, 24px right inset = 280px),
 * rounded up for a small buffer. Guessed from that one measurement, not
 * tuned against other viewport sizes.
 */
export const PAN_OVERSCROLL_PX = 290;

/**
 * Render-time delay for interpolating remotely-held group motion, in ms.
 * Remote holders relay at 30 Hz (~33 ms/sample), so rendering ~100 ms in the
 * past almost always leaves the two newest samples bracketing the render time,
 * giving jitter-free lerp instead of extrapolation. 100 ms is well inside
 * NFR-2's 200 ms budget. Guessed from the 33 ms sample gap plus typical
 * network jitter, not measured.
 */
export const INTERP_DELAY_MS = 100;

/**
 * Render-time delay for interpolating remote cursors, in ms. Cursors ping at
 * 10 Hz (SyncClient's CURSOR_INTERVAL_MS, 100 ms), so this must exceed one
 * ping interval or every slightly-late ping stalls the pointer at its last
 * sample and then jumps. 1.5 intervals is the usual margin for interpolating
 * a fixed-rate snapshot stream: half an interval absorbs network jitter, and
 * the cost is only added display latency on a presence pointer (no
 * correctness rides on it). Chosen by that convention, not measured.
 */
export const CURSOR_INTERP_DELAY_MS = 150;
