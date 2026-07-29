import {
  CELL_SIZE,
  MAT_ASPECT,
  MAT_HEM_INSET_RATIO,
  SCATTER_PITCH_CELLS,
  SCATTER_ROOM_FACTOR,
  SCATTER_SALT,
  TAB_MAX_HEIGHT_RATIO,
} from "./constants.js";
import { createRng, shuffleInPlace } from "./prng.js";
import type { Vec2 } from "./types.js";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const SCATTER_PITCH = CELL_SIZE * SCATTER_PITCH_CELLS;

/**
 * How far past the frame the play surface reaches, in world units (FR-8 "room
 * to sort"). Solved rather than fixed: the band around the frame has to hold
 * `count * SCATTER_ROOM_FACTOR` pieces at the scatter pitch, so
 *
 *   (frameW + 2t)(frameH + 2t) - frameW * frameH = need
 *
 * which is a quadratic in t. A puzzle therefore gets a surface proportional to
 * how much cloth its pieces actually need — small puzzles stay compact instead
 * of scattering across a fixed multiple of the frame, which is what made them
 * tedious to work on a phone.
 *
 * Math.sqrt, not Math.pow: client and server must derive this identically (§5),
 * and sqrt is the one of the two IEEE-754 requires be exactly rounded.
 */
function sortingInset(rows: number, cols: number): number {
  const frameW = cols * CELL_SIZE;
  const frameH = rows * CELL_SIZE;
  const need = rows * cols * SCATTER_ROOM_FACTOR * SCATTER_PITCH * SCATTER_PITCH;
  const half = frameW + frameH;
  const t = (-half + Math.sqrt(half * half + 4 * need)) / 4;
  // Floor: even a 4-piece puzzle wants a visible border of cloth, and the band
  // must clear a piece's whole jittered footprint or no cell fits in it at all.
  return Math.max(t, FOOTPRINT + SCATTER_PITCH);
}

/**
 * The region the pieces actually occupy: the frame, its sorting band, and the
 * footprint of a piece sitting at the band's edge (a scattered piece's position
 * is its cell origin, so it reaches half a cell plus a tab further out than the
 * band itself). This is what a client should frame on open — it tracks the
 * picture's shape, so it fills a tall phone screen where the always-landscape
 * mat would leave the pieces tiny between two bands of empty table.
 */
export function scatterBounds(rows: number, cols: number): Bounds {
  const reach = sortingInset(rows, cols) + FOOTPRINT;
  return {
    minX: -reach,
    minY: -reach,
    maxX: cols * CELL_SIZE + reach,
    maxY: rows * CELL_SIZE + reach,
  };
}

/**
 * Where pieces may live: the sorting band widened to the mat's constant
 * landscape ratio. This is the rect initialScatter draws its cells from and
 * clampGroupToBoard clamps to, and the renderer traces the hem on it — so
 * "inside the dashed line" is one definition rather than three that drift.
 */
export function playArea(rows: number, cols: number): Bounds {
  const b = scatterBounds(rows, cols);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  // Widen to MAT_ASPECT so the cloth is landscape whatever the picture's shape
  // is; the extra only ever adds surface, never takes any away.
  const padX = (Math.max(w, h * MAT_ASPECT) - w) / 2;
  const padY = (Math.max(h, w / MAT_ASPECT) - h) / 2;
  return {
    minX: b.minX - padX,
    minY: b.minY - padY,
    maxX: b.maxX + padX,
    maxY: b.maxY + padY,
  };
}

/** The cloth: the play area plus the margin its stitched hem sits in. */
export function matBounds(rows: number, cols: number): Bounds {
  const p = playArea(rows, cols);
  const hem =
    (Math.min(p.maxX - p.minX, p.maxY - p.minY) * MAT_HEM_INSET_RATIO) / (1 - 2 * MAT_HEM_INSET_RATIO);
  return {
    minX: p.minX - hem,
    minY: p.minY - hem,
    maxX: p.maxX + hem,
    maxY: p.maxY + hem,
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
 * Placement: a jittered grid over the play area, skipping cells that overlap
 * the frame region (so pieces ring the empty frame like tanggle.io, §2.3).
 * Cells are picked at a pitch wider than a cell and each piece is jittered less
 * than half the slack, so distinct cells never collide — the CELL_SIZE
 * footprints stay non-overlapping, keeping every piece individually pickable.
 *
 * Which cells get used is the part that keeps a puzzle compact: cells are
 * ordered by distance from the frame and only the nearest
 * `count * SCATTER_ROOM_FACTOR` are eligible, then shuffled. So pieces hug the
 * frame in a band no deeper than they need, land in a random order (piece 0 is
 * not always innermost), and leave the far corners of the cloth empty to sort
 * into. Filling the whole surface uniformly instead put every piece a long pan
 * away from the frame on a phone.
 */
export function initialScatter(rows: number, cols: number, seed: string | number): Vec2[] {
  const count = rows * cols;
  const rng = createRng(seed, SCATTER_SALT);
  const bounds = playArea(rows, cols);
  const frameW = cols * CELL_SIZE;
  const frameH = rows * CELL_SIZE;

  // The play area is sized to hold the pieces at this pitch, so the loop below
  // normally runs once; it only shrinks the pitch if some degenerate shape
  // yields too few cells anyway.
  let pitch = SCATTER_PITCH;
  const minPitch = CELL_SIZE * 1.05; // still guarantees non-overlap after jitter
  let centers: Vec2[] = [];
  while (pitch >= minPitch) {
    centers = validCellCenters(pitch, bounds, frameW, frameH);
    if (centers.length >= count) break;
    pitch *= 0.85;
  }

  // Nearest-first, then a random pick from that pool: compact but not packed.
  // Ties broken on y then x so the order is identical on client and server.
  centers.sort((a, b) => {
    const da = distanceToFrame(a, frameW, frameH);
    const db = distanceToFrame(b, frameW, frameH);
    return da - db || a.y - b.y || a.x - b.x;
  });
  centers.length = Math.min(centers.length, Math.ceil(count * SCATTER_ROOM_FACTOR));
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

/** Distance from a cell centre to the frame rect; 0 for a centre inside it. */
function distanceToFrame(c: Vec2, frameW: number, frameH: number): number {
  const dx = Math.max(0, -c.x, c.x - frameW);
  const dy = Math.max(0, -c.y, c.y - frameH);
  return Math.sqrt(dx * dx + dy * dy);
}

function validCellCenters(
  pitch: number,
  bounds: Bounds,
  frameW: number,
  frameH: number,
): Vec2[] {
  const centers: Vec2[] = [];
  // Keep the whole jittered footprint inside the play area.
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
