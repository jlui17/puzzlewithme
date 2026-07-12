import { BOARD_SIZE_MULTIPLIER, CELL_SIZE, SCATTER_SALT, TAB_MAX_HEIGHT_RATIO } from "./constants.js";
import { createRng, shuffleInPlace } from "./prng.js";
import type { Vec2 } from "./types.js";

/** Board bounds in world coordinates (§2.3, FR-8). Negative on the top/left. */
export function boardBounds(rows: number, cols: number): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const frameW = cols * CELL_SIZE;
  const frameH = rows * CELL_SIZE;
  // Board is BOARD_SIZE_MULTIPLIER x the frame, centered on the frame center.
  const extraX = ((BOARD_SIZE_MULTIPLIER - 1) / 2) * frameW;
  const extraY = ((BOARD_SIZE_MULTIPLIER - 1) / 2) * frameH;
  return {
    minX: -extraX,
    minY: -extraY,
    maxX: frameW + extraX,
    maxY: frameH + extraY,
  };
}

// A scattered piece must clear the frame region by its own half-size plus tab
// overhang plus the max jitter it can receive, so a jittered piece (tabs
// included) can never poke into where the puzzle assembles.
const PIECE_HALF = CELL_SIZE / 2;
// Worst-case extent (TAB_MAX_HEIGHT_RATIO), so the piece with the largest
// possible tab-size jitter still clears the frame by its own overhang.
const OVERHANG = TAB_MAX_HEIGHT_RATIO * CELL_SIZE;
// Upper bound on per-piece jitter; the applied jitter (below) is never larger.
const MAX_JITTER = 0.15 * CELL_SIZE;
// Full footprint radius: keep this clear of the frame and the board edge.
const FOOTPRINT = PIECE_HALF + OVERHANG + MAX_JITTER;

/**
 * Deterministic initial scatter of every piece around the centered frame
 * (FR-7). Returns each piece's cell-origin position, indexed by piece id.
 *
 * Placement: a jittered grid over the board, skipping cells that overlap the
 * frame region (so pieces ring the empty frame like tanggle.io, §2.3). Cells
 * are picked at a pitch wider than a cell and each piece is jittered less than
 * half the slack, so distinct cells never collide — the CELL_SIZE footprints
 * stay non-overlapping, keeping every piece individually pickable. The board is
 * ~9x the frame's area (3x per side), leaving room to spare for the ring.
 */
export function initialScatter(rows: number, cols: number, seed: string | number): Vec2[] {
  const count = rows * cols;
  const rng = createRng(seed, SCATTER_SALT);
  const bounds = boardBounds(rows, cols);
  const frameW = cols * CELL_SIZE;
  const frameH = rows * CELL_SIZE;

  // Pitch 1.6 cells: fits far more valid cells than needed (board minus frame
  // holds ~3x the piece count at this pitch) while leaving slack for jitter.
  // If a degenerate shape ever yields too few cells, shrink and retry.
  let pitch = CELL_SIZE * 1.6;
  const minPitch = CELL_SIZE * 1.05; // still guarantees non-overlap after jitter
  let centers: Vec2[] = [];
  while (pitch >= minPitch) {
    centers = validCellCenters(pitch, bounds, frameW, frameH);
    if (centers.length >= count) break;
    pitch *= 0.85;
  }

  shuffleInPlace(centers, rng);

  // Jitter kept below half the pitch slack so two occupied cells (>= pitch
  // apart on one axis) still can't overlap as CELL_SIZE boxes.
  const jitter = Math.min(MAX_JITTER, (pitch - CELL_SIZE) / 2);

  const positions: Vec2[] = [];
  for (let id = 0; id < count; id++) {
    const center = centers[id]!;
    const cx = center.x + rng.range(-jitter, jitter);
    const cy = center.y + rng.range(-jitter, jitter);
    // Position is the cell ORIGIN (top-left), not the center.
    positions.push({ x: cx - PIECE_HALF, y: cy - PIECE_HALF });
  }
  return positions;
}

function validCellCenters(
  pitch: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  frameW: number,
  frameH: number,
): Vec2[] {
  const centers: Vec2[] = [];
  // Keep the whole jittered footprint inside the board.
  const loX = bounds.minX + FOOTPRINT;
  const hiX = bounds.maxX - FOOTPRINT;
  const loY = bounds.minY + FOOTPRINT;
  const hiY = bounds.maxY - FOOTPRINT;
  // Frame exclusion: skip any cell whose center falls within the frame expanded
  // by a full footprint, so no scattered piece (incl. tabs and jitter) enters it.
  const excl = FOOTPRINT;

  for (let cy = loY; cy <= hiY + 1e-6; cy += pitch) {
    for (let cx = loX; cx <= hiX + 1e-6; cx += pitch) {
      const insideFrame =
        cx >= -excl && cx <= frameW + excl && cy >= -excl && cy <= frameH + excl;
      if (insideFrame) continue;
      centers.push({ x: cx, y: cy });
    }
  }
  return centers;
}
