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
 *
 * Raised from the original 0.2/0.1/0.16 (bulb/neck ratio 1.6) to 0.28/0.11/0.20
 * (ratio 1.82): a ~40% taller, more overhung knob so pieces read as distinct
 * jigsaw shapes rather than a uniform wavy border, while the neck barely grew
 * so pieces still separate into a clear tab-and-slot (not a lobe stuck straight
 * onto the edge). Feel-tuned against the rendered board, not measured.
 */
export const TAB_HEIGHT_RATIO = 0.28;
export const TAB_NECK_HALF_RATIO = 0.11;
export const TAB_BULB_HALF_RATIO = 0.2;

/**
 * Per-edge jitter ranges (fractions of CELL_SIZE) so no two edges look
 * identical (FR-6, "per-edge random variation"): TAB_POS_JITTER moves the tab
 * along the edge, TAB_SIZE_JITTER varies its height. Raised from 0.04/0.03 (the
 * original values) to 0.06/0.05 to make the variation between pieces obvious at
 * a glance, not just on close inspection.
 *
 * TAB_TILT_JITTER and TAB_ASYMMETRY_JITTER are new: TILT offsets the bulb peak
 * from the neck's center (buildTabEdge's `apexU`), so the knob leans instead of
 * always standing symmetrically over its neck; ASYMMETRY makes the bulb wider
 * on one flank than the other (buildTabEdge's `bwL`/`bwR`), so knobs stop being
 * mirror-symmetric blobs. Together with POS/SIZE this covers all four axes of
 * variation called for (position, size, asymmetry, tilt).
 *
 * All four ranges were sized together against one worst-case check (numbers
 * below use this file's current ratios above; re-check this comment if any of
 * those change): with pos in [-0.06, 0.06], tc = 0.5 + pos spans [0.44, 0.56].
 * With tilt in [-0.04, 0.04], the bulb peak apexU = tc + tilt spans
 * [0.40, 0.60]. With asymmetry in [-0.05, 0.05], bwL/bwR = BULB_HALF_RATIO +-
 * asymmetry span [0.15, 0.25]. The bulb's outer columns (apexU -+ bwL/bwR) then
 * land no closer than 0.15 to either edge end (u=0 or u=1) in the worst
 * combination, comfortably clear of the corner where this edge meets its
 * neighbor. bwL/bwR themselves (independent of tilt) never drop below 0.15,
 * comfortably above TAB_NECK_HALF_RATIO (0.11), so the bulb column is always
 * wider than the neck; only in the single most extreme combination (tilt and
 * asymmetry both maxed toward the same flank) does that flank's overhang
 * shrink to zero, which just rounds off that one side rather than producing a
 * degenerate or self-crossing curve. Bumping any of these ranges up requires
 * re-running this margin check.
 */
export const TAB_POS_JITTER = 0.06;
export const TAB_SIZE_JITTER = 0.05;
export const TAB_TILT_JITTER = 0.04;
export const TAB_ASYMMETRY_JITTER = 0.05;

/**
 * Worst-case fraction of CELL_SIZE a tab can extend past its cell edge,
 * perpendicular to the edge: TAB_HEIGHT_RATIO plus the largest possible
 * TAB_SIZE_JITTER draw. Anything that needs to reserve room for a tab's
 * overhang (atlas tile padding, scatter clearance, board-bounds clamping) must
 * size against this, not TAB_HEIGHT_RATIO alone, or the rare piece with a
 * near-maximum size jitter clips at its tile/board boundary.
 */
export const TAB_MAX_HEIGHT_RATIO = TAB_HEIGHT_RATIO + TAB_SIZE_JITTER;

/**
 * Salts (see createRng) keeping the edge-shape stream and the scatter stream
 * decorrelated within one room seed. Values are arbitrary but must stay
 * stable, since changing them changes every generated puzzle.
 */
export const PUZZLE_SALT = 0x9e3779b9;
export const SCATTER_SALT = 0x85ebca6b;
