/**
 * Coordinate convention (read this before touching geometry):
 *
 * - Units are "puzzle-space units". One piece cell is CELL_SIZE units square.
 * - The assembled puzzle's frame has its top-left corner at the world origin
 *   (0, 0). Piece (row, col)'s correct cell origin (its top-left corner when
 *   assembled) is (col * CELL_SIZE, row * CELL_SIZE). The frame spans
 *   (0, 0) .. (cols * CELL_SIZE, rows * CELL_SIZE).
 * - The board (table) is BOARD_SIZE_MULTIPLIER times the frame in each
 *   dimension, centered on the frame, so board coordinates extend negative on
 *   the top/left of the frame (see boardBounds in snap.ts).
 * - A group's position is the world coordinate of its anchor piece's cell
 *   origin. The anchor is the group's lowest piece id (row-major); every other
 *   piece's world origin is derived from the frame offset to the anchor.
 */

/**
 * Side length of one piece cell in puzzle-space units. 100 is chosen so a
 * cell is a round number and per-edge jitter (expressed as fractions of the
 * cell) lands on clean values; it's a pure scale factor, so rendering can map
 * puzzle units to screen pixels at any zoom. Nothing depends on the specific
 * value, only that client and server share it.
 */
export const CELL_SIZE = 100;

/**
 * The board is this many times the frame's size in each dimension (FR-8:
 * "the board is several times larger than the frame in each dimension, giving
 * room to sort"). 3x gives a margin one full frame wide on every side, which
 * comfortably holds the scattered pieces in a ring around the frame (see
 * initialScatter) without pushing them so far that panning to sort becomes
 * tedious. Guessed from the tanggle.io look, not measured; tunable.
 */
export const BOARD_SIZE_MULTIPLIER = 3;

/**
 * Snap tolerance in puzzle-space units (FR-13). A drop counts as a snap when a
 * piece is within this distance of its correct offset. 15 units = 15% of a
 * cell. Chosen by feel from comparable jigsaw games: tighter (~5%) frustrates
 * trackpad users who can't land the pixel; looser (~30%) causes unintended
 * snaps to the wrong neighbor. Not measured against real usage; FR-13 requires
 * it be tunable, which it is (evaluateSnap takes tolerance as a parameter).
 */
export const DEFAULT_SNAP_TOLERANCE = 15;

/**
 * Tab geometry, all expressed as fractions of CELL_SIZE so shapes scale with
 * the cell. These define the "classic jigsaw" knob (FR-6). The exact numbers
 * are aesthetic, tuned so the bulb overhangs the neck (BULB_HALF > NECK_HALF),
 * which reads as an interlocking tab rather than a bump. They are not
 * correctness-critical: complementarity holds for any shape because adjacent
 * pieces share the identical edge curve (see path.ts).
 */
export const TAB_HEIGHT_RATIO = 0.2;
export const TAB_NECK_HALF_RATIO = 0.1;
export const TAB_BULB_HALF_RATIO = 0.16;

/**
 * Per-edge jitter ranges (fractions of CELL_SIZE), applied to tab center
 * position and tab height so no two edges look identical (FR-6, "per-edge
 * random variation"). Kept small so every edge still reads as a well-formed
 * tab; larger values start producing degenerate or self-crossing knobs.
 */
export const TAB_POS_JITTER = 0.04;
export const TAB_SIZE_JITTER = 0.03;

/**
 * Salts (see createRng) keeping the edge-shape stream and the scatter stream
 * decorrelated within one room seed. Values are arbitrary but must stay
 * stable, since changing them changes every generated puzzle.
 */
export const PUZZLE_SALT = 0x9e3779b9;
export const SCATTER_SALT = 0x85ebca6b;
