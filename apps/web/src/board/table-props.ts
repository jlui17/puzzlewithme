import { CELL_SIZE, matBounds, type Puzzle } from "@puzzlewithme/geometry";
import { Container, Graphics } from "pixi.js";

interface PropPalette {
  notebook: number;
  notebookEdge: number;
  pages: number;
  band: number;
  pen: number;
  penHighlight: number;
  brass: number;
  pods: number;
  podsShade: number;
  coffee: number;
  crema: number;
  porcelain: number;
}

const DAY: PropPalette = {
  notebook: 0x8e4536,
  notebookEdge: 0x66301f,
  pages: 0xeaddc7,
  band: 0x2f190b,
  pen: 0x1e2836,
  penHighlight: 0x3a4759,
  brass: 0xcfa860,
  pods: 0xf3ede4,
  podsShade: 0xb8ac9d,
  coffee: 0x6a4527,
  crema: 0xd6a870,
  porcelain: 0xefe3d0,
};

const NIGHT: PropPalette = {
  ...DAY,
  notebook: 0x613329,
  notebookEdge: 0x452219,
  pages: 0xb9aa93,
  pen: 0x141c27,
  penHighlight: 0x293543,
  pods: 0xcfc5b7,
  podsShade: 0x8f8578,
  porcelain: 0xc9b89e,
};

/**
 * Table objects drawn in puzzle-space. The returned container belongs below
 * the mat in BoardRenderer's camera-transformed viewport, so the props pan and
 * zoom with the cloth and the cloth naturally covers their overlapping edges.
 */
export function buildTableProps(puzzle: Puzzle, night: boolean): Container {
  const palette = night ? NIGHT : DAY;
  const bounds = matBounds(puzzle.rows, puzzle.cols);
  const layer = new Container({ label: "table-props" });

  layer.addChild(buildNotebook(palette, bounds.maxX - 2.7 * CELL_SIZE, bounds.maxY - 3.1 * CELL_SIZE));
  layer.addChild(buildPen(palette, bounds.maxX - 1.5 * CELL_SIZE, bounds.maxY + 0.2 * CELL_SIZE));
  layer.addChild(buildPods(palette, bounds.minX - 1.4 * CELL_SIZE, bounds.minY + 5 * CELL_SIZE));
  layer.addChild(buildMug(palette, bounds.minX - 2.3 * CELL_SIZE, bounds.maxY - 2.5 * CELL_SIZE));

  return layer;
}

function buildNotebook(p: PropPalette, x: number, y: number): Container {
  const node = positioned(x, y, 9);
  const w = 4.4 * CELL_SIZE;
  const h = 5.45 * CELL_SIZE;
  node.addChild(shadow(0.18 * CELL_SIZE, 0.28 * CELL_SIZE, w, h, 0.22 * CELL_SIZE));
  node.addChild(
    new Graphics()
      .roundRect(-0.08 * CELL_SIZE, 0.14 * CELL_SIZE, 0.22 * CELL_SIZE, h - 0.28 * CELL_SIZE, 0.05 * CELL_SIZE)
      .fill(p.pages),
  );
  node.addChild(new Graphics().roundRect(0, 0, w, h, 0.18 * CELL_SIZE).fill(p.notebook));
  node.addChild(new Graphics().roundRect(0, 0, 0.32 * CELL_SIZE, h, 0.14 * CELL_SIZE).fill(p.notebookEdge));
  node.addChild(new Graphics().rect(0.78 * CELL_SIZE, -0.08 * CELL_SIZE, 0.24 * CELL_SIZE, h + 0.16 * CELL_SIZE).fill(p.band));
  return node;
}

function buildPen(p: PropPalette, x: number, y: number): Container {
  const node = positioned(x, y, -34);
  const w = 4.3 * CELL_SIZE;
  const h = 0.34 * CELL_SIZE;
  node.addChild(shadow(0.12 * CELL_SIZE, 0.18 * CELL_SIZE, w, h, 0.08 * CELL_SIZE));
  node.addChild(new Graphics().roundRect(0, 0, w, h, 0.07 * CELL_SIZE).fill(p.pen));
  node.addChild(new Graphics().rect(0, 0, w, h * 0.3).fill(p.penHighlight));
  node.addChild(
    new Graphics()
      .moveTo(-0.58 * CELL_SIZE, h / 2)
      .lineTo(0, 0)
      .lineTo(0, h)
      .closePath()
      .fill(p.brass),
  );
  node.addChild(new Graphics().roundRect(w - 1.25 * CELL_SIZE, -0.04 * CELL_SIZE, 1.28 * CELL_SIZE, h + 0.08 * CELL_SIZE, 0.06 * CELL_SIZE).fill(p.penHighlight));
  node.addChild(new Graphics().rect(w - 1.34 * CELL_SIZE, -0.04 * CELL_SIZE, 0.1 * CELL_SIZE, h + 0.08 * CELL_SIZE).fill(p.brass));
  return node;
}

function buildPods(p: PropPalette, x: number, y: number): Container {
  const node = positioned(x, y, 17);
  const w = 1.9 * CELL_SIZE;
  const h = 1.7 * CELL_SIZE;
  node.addChild(shadow(0.1 * CELL_SIZE, 0.18 * CELL_SIZE, w, h, 0.45 * CELL_SIZE));
  node.addChild(new Graphics().roundRect(0, 0, w, h, 0.48 * CELL_SIZE).fill(p.pods));
  node.addChild(new Graphics().roundRect(0.28 * CELL_SIZE, -0.05 * CELL_SIZE, w - 0.56 * CELL_SIZE, 0.16 * CELL_SIZE, 0.06 * CELL_SIZE).fill(p.podsShade));
  node.addChild(new Graphics().rect(0.16 * CELL_SIZE, h * 0.35, w - 0.32 * CELL_SIZE, 0.035 * CELL_SIZE).fill({ color: 0x26180c, alpha: 0.18 }));
  return node;
}

function buildMug(p: PropPalette, x: number, y: number): Container {
  const node = positioned(x, y, -8);
  const size = 3.05 * CELL_SIZE;
  node.addChild(shadow(0.18 * CELL_SIZE, 0.25 * CELL_SIZE, size, size, size / 2));
  node.addChild(new Graphics().circle(size / 2, size / 2, size / 2).fill(p.porcelain));
  node.addChild(new Graphics().circle(size / 2, size / 2, size * 0.36).fill(p.coffee));
  node.addChild(
    new Graphics()
      .ellipse(size * 0.42, size * 0.38, size * 0.17, size * 0.08)
      .fill({ color: p.crema, alpha: 0.48 }),
  );
  return node;
}

function positioned(x: number, y: number, degrees: number): Container {
  const node = new Container();
  node.position.set(x, y);
  node.rotation = (degrees * Math.PI) / 180;
  return node;
}

function shadow(x: number, y: number, width: number, height: number, radius: number): Graphics {
  return new Graphics()
    .roundRect(x, y, width, height, radius)
    .fill({ color: 0x120902, alpha: 0.42 });
}
