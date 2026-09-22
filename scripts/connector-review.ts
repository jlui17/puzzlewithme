/** Reproduce: bun scripts/connector-review.ts [output-directory] */
import { mkdir, writeFile } from "node:fs/promises";
import { generatePuzzle } from "../packages/geometry/src/puzzle.js";
import { pieceSvgPath } from "../packages/geometry/src/path.js";
import { CELL_SIZE } from "../packages/geometry/src/constants.js";
import { sampleEdge, silhouette, silhouetteDistance } from "../packages/geometry/src/variety.js";
import type { Piece } from "../packages/geometry/src/types.js";

const out = process.argv[2] ?? ".luidocs/connector-review";
await mkdir(out, { recursive: true });
const sides = ["top", "right", "bottom", "left"] as const;
function analyze(pieces: Piece[]) {
  const shapes = pieces.map(silhouette);
  const nearest = pieces.map(() => Infinity);
  const pairs: { a: number; b: number; turn: number; distance: number }[] = [];
  let nearPairs = 0;
  for (let i = 0; i < pieces.length; i++) for (let j = 0; j < i; j++) {
    let distance = Infinity, rotation = 0;
    for (let turn = 0; turn < 4; turn++) {
      if (!sides.every((s,k) => pieces[i]!.edges[s].kind === pieces[j]!.edges[sides[(k+turn)%4]!].kind)) continue;
      const d = silhouetteDistance(shapes[i]!, shapes[j]!, turn);
      if (d < distance) { distance = d; rotation = turn; }
    }
    nearest[i] = Math.min(nearest[i]!, distance);
    nearest[j] = Math.min(nearest[j]!, distance);
    if (distance < 0.04) nearPairs++;
    if (Number.isFinite(distance)) pairs.push({ a:i, b:j, turn:rotation, distance });
  }
  pairs.sort((a,b) => a.distance-b.distance);
  const widths:number[]=[], depths:number[]=[];
  for(const p of pieces) for(const side of ["right","bottom"] as const) {
    const edge = p.edges[side];
    if(edge.kind === "flat") continue;
    const us=sampleEdge(edge.points.slice(3,10),128).map(v=>side === "right" ? v.y : v.x);
    widths.push((Math.max(...us)-Math.min(...us))/CELL_SIZE*100);
    depths.push(Math.abs(side === "right" ? edge.points[6]!.x-edge.points[0]!.x : edge.points[6]!.y-edge.points[0]!.y)/CELL_SIZE*100);
  }
  return { nearPairs, nearPieces:nearest.filter(d=>d<0.04).length,
    closest:pairs.slice(0,6), width:[Math.min(...widths),Math.max(...widths)],
    depth:[Math.min(...depths),Math.max(...depths)] };
}

