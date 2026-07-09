import {
  CELL_SIZE,
  TAB_BULB_HALF_RATIO,
  TAB_HEIGHT_RATIO,
  TAB_NECK_HALF_RATIO,
} from "./constants.js";
import type { EdgeDescriptor, EdgeSide, Piece, Vec2 } from "./types.js";

export type EdgeOrientation = "horizontal" | "vertical";

/** Per-edge jitter drawn once and applied to both pieces sharing the edge. */
export interface EdgeJitter {
  /** Tab-center offset along the edge, fraction of CELL_SIZE. */
  pos: number;
  /** Tab-height offset, fraction of CELL_SIZE. */
  size: number;
}

/**
 * Build the canonical world-space cubic-bezier control points for one internal
 * edge (a jigsaw tab). `from`/`to` are the edge's corner endpoints in canonical
 * direction (horizontal: left->right, vertical: top->bottom). `sign` is the
 * world bulge direction: for a horizontal edge +1 bulges toward +y (down), for
 * a vertical edge +1 bulges toward +x (right).
 *
 * The knob is four cubic segments over local parameters (u along the edge in
 * [0,1], w perpendicular in bulge units). Because the bulb half-width exceeds
 * the neck half-width, the bulb overhangs the neck — the classic interlocking
 * look. The identical point array is stored on both adjacent pieces, so their
 * shared boundary is one curve (exact complementarity).
 */
export function buildTabEdge(
  orientation: EdgeOrientation,
  from: Vec2,
  sign: 1 | -1,
  jitter: EdgeJitter,
): Vec2[] {
  const tc = 0.5 + jitter.pos;
  const h = TAB_HEIGHT_RATIO + jitter.size;
  const nw = TAB_NECK_HALF_RATIO;
  const bw = TAB_BULB_HALF_RATIO;

  // Local (u, w) control points: start, then four cubic segments.
  const local: Array<[number, number]> = [
    [0, 0],
    [(tc - nw) / 3, 0],
    [(2 * (tc - nw)) / 3, 0],
    [tc - nw, 0],
    [tc - bw, h * 0.2],
    [tc - bw, h * 0.9],
    [tc, h],
    [tc + bw, h * 0.9],
    [tc + bw, h * 0.2],
    [tc + nw, 0],
    [tc + nw + (1 - (tc + nw)) / 3, 0],
    [tc + nw + (2 * (1 - (tc + nw))) / 3, 0],
    [1, 0],
  ];

  return local.map(([u, w]) => mapEdgeLocal(orientation, from, sign, u, w));
}

function mapEdgeLocal(
  orientation: EdgeOrientation,
  from: Vec2,
  sign: 1 | -1,
  u: number,
  w: number,
): Vec2 {
  if (orientation === "horizontal") {
    return { x: from.x + u * CELL_SIZE, y: from.y + w * CELL_SIZE * sign };
  }
  return { x: from.x + w * CELL_SIZE * sign, y: from.y + u * CELL_SIZE };
}

/** A flat (border) edge: just its two corner endpoints in canonical direction. */
export function flatEdge(from: Vec2, to: Vec2): Vec2[] {
  return [from, to];
}

function reversed<T>(items: readonly T[]): T[] {
  return items.slice().reverse();
}

/**
 * The four edges in clockwise outline order, each with the point list oriented
 * for traversal. Top and right are canonical-forward; bottom and left run
 * against their canonical direction, so their points are reversed. Reversing a
 * flat cubic chain's point list yields exactly the reverse-direction chain
 * (endpoints swap and control points swap order together), which is why a plain
 * array reverse is correct here.
 */
function outlineEdges(piece: Piece): Vec2[][] {
  return [
    piece.edges.top.points,
    piece.edges.right.points,
    reversed(piece.edges.bottom.points),
    reversed(piece.edges.left.points),
  ];
}

function sub(p: Vec2, origin: Vec2 | null): Vec2 {
  return origin ? { x: p.x - origin.x, y: p.y - origin.y } : p;
}

/**
 * Raw control points of a piece's full outline, clockwise from the top-left
 * corner, with shared corner points de-duplicated. World coordinates by
 * default; pass `{ local: true }` to make them relative to the piece's cell
 * origin (framePosition), for rendering a piece as a translation-free sprite.
 */
export function pieceOutlineControlPoints(piece: Piece, opts?: { local?: boolean }): Vec2[] {
  const origin = opts?.local ? piece.framePosition : null;
  const edges = outlineEdges(piece);
  const out: Vec2[] = [];
  edges.forEach((points, i) => {
    // Skip each edge's first point except the very first edge's: it duplicates
    // the previous edge's last point (a shared corner).
    const start = i === 0 ? 0 : 1;
    for (let k = start; k < points.length; k++) {
      out.push(sub(points[k]!, origin));
    }
  });
  return out;
}

function fmt(n: number): string {
  // Round to a stable precision so the SVG string is deterministic and doesn't
  // carry float noise; 3 decimals is sub-pixel at any realistic zoom.
  return (Math.round(n * 1000) / 1000).toString();
}

function edgeCommands(points: Vec2[], origin: Vec2 | null): string {
  if (points.length === 2) {
    const p = sub(points[1]!, origin);
    return `L ${fmt(p.x)} ${fmt(p.y)}`;
  }
  const parts: string[] = [];
  for (let i = 1; i < points.length; i += 3) {
    const c1 = sub(points[i]!, origin);
    const c2 = sub(points[i + 1]!, origin);
    const e = sub(points[i + 2]!, origin);
    parts.push(`C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(e.x)} ${fmt(e.y)}`);
  }
  return parts.join(" ");
}

/**
 * The piece outline as an SVG path string, closed with Z. The client clips the
 * puzzle image with this path; the server never needs it. World coordinates by
 * default; `{ local: true }` yields piece-local coordinates.
 */
export function pieceSvgPath(piece: Piece, opts?: { local?: boolean }): string {
  const origin = opts?.local ? piece.framePosition : null;
  const start = sub(piece.framePosition, origin);
  const edges = outlineEdges(piece);
  const commands = edges.map((points) => edgeCommands(points, origin));
  return `M ${fmt(start.x)} ${fmt(start.y)} ${commands.join(" ")} Z`;
}

/** Control points of a single edge in world coordinates (its stored descriptor). */
export function edgeControlPoints(piece: Piece, side: EdgeSide): Vec2[] {
  return piece.edges[side].points;
}

export type { EdgeDescriptor };
