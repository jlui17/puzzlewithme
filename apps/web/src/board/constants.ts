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
 * Canvas pixels held clear at the bottom of the visible board when fitting it,
 * so the fit view never puts pieces under the room menu. The mock's board
 * inset, which is the menu pill's footprint: 20px bottom inset + 1px border +
 * 4px padding + a ~36px button + 4px padding + 1px border = 66px. The players
 * panel lies over the board and is cleared by panning (PAN_OVERSCROLL_PX).
 */
export const BOARD_FIT_MENU_INSET_PX = 66;

/**
 * Canvas pixels held clear at the top of the visible board when fitting it,
 * so the fit view never puts pieces under the room's header (the Leave link,
 * the progress bar and the other players' cups), which lies on the table over
 * the board. The mock's header is 92px (10px top padding + a 44px cup + its
 * name and count lines), and its board starts 4px below it.
 */
export const BOARD_FIT_HEADER_INSET_PX = 96;
/** A single cell fills this fraction of the smaller viewport dimension at max zoom. */
export const MAX_ZOOM_CELL_FILL = 0.45;

/**
 * The Window Seat mock (designs/window-seat/index.html) draws a cell 24 units
 * wide and gives every depth cue in those units. Sizing the cues in MOCK_UNITs
 * makes a piece here look like the mock's at the same on-screen cell size, and
 * zooming scales them with the piece, as the mock's zoom does.
 */
export const MOCK_UNIT = CELL_SIZE / 24;

/** How far a loose piece's dark side face shows below its face. */
export const PIECE_SIDE_DEPTH = 3 * MOCK_UNIT;
/** The light edge around a loose piece (the outer half of the mock's 1-unit stroke). */
export const PIECE_EDGE_WIDTH = 0.5 * MOCK_UNIT;
/** The dark line between assembled pieces, drawn half inside each piece. */
export const PIECE_JOINT_WIDTH = 0.8 * MOCK_UNIT;
export const PIECE_JOINT_COLOR = "rgba(0,0,0,0.3)";

/** Shadow softness (Gaussian sigma) for each light: the lamp's is crisper than the overcast sky's. */
export const SHADOW_BLUR = { lamp: 2.2 * MOCK_UNIT, overhead: 3.5 * MOCK_UNIT } as const;

/** The lamp, in screen pixels above the top centre of the view; evening shadows fall away from it. */
export const LAMP_HEIGHT_PX = 220;

/**
 * A piece another player holds lifts: scaled about its centre, raised, and its
 * shadow pushed LIFT times further and spread wider. A piece you drag yourself
 * only gets the shadow, so what you line up is exactly where it drops: the
 * raise is past the snap tolerance, and the scale would shift a wide group's
 * edges. The shadow's spread stands in for the mock's 2.6x blur, which would
 * need a third shadow bake; picked by eye against the mock.
 */
export const HELD_SCALE = 1.08;
export const HELD_RAISE = 6 * MOCK_UNIT;
export const HELD_SHADOW_LIFT = 2.6;
export const HELD_SHADOW_SCALE = 1.15;

/** Assembled pieces cast one soft shadow straight down, in both lights. */
export const ASSEMBLED_SHADOW_DROP = 3 * MOCK_UNIT;
export const ASSEMBLED_SHADOW_ALPHA = 0.6;

/**
 * The completed picture's amber glow: color, peak opacity, and how far it
 * spreads past the picture (2.5 sigma of the mock's 14-unit glow).
 */
export const COMPLETED_GLOW_COLOR = 0xf1b25a;
export const COMPLETED_GLOW_ALPHA = 0.35;
export const COMPLETED_GLOW_SPREAD = 35 * MOCK_UNIT;

/**
 * The picture outline's dashes, in screen pixels: redrawn against the camera
 * so it reads as the same dashed line at every zoom. Sized in world units it
 * would be a sub-pixel hairline at the fit zoom of a big board.
 */
export const FRAME_DASH_PX = 6;
export const FRAME_GAP_PX = 8;
export const FRAME_WIDTH_PX = 1;

/**
 * The play area's line is the picture outline's dashed line at this fraction
 * of its opacity: faint enough not to compete with the outline, so a player
 * notices it only when a piece is near it. Picked by eye in both lights.
 */
export const PLAY_AREA_LINE_ALPHA = 0.5;

/**
 * Fractional zoom change that triggers an outline redraw. The outline is
 * hundreds of dash segments, so it is rebuilt on a ratio step rather than every
 * frame of a pinch; 3% is far below the ~1px of drift a viewer could notice at
 * these dash sizes. Picked from that visibility floor, not measured.
 */
export const FRAME_REDRAW_RATIO = 0.03;

/** Wheel zoom multiplier per notch; ~1.0015^deltaY gives smooth trackpad + mouse feel. */
export const WHEEL_ZOOM_RATE = 0.0015;

/**
 * Extra pan slack (screen pixels, independent of zoom) added on every side of
 * the camera clamp in clampCamera. Without it, whenever the board fits the
 * viewport on an axis (e.g. at min zoom) the camera is locked to a single
 * centered position with zero pan range on that axis, so a piece rendered
 * under a fixed corner overlay could never be dragged clear of it by panning
 * alone. Sized to clear the widest such overlay, the players panel (the
 * mock's .players: 300px wide, 24px right inset = 324px). Taken from that one
 * measurement, not tuned against other viewport sizes.
 */
export const PAN_OVERSCROLL_PX = 324;

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
