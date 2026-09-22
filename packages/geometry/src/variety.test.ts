import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CELL_SIZE } from "./constants.js";
import { generatePuzzle } from "./puzzle.js";
import { sampleEdge, silhouette, silhouetteDistance } from "./variety.js";
import type { Piece, Vec2 } from "./types.js";

function nearest(pieces: Piece[]): number[] {
  const shapes = pieces.map(silhouette);
  return pieces.map((a, i) => {
    let best = Infinity;
    const sides = ["top", "right", "bottom", "left"] as const;
    for (let j = 0; j < i; j++) for (let turn = 0; turn < 4; turn++) {
      if (!sides.every((s, k) => a.edges[s].kind === pieces[j]!.edges[sides[(k+turn)%4]!].kind)) continue;
      best = Math.min(best, silhouetteDistance(shapes[i]!, shapes[j]!, turn));
    }
    return best;
  });
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
}
function intersects(a: Vec2,b: Vec2,c: Vec2,d: Vec2): boolean {
  return cross(a,b,c)*cross(a,b,d)<-1e-8 && cross(c,d,a)*cross(c,d,b)<-1e-8;
}

describe("versioned connector variety", () => {
  it("preserves saved and numeric seed geometry byte for byte", () => {
    for (const [seed, hash] of [
      ["saved-room", "fe2d65bb6e7c65870e6f8410a1d9b787a71c6fb236eab33402c1c6445dca90d3"],
      [123, "0ebe1fb73d7dc1bf9a66d70a2ec19ee12e0df45a765075c0ffd5ecf4d51e48db"],
      ["4294967295", "dc9defacbc822e4f0c1a087e0f8ed4486d4eb953e1b0113ccb348a169ac7eece"],
    ] as const) expect(createHash("sha256").update(JSON.stringify(generatePuzzle(9,12,seed))).digest("hex")).toBe(hash);
  });

  it("is repeatable, shares exact complementary curves, and keeps cuts in disjoint corridors", () => {
    for (let seed = 0; seed < 64; seed++) {
      const puzzle = generatePuzzle(4,5,`shape2:${seed}`);
      expect(puzzle).toEqual(generatePuzzle(4,5,`shape2:${seed}`));
      for (const p of puzzle.pieces) {
        for (const side of ["right", "bottom"] as const) {
          const edge = p.edges[side];
          if (edge.kind === "flat") continue;
          const neighbor = puzzle.pieces[p.neighbors[side]!]!;
          const other = neighbor.edges[side === "right" ? "left" : "top"];
          expect(edge.points).toBe(other.points);
          expect(edge.kind).not.toBe(other.kind);
          const from = edge.points[0]!;
          for (const point of edge.points.slice(3,10)) {
            const u = ((side === "right" ? point.y-from.y : point.x-from.x))/CELL_SIZE;
            const w = Math.abs(side === "right" ? point.x-from.x : point.y-from.y)/CELL_SIZE;
            expect(w).toBeLessThanOrEqual(0.38 + 1e-10);
            expect(u-w).toBeGreaterThanOrEqual(0.015 - 1e-10);
            expect(1-u-w).toBeGreaterThanOrEqual(0.015 - 1e-10);
          }
        }
      }
    }
  });

  it("produces non-self-intersecting sampled outlines including thin grids", () => {
    for (const [rows,cols] of [[1,1],[1,8],[8,1],[4,5]]) for (let seed=0;seed<16;seed++) {
      for (const p of generatePuzzle(rows!,cols!,`shape2:cross-${seed}`).pieces) {
        const outline = [sampleEdge(p.edges.top.points),sampleEdge(p.edges.right.points),
          sampleEdge(p.edges.bottom.points).reverse(),sampleEdge(p.edges.left.points).reverse()]
          .flatMap(edge => edge.slice(0,-1));
        let crossings = 0;
        for(let i=0;i<outline.length;i++) for(let j=i+2;j<outline.length;j++) {
          if(i===0 && j===outline.length-1) continue;
          if (intersects(outline[i]!,outline[(i+1)%outline.length]!,outline[j]!,outline[(j+1)%outline.length]!)) crossings++;
        }
        expect(crossings).toBe(0);
      }
    }
  });

  it("retains both neck overhangs when a wide shoulder hits the safety corridor", () => {
    const puzzle = generatePuzzle(20, 25, "shape2:sweep-2014");
    for (const piece of puzzle.pieces) for (const side of ["right", "bottom"] as const) {
      const edge = piece.edges[side];
      if (edge.kind === "flat") continue;
      const axis = side === "right" ? "y" : "x";
      expect(edge.points[4]![axis]).toBeLessThan(edge.points[3]![axis]);
      expect(edge.points[8]![axis]).toBeGreaterThan(edge.points[9]![axis]);
    }
  });

  it("broadens visible width, keeps depth, and reduces similar whole pieces", () => {
    const old = generatePuzzle(20,25,"comparison");
    const next = generatePuzzle(20,25,"shape2:comparison");
    const widths:number[] = [], depths:number[] = [];
    for(const p of next.pieces) for(const side of ["right","bottom"] as const) {
      if(p.edges[side].kind === "flat") continue;
      const points=p.edges[side].points;
      const bulb=sampleEdge(points.slice(3,10),64);
      const us=bulb.map(v=> side === "right" ? v.y : v.x);
      widths.push((Math.max(...us)-Math.min(...us))/CELL_SIZE);
      depths.push(Math.abs(side === "right" ? points[6]!.x-points[0]!.x : points[6]!.y-points[0]!.y)/CELL_SIZE);
    }
    expect(Math.min(...widths)).toBeLessThan(0.23);
    expect(Math.max(...widths)).toBeGreaterThan(0.6);
    expect(Math.min(...depths)).toBeGreaterThanOrEqual(0.18-1e-10);
    expect(Math.max(...depths)).toBeLessThanOrEqual(0.38+1e-10);
    const before=nearest(old.pieces).filter(d=>d<0.04).length;
    const after=nearest(next.pieces).filter(d=>d<0.04).length;
    expect(after).toBeLessThan(before*0.25);
  });
});
