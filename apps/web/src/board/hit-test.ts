import type { Piece, Puzzle, Vec2 } from "@puzzlewithme/geometry";

/**
 * Accurate pointer hit-testing against jigsaw piece outlines. Sprite bounds
 * (a plain box) over-report on the concave gaps between tabs, so a click near a
 * blank could grab the wrong overlapping piece; testing the actual outline
 * polygon fixes that. Curves are flattened once at load into per-piece polygons
 * in piece-local coordinates (relative to the piece's cell origin).
 */

// Samples per cubic segment when flattening a tab curve. 6 keeps the polygon
// within a fraction of a world unit of the true bezier — sub-pixel at any zoom
// a piece is grabbed at — without bloating the vertex count for 1000 pieces.
const SAMPLES_PER_CURVE = 6;

function cubicAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function reversed<T>(items: readonly T[]): T[] {
  return items.slice().reverse();
}

/**
 * Piece outline as a flat polygon in piece-local coordinates. Mirrors path.ts's
 * outline traversal (top, right, bottom-reversed, left-reversed): a flat edge is
 * a single line segment; a tab edge is four cubics we sample. Corner points are
 * de-duplicated the same way pieceOutlineControlPoints does.
 */
function flattenPieceOutline(piece: Piece): Vec2[] {
  const origin = piece.framePosition;
  const local = (p: Vec2): Vec2 => ({ x: p.x - origin.x, y: p.y - origin.y });

  const edges: Vec2[][] = [
    piece.edges.top.points,
    piece.edges.right.points,
    reversed(piece.edges.bottom.points),
    reversed(piece.edges.left.points),
  ];

  const poly: Vec2[] = [];
  let first = true;
  for (const points of edges) {
    if (points.length === 2) {
      // Flat edge: straight line to the far corner.
      if (first) poly.push(local(points[0]!));
      poly.push(local(points[1]!));
    } else {
      // Tab edge: start point then cubic triples (cp1, cp2, end).
      if (first) poly.push(local(points[0]!));
      for (let i = 1; i + 2 < points.length; i += 3) {
        const p0 = points[i - 1]!;
        const p1 = points[i]!;
        const p2 = points[i + 1]!;
        const p3 = points[i + 2]!;
        for (let s = 1; s <= SAMPLES_PER_CURVE; s++) {
          poly.push(local(cubicAt(p0, p1, p2, p3, s / SAMPLES_PER_CURVE)));
        }
      }
    }
    first = false;
  }
  return poly;
}

/** Local-coordinate outline polygon for every piece, keyed by piece id. */
export function buildPiecePolygons(puzzle: Puzzle): Map<number, Vec2[]> {
  const map = new Map<number, Vec2[]>();
  for (const piece of puzzle.pieces) map.set(piece.id, flattenPieceOutline(piece));
  return map;
}

/** Standard even-odd ray-cast point-in-polygon test. */
export function pointInPolygon(poly: Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    const intersects =
      a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}