const results=[];
for(const [rows,cols] of [[9,12],[20,25],[25,40]]) {
  const seed="connector-review";
  const versions=[];
  for(const prefix of ["","shape2:"]) {
    const start=performance.now();
    const puzzle=generatePuzzle(rows!,cols!,prefix+seed);
    const generationMs=performance.now()-start;
    versions.push({ ...analyze(puzzle.pieces), generationMs,
      paths:puzzle.pieces.map(p=>pieceSvgPath(p,{local:true})) });
  }
  results.push({ count:rows!*cols!,rows,cols,versions });
}
// Thousands of small seeds exercise extremes; larger grids cover runtime and
// final-row pieces where only one or zero edges remain available for retries.
let puzzles=0, pieces=0, edges=0, maxGenerationMs=0;
for(let seed=0;seed<2030;seed++) {
  const [rows,cols]= seed<2000 ? [[1,1],[1,8],[8,1],[3,4]][seed%4]! : [[9,12],[20,25],[25,40]][seed%3]!;
  const start=performance.now();
  const p=generatePuzzle(rows!,cols!,`shape2:sweep-${seed}`);
  maxGenerationMs=Math.max(maxGenerationMs,performance.now()-start);
  puzzles++; pieces+=p.pieces.length;
  for(const piece of p.pieces) for(const side of ["right","bottom"] as const) {
    const edge=piece.edges[side]; if(edge.kind === "flat") continue; edges++;
    const other=p.pieces[piece.neighbors[side]!]!.edges[side === "right" ? "left" : "top"];
    if(edge.points!==other.points || edge.kind===other.kind) throw Error("Complement mismatch");
    for(const point of edge.points.slice(3,10)) {
      const from=edge.points[0]!;
      const u=(side === "right" ? point.y-from.y : point.x-from.x)/CELL_SIZE;
      const w=Math.abs(side === "right" ? point.x-from.x : point.y-from.y)/CELL_SIZE;
      if(!Number.isFinite(u+w) || w>0.38+1e-10 || u-w<0.015-1e-10 || 1-u-w<0.015-1e-10) throw Error("Corridor violation");
    }
    // Branches are vertically monotone and live on opposite sides of apex.
    const axis=side === "right" ? "y" : "x";
    const apex=edge.points[6]![axis];
    if(edge.points[4]![axis]>=edge.points[3]![axis] || edge.points[8]![axis]<=edge.points[9]![axis]) throw Error(`Missing neck overhang: seed=${seed}, piece=${piece.id}, side=${side}`);
    if(edge.points.slice(3,6).some(v=>v[axis]>=apex) || edge.points.slice(7,10).some(v=>v[axis]<=apex)) throw Error("Crossed flanks");
  }
}
const sweep={puzzles,pieces,edges,maxGenerationMs};
const compact=results.map(r=>({...r,versions:r.versions.map(({paths,...v})=>v)}));
await writeFile(`${out}/results.json`,JSON.stringify({sweep,results:compact},null,2));
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connector variety review</title>
<style>body{margin:0;padding:24px;background:#f5f2ec;color:#262b2d;font:16px system-ui}main{max-width:1300px;margin:auto}h1{font-size:26px}h2{font-size:20px;margin:12px 0}select,button{font:inherit;padding:8px 12px}header{display:flex;gap:18px;align-items:center;flex-wrap:wrap}.columns{display:grid;grid-template-columns:1fr 1fr;gap:24px}.panel{background:white;border:1px solid #d8d5cd;border-radius:12px;padding:16px}svg{width:100%;display:block}p{line-height:1.5}.muted{color:#62676a;font-size:14px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;border-bottom:1px solid #ddd;padding:8px}.pair{margin:16px 0}details{margin-top:20px}button[aria-pressed=true]{background:#263e41;color:white}@media(max-width:700px){body{padding:12px}.columns{grid-template-columns:1fr}}</style>
<main><header><h1>More distinctive connectors</h1><label>Puzzle <select id="size"><option value="0">108 pieces</option><option value="1">500 pieces</option><option value="2">1,000 pieces</option></select></label><button id="sample" aria-pressed="true">Piece samples</button><button id="worst" aria-pressed="false">Most similar pairs</button></header>
<p>Same seed and tab/hole directions. Plain pieces expose the shape differences.</p><div id="metrics"></div><div class="columns"><section class="panel"><h2>Before</h2><div id="before"></div></section><section class="panel"><h2>After</h2><div id="after"></div></section></div>
<details><summary>Method and limits</summary><p>“Near pair” means matching tab/hole patterns under a quarter-turn and sampled-curve RMS distance below 4% of a side. This is a tuning heuristic, not a perceptual guarantee. Rotations are included even though gameplay does not rotate pieces. The most similar pairs are chosen separately for each generator, not cherry-picked.</p><p>Widths measure the actual curved bulb at 128 samples per cubic, not control points. Wide/deep combinations are constrained to prevent adjacent cuts crossing. Bounded retries prefer distinctive whole pieces but do not guarantee uniqueness. Samples show 24 evenly spaced piece IDs. Depth remains 18–38%.</p><p>Geometry sweep: ${puzzles.toLocaleString()} puzzles, ${pieces.toLocaleString()} pieces, ${edges.toLocaleString()} shared edges. Zero corridor, complement, neck-overhang, or flank-order violations. Automated correctness is not a substitute for your play-feel sign-off.</p></details></main>
<script>const data=${JSON.stringify(results)};let worst=false;const size=document.getElementById('size');function draw(){const r=data[Number(size.value)];document.getElementById('metrics').innerHTML='<table><tr><th>Measurement</th><th>Before</th><th>After</th></tr>'+[['Visible width',...r.versions.map(v=>v.width.map(n=>n.toFixed(1)).join('–')+'%')],['Near pairs',...r.versions.map(v=>v.nearPairs)],['Pieces with a near match',...r.versions.map(v=>v.nearPieces+' / '+r.count)]].map(row=>'<tr>'+row.map(v=>'<td>'+v+'</td>').join('')+'</tr>').join('')+'</table><p class="muted">'+(worst?'Six closest pairs in each version. Second piece rotated into alignment.':'24 pieces from the selected puzzle, at matching IDs and scale.')+'</p>';r.versions.forEach((v,index)=>{let content='';if(worst){content=v.closest.map(p=>'<div class="pair"><svg viewBox="-45 -45 410 205">'+piece(v.paths[p.a],0,0,0)+piece(v.paths[p.b],220,0,-p.turn*90)+'</svg><div class="muted">Pieces '+p.a+' + '+p.b+' · distance '+(p.distance*100).toFixed(2)+'% of a side</div></div>').join('')}else{content='<svg viewBox="-45 -45 840 1280">'+Array.from({length:24},(_,k)=>{const id=Math.floor(k*(r.count-1)/23);return piece(v.paths[id],(k%4)*210,Math.floor(k/4)*210,0)+'<text x="'+((k%4)*210+50)+'" y="'+(Math.floor(k/4)*210+160)+'" text-anchor="middle" font-size="14">'+id+'</text>'}).join('')+'</svg>'}document.getElementById(index?'after':'before').innerHTML=content})}function piece(path,x,y,angle){return '<g transform="translate('+x+' '+y+')"><path transform="rotate('+angle+' 50 50)" d="'+path+'" fill="#d5e4e1" stroke="#29474b" stroke-width="1.5"/></g>'}size.onchange=draw;for(const id of ['sample','worst'])document.getElementById(id).onclick=()=>{worst=id==='worst';document.getElementById('sample').setAttribute('aria-pressed',String(!worst));document.getElementById('worst').setAttribute('aria-pressed',String(worst));draw()};draw();</script>`;
await writeFile(`${out}/comparison.html`,html);
console.log(JSON.stringify({sweep,results:compact},null,2));
