import { CELL_SIZE, matBounds, type Puzzle } from "@puzzlewithme/geometry";
import { Container, Graphics, Texture, TilingSprite } from "pixi.js";
import type { Theme, WoodPalette } from "../theme";
import type { WorldLayer } from "./world-layer";

/**
 * A procedural walnut surface in puzzle-space. It is the first child of the
 * camera viewport, so grain, knots, mat, pieces, and loose table objects all
 * share one physical coordinate system as the player pans and zooms.
 */
export function buildTableSurface(puzzle: Puzzle, theme: Theme): WorldLayer {
  const palette = theme.wood;
  const mat = matBounds(puzzle.rows, puzzle.cols);
  const margin = 50 * CELL_SIZE;
  const x = mat.minX - margin;
  const y = mat.minY - margin;
  const width = mat.maxX - mat.minX + margin * 2;
  const height = mat.maxY - mat.minY + margin * 2;
  const container = new Container({ label: "world-table" });

  container.addChild(new Graphics().rect(x, y, width, height).fill(palette.base));
  drawBroadBands(container, x, y, width, height, palette);

  const texture = buildWoodTexture(palette);
  const grain = new TilingSprite({ texture, x, y, width, height });
  // One texture repeat spans about thirteen puzzle cells. The broad repeat is
  // large enough to read as a continuous slab instead of wallpaper.
  grain.tileScale.set(2.5);
  container.addChild(grain);

  drawKnot(container, mat.minX + 0.12 * (mat.maxX - mat.minX), mat.maxY + 2.4 * CELL_SIZE, 2.3 * CELL_SIZE, 0.82 * CELL_SIZE, palette);
  drawKnot(container, mat.maxX - 0.08 * (mat.maxX - mat.minX), mat.minY - 2.1 * CELL_SIZE, 1.65 * CELL_SIZE, 0.56 * CELL_SIZE, palette);
  drawChecks(container, mat, palette);

  return { container, textures: [texture] };
}

function drawBroadBands(
  container: Container,
  x: number,
  y: number,
  width: number,
  height: number,
  palette: WoodPalette,
): void {
  const bands = new Graphics();
  const pitch = 8.2 * CELL_SIZE;
  for (let at = y; at < y + height; at += pitch) {
    bands.rect(x, at, width, pitch * 0.47).fill({ color: palette.band, alpha: 0.3 });
    bands.rect(x, at + pitch * 0.73, width, 0.12 * CELL_SIZE).fill({ color: palette.check, alpha: 0.15 });
  }
  container.addChild(bands);
}

function drawKnot(
  container: Container,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  palette: WoodPalette,
): void {
  const knot = new Graphics();
  for (let i = 5; i >= 1; i--) {
    const t = i / 5;
    knot
      .ellipse(cx, cy, rx * t, ry * t)
      .stroke({ width: 0.08 * CELL_SIZE, color: palette.knotRing, alpha: 0.18 + (1 - t) * 0.16 });
  }
  knot.ellipse(cx, cy, rx * 0.22, ry * 0.25).fill({ color: palette.knot, alpha: 0.92 });
  container.addChild(knot);
}

function drawChecks(
  container: Container,
  mat: ReturnType<typeof matBounds>,
  palette: WoodPalette,
): void {
  const checks = new Graphics();
  checks
    .moveTo(mat.minX - 6.2 * CELL_SIZE, mat.minY + 4.8 * CELL_SIZE)
    .bezierCurveTo(
      mat.minX - 3.8 * CELL_SIZE,
      mat.minY + 4.5 * CELL_SIZE,
      mat.minX - 2.1 * CELL_SIZE,
      mat.minY + 5.3 * CELL_SIZE,
      mat.minX + 0.4 * CELL_SIZE,
      mat.minY + 5.05 * CELL_SIZE,
    )
    .stroke({ width: 0.06 * CELL_SIZE, color: palette.check, alpha: 0.52 });
  checks
    .moveTo(mat.maxX - 1.4 * CELL_SIZE, mat.maxY + 1.6 * CELL_SIZE)
    .bezierCurveTo(
      mat.maxX + 0.2 * CELL_SIZE,
      mat.maxY + 1.15 * CELL_SIZE,
      mat.maxX + 2.6 * CELL_SIZE,
      mat.maxY + 1.9 * CELL_SIZE,
      mat.maxX + 4.4 * CELL_SIZE,
      mat.maxY + 1.35 * CELL_SIZE,
    )
    .stroke({ width: 0.045 * CELL_SIZE, color: palette.check, alpha: 0.45 });
  container.addChild(checks);
}

/** Seamless, deterministic wood grain swatch used by the world-space table. */
function buildWoodTexture(palette: WoodPalette): Texture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  let seed = 0x51f15e;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  ctx.lineCap = "round";
  for (let line = 0; line < 54; line++) {
    const baseY = random() * size;
    const amplitude = 1.5 + random() * 8;
    const cycles = 1 + Math.floor(random() * 4);
    const phase = random() * Math.PI * 2;
    ctx.beginPath();
    for (let px = 0; px <= size; px += 8) {
      const py = baseY + Math.sin((px / size) * Math.PI * 2 * cycles + phase) * amplitude;
      if (px === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = line % 5 === 0 ? palette.light : palette.dark;
    ctx.lineWidth = line % 7 === 0 ? 2 : 0.7 + random() * 0.8;
    ctx.stroke();
  }

  const texture = Texture.from(canvas);
  texture.source.addressMode = "repeat";
  texture.source.autoGenerateMipmaps = true;
  texture.source.update();
  return texture;
}
