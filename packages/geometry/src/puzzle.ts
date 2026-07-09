import { CELL_SIZE, PUZZLE_SALT, TAB_POS_JITTER, TAB_SIZE_JITTER } from "./constants.js";
import { buildTabEdge, flatEdge, type EdgeJitter } from "./path.js";
import { createRng } from "./prng.js";
import type { EdgeDescriptor, EdgeKind, EdgeSide, Piece, Puzzle, Vec2 } from "./types.js";

export function coordToPieceId(row: number, col: number, cols: number): number {
  return row * cols + col;
}

export function pieceIdToCoord(id: number, cols: number): { row: number; col: number } {
  return { row: Math.floor(id / cols), col: id % cols };
}

/** World coordinate of a piece's correct cell origin (its assembled position). */
export function framePosition(id: number, cols: number): Vec2 {
  const { row, col } = pieceIdToCoord(id, cols);
  return { x: col * CELL_SIZE, y: row * CELL_SIZE };
}

/** Neighbor piece id on each side, or null at a border. */
export function neighborsOf(piece: Piece): Record<EdgeSide, number | null> {
  return piece.neighbors;
}

interface InternalEdge {
  points: Vec2[];
  sign: 1 | -1;
}

/**
 * Generate the full deterministic geometry for a puzzle (FR-6). Same
 * (rows, cols, seed) always yields deep-equal output. Each internal edge gets a
 * random tab direction and jitter; the two pieces sharing an edge reference the
 * identical curve, so their shared boundary is an exact complement (see path.ts).
 *
 * The RNG is consumed in a fixed order (all vertical edges row-major, then all
 * horizontal edges) so client and server draw identical values.
 */
export function generatePuzzle(rows: number, cols: number, seed: string | number): Puzzle {
  if (rows < 1 || cols < 1) {
    throw new Error("generatePuzzle: rows and cols must be >= 1");
  }
  const rng = createRng(seed, PUZZLE_SALT);

  const drawEdge = (orientation: "horizontal" | "vertical", from: Vec2): InternalEdge => {
    const sign: 1 | -1 = rng.bool() ? 1 : -1;
    const jitter: EdgeJitter = {
      pos: rng.range(-TAB_POS_JITTER, TAB_POS_JITTER),
      size: rng.range(-TAB_SIZE_JITTER, TAB_SIZE_JITTER),
    };
    return { points: buildTabEdge(orientation, from, sign, jitter), sign };
  };

  // Vertical edges: between (r,c) and (r,c+1), keyed [r][c] for c in 0..cols-2.
  const vEdges: InternalEdge[][] = [];
  for (let r = 0; r < rows; r++) {
    const rowEdges: InternalEdge[] = [];
    for (let c = 0; c < cols - 1; c++) {
      const x = (c + 1) * CELL_SIZE;
      rowEdges.push(drawEdge("vertical", { x, y: r * CELL_SIZE }));
    }
    vEdges.push(rowEdges);
  }

  // Horizontal edges: between (r,c) and (r+1,c), keyed [r][c] for r in 0..rows-2.
  const hEdges: InternalEdge[][] = [];
  for (let r = 0; r < rows - 1; r++) {
    const rowEdges: InternalEdge[] = [];
    for (let c = 0; c < cols; c++) {
      const y = (r + 1) * CELL_SIZE;
      rowEdges.push(drawEdge("horizontal", { x: c * CELL_SIZE, y }));
    }
    hEdges.push(rowEdges);
  }

  const pieces: Piece[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = col * CELL_SIZE;
      const y0 = row * CELL_SIZE;
      const x1 = x0 + CELL_SIZE;
      const y1 = y0 + CELL_SIZE;

      const edges: Record<EdgeSide, EdgeDescriptor> = {
        top:
          row === 0
            ? { kind: "flat", points: flatEdge({ x: x0, y: y0 }, { x: x1, y: y0 }) }
            : descriptorFor("top", hEdges[row - 1]![col]!),
        right:
          col === cols - 1
            ? { kind: "flat", points: flatEdge({ x: x1, y: y0 }, { x: x1, y: y1 }) }
            : descriptorFor("right", vEdges[row]![col]!),
        bottom:
          row === rows - 1
            ? { kind: "flat", points: flatEdge({ x: x0, y: y1 }, { x: x1, y: y1 }) }
            : descriptorFor("bottom", hEdges[row]![col]!),
        left:
          col === 0
            ? { kind: "flat", points: flatEdge({ x: x0, y: y0 }, { x: x0, y: y1 }) }
            : descriptorFor("left", vEdges[row]![col - 1]!),
      };

      pieces.push({
        id: coordToPieceId(row, col, cols),
        row,
        col,
        edges,
        framePosition: { x: x0, y: y0 },
        neighbors: {
          top: row > 0 ? coordToPieceId(row - 1, col, cols) : null,
          right: col < cols - 1 ? coordToPieceId(row, col + 1, cols) : null,
          bottom: row < rows - 1 ? coordToPieceId(row + 1, col, cols) : null,
          left: col > 0 ? coordToPieceId(row, col - 1, cols) : null,
        },
      });
    }
  }

  return { rows, cols, pieces };
}

/**
 * A piece's edge kind, given the shared edge's world bulge sign. A tab
 * protrudes away from the piece interior; a blank indents toward it. For a
 * vertical edge (+sign bulges +x): the left piece's RIGHT edge is a tab when
 * sign > 0, the right piece's LEFT edge is the opposite. For a horizontal edge
 * (+sign bulges +y): the upper piece's BOTTOM edge is a tab when sign > 0, the
 * lower piece's TOP edge is the opposite.
 */
function descriptorFor(side: EdgeSide, edge: InternalEdge): EdgeDescriptor {
  const positiveIsTab: Record<EdgeSide, boolean> = {
    right: true,
    left: false,
    bottom: true,
    top: false,
  };
  const isTab = edge.sign > 0 ? positiveIsTab[side] : !positiveIsTab[side];
  const kind: EdgeKind = isTab ? "tab" : "blank";
  return { kind, points: edge.points };
}
