/** A point in puzzle-space. See constants.ts for the coordinate convention. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Grid dimensions derived from a piece-count tier and image aspect (FR-3). */
export interface Grid {
  rows: number;
  cols: number;
}

export type EdgeSide = "top" | "right" | "bottom" | "left";

/**
 * An edge as seen from one piece: `flat` for the outer edge of a border piece
 * (FR-6), otherwise `tab` (protrudes outward) or `blank` (indents inward). The
 * two pieces sharing an internal edge always report opposite kinds.
 */
export type EdgeKind = "flat" | "tab" | "blank";

/**
 * One edge of a piece. `points` are cubic-bezier control points in WORLD
 * coordinates, in the edge's canonical direction (horizontal edges run
 * left->right, vertical edges run top->bottom), NOT the piece's outline
 * traversal direction. A flat edge is exactly its two corner endpoints
 * `[from, to]`; a tab/blank edge is 13 points: a start point followed by four
 * cubic segments (cp1, cp2, end each).
 *
 * Because both pieces sharing an internal edge reference the same canonical
 * curve, `puzzle.pieces[i].edges.right.points` is value-equal to the adjacent
 * piece's `edges.left.points` — complementarity is exact by construction.
 */
export interface EdgeDescriptor {
  kind: EdgeKind;
  points: Vec2[];
}

export interface Piece {
  /** Piece id = row * cols + col (row-major). */
  id: number;
  row: number;
  col: number;
  edges: Record<EdgeSide, EdgeDescriptor>;
  /** World coordinate of this piece's cell origin when assembled: (col, row) * CELL_SIZE. */
  framePosition: Vec2;
  /** Neighbor piece id on each side, or null at a border. */
  neighbors: Record<EdgeSide, number | null>;
}

export interface Puzzle {
  rows: number;
  cols: number;
  /** All pieces, indexed by id (row-major). Length = rows * cols. */
  pieces: Piece[];
}

/**
 * A group of correctly-joined pieces that moves as a unit (§4.3). Matches the
 * server's persisted Group (shared package) except pieces are numeric ids here
 * and `locked` mirrors `lockedToFrame`. The geometry module works in ids for
 * speed; convert with coordToPieceId / pieceIdToCoord.
 */
export interface GroupState {
  id: string;
  pieces: number[];
  /** World coordinate of the anchor (lowest piece id) cell origin. */
  position: Vec2;
  locked: boolean;
}

/** A drop intent: move `groupId`'s anchor to `position` (FR-11). */
export interface SnapDrop {
  groupId: string;
  position: Vec2;
}

/** One snap event, for scoring credit (FR-21). `connectedPieces` is sorted. */
export interface SnapEvent {
  type: "merge" | "lock";
  /** Groups combined by this event (merge), or the group locked (lock). */
  groupIds: string[];
  connectedPieces: number[];
}

/**
 * Authoritative result of evaluating a drop (FR-11). Pure data; evaluateSnap
 * never mutates its inputs. `groups` is the full post-drop group set.
 */
export interface SnapOutcome {
  /** Final aligned (or bounds-clamped) position of the dropped group's anchor. */
  finalPosition: Vec2;
  merged: boolean;
  locked: boolean;
  /** Ids of other groups absorbed into the dropped group, sorted. */
  mergedGroupIds: string[];
  /** Ordered snap events (merge then lock, if both occur). */
  events: SnapEvent[];
  /**
   * All pieces INVOLVED in any event (the union of the merged/locked groups'
   * pieces), sorted. This is a stateless report, not "newly connected": a
   * singleton merging into a 5-chunk lists all 6. The server applies FR-21's
   * credit-once by diffing this against its own already-credited set; geometry
   * has no history to know which pieces were previously connected.
   */
  connectedPieces: number[];
  /** The resulting group (keeps the dropped group's id). */
  group: GroupState;
  /** Full new group set after the drop (dropped + absorbed replaced by `group`). */
  groups: GroupState[];
}
