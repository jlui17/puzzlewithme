import { CELL_SIZE } from "./constants.js";
import { createRng, type Rng } from "./prng.js";
import type { EdgeSide, Piece, Puzzle, Vec2 } from "./types.js";

/** Persisted in new room seeds; unprefixed seeds retain the original geometry. */
export const VARIETY_SEED_PREFIX = "shape2:";
const SIDES: EdgeSide[] = ["top", "right", "bottom", "left"];
const MIN_DISTANCE = 0.04;
const MAX_ATTEMPTS = 12;

/** Sample the actual cubic chain, not its (wider) control-point polygon. */
export function sampleEdge(points: Vec2[], steps = 12): Vec2[] {
  if (points.length === 2) return points;
  const out = [points[0]!];
  for (let i = 0; i + 3 < points.length; i += 3) {
    const [a, b, c, d] = points.slice(i, i + 4) as [Vec2, Vec2, Vec2, Vec2];
    for (let j = 1; j <= steps; j++) {
      const t = j / steps, s = 1 - t;
      out.push({
        x: s*s*s*a.x + 3*s*s*t*b.x + 3*s*t*t*c.x + t*t*t*d.x,
        y: s*s*s*a.y + 3*s*s*t*b.y + 3*s*t*t*c.y + t*t*t*d.y,
      });
    }
  }
  return out;
}

/** Clockwise edge-local samples; a quarter-turn is a cyclic shift of edges. */
export function silhouette(piece: Piece): number[][] {
  return SIDES.map((side, index) => {
    let points = piece.edges[side].points;
    if (index >= 2) points = points.slice().reverse();
    // Compare the two curved flanks; straight lead-ins add no silhouette detail.
    const samples = points.length === 2
      ? Array.from({ length: 9 }, () => ({ x: 0, y: 0 }))
      : sampleEdge(points.slice(3, 10), 4);
    return samples.flatMap(p => {
      if (points.length === 2) return [0, 0];
      const x = (p.x - piece.framePosition.x) / CELL_SIZE;
      const y = (p.y - piece.framePosition.y) / CELL_SIZE;
      return index === 0 ? [x, -y] : index === 1 ? [y, x - 1]
        : index === 2 ? [1 - x, y - 1] : [1 - y, -x];
    });
  });
}

export function silhouetteDistance(a: number[][], b: number[][], turn = 0): number {
  let sum = 0, count = 0;
  for (let side = 0; side < 4; side++) {
    const x = a[side]!, y = b[(side + turn) % 4]!;
    for (let i = 0; i < x.length; i++) { sum += (x[i]! - y[i]!) ** 2; count++; }
  }
  return Math.sqrt(sum / count);
}

function drawTab(from: Vec2, vertical: boolean, sign: number, rng: Rng): Vec2[] {
  const height = rng.range(0.18, 0.38);
  const half = rng.range(0.12, 0.49);
  const center = 0.5 + rng.range(-0.09, 0.09) * (1 - half);
  const proposedNeck = half * rng.range(0.24, 0.62);
  const lean = rng.range(-0.12, 0.12) * half;
  const apex = center + lean;
  const skew = rng.range(-0.12, 0.12) * half;
  const shoulder = rng.range(0.12, 0.42);
  const crown = rng.range(0.65, 1);
  // Every control point stays inside its edge's triangular corridor. Adjacent
  // inward cuts therefore have disjoint convex hulls, with a material margin.
  // This intentionally limits wide, deep combinations instead of risking cuts
  // through the piece. Cubics stay inside the hull of their control points.
  const safe = (u: number, w: number): [number, number] =>
    [Math.max(w + 0.015, Math.min(1 - w - 0.015, u)), w];
  const leftShoulder = safe(apex - half - skew, height * shoulder);
  const rightShoulder = safe(apex + half - skew, height * shoulder);
  // Corridor clipping can pull a wide shoulder inward. Keep the neck narrower
  // than both resulting shoulders, so neither flank loses its interlocking lip.
  const neck = Math.min(proposedNeck,
    0.98 * Math.min(center - leftShoulder[0], rightShoulder[0] - center));
  const left = center - neck, right = center + neck;
  const local: [number, number][] = [
    [0, 0], [left/3, 0], [2*left/3, 0], [left, 0],
    leftShoulder,
    safe(apex - half - skew, height * crown),
    safe(apex, height),
    safe(apex + half - skew, height * crown),
    rightShoulder,
    [right, 0], [right + (1-right)/3, 0], [right + 2*(1-right)/3, 0], [1, 0],
  ];
  return local.map(([u, w]) => ({
    x: from.x + CELL_SIZE * (vertical ? sign*w : u),
    y: from.y + CELL_SIZE * (vertical ? u : sign*w),
  }));
}

/** Replace each shared edge once, then finalize pieces in row-major order. */
export function applyVariety(puzzle: Puzzle, seed: string): Puzzle {
  const rng = createRng(seed, 0x56415232);
  const seen = new Map<string, number[][][]>();
  for (const piece of puzzle.pieces) {
    // Only right/bottom are still uncommitted; top/left belong to earlier pieces.
    const mutable = (["right", "bottom"] as const).filter(s => piece.edges[s].kind !== "flat");
    const kinds = SIDES.map(s => piece.edges[s].kind);
    const peers = seen.get(kinds.join("/")) ?? [];
    let best = -1;
    let chosen: Vec2[][] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      for (const side of mutable) {
        const edge = piece.edges[side];
        const points = drawTab(edge.points[0]!, side === "right", edge.kind === "tab" ? 1 : -1, rng);
        edge.points = points;
      }
      const shape = silhouette(piece);
      let distance = Infinity;
      for (const peer of peers) distance = Math.min(distance, silhouetteDistance(shape, peer));
      if (distance > best) {
        best = distance;
        chosen = mutable.map(s => piece.edges[s].points);
      }
      if (best >= MIN_DISTANCE || mutable.length === 0) break;
    }
    mutable.forEach((side, i) => {
      const points = chosen[i]!;
      piece.edges[side].points = points;
      const neighbor = puzzle.pieces[piece.neighbors[side]!]!;
      neighbor.edges[side === "right" ? "left" : "top"].points = points;
    });
    const shape = silhouette(piece);
    for (let turn = 0; turn < 4; turn++) {
      const key = kinds.map((_, i) => kinds[(i + turn) % 4]).join("/");
      const bucket = seen.get(key) ?? [];
      bucket.push(shape.map((_, i) => shape[(i + turn) % 4]!));
      seen.set(key, bucket);
    }
  }
  return puzzle;
}
