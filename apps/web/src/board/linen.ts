import { Texture } from "pixi.js";
import type { LinenWeave } from "../theme";

/**
 * Thread pitch in tile pixels — the design's 4px weave (the crosshatch on the
 * mat in "Cafe Puzzle - App"). One shadow line per pitch with a highlight
 * alongside it, so a thread reads as round rather than as a drawn grid line.
 */
const PITCH = 4;

/**
 * Tile edge. A power of two so the GPU can mipmap it: at min zoom the pitch
 * falls under a pixel, and without mipmaps that samples as moiré rather than
 * as an even tone. Must stay a whole multiple of PITCH or the tile won't
 * repeat seamlessly.
 */
const TILE = 32;

/**
 * A seamless linen swatch, baked once per theme. Canvas 2D rather than Pixi
 * Graphics because the weave is a texture to be sampled at arbitrary scale,
 * not geometry — drawing thousands of hairlines per frame is the thing this
 * exists to avoid.
 */
export function buildLinenTexture(weave: LinenWeave): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d")!;
  for (let i = 0; i < TILE; i += PITCH) {
    ctx.fillStyle = weave.shadow;
    ctx.fillRect(i, 0, 1, TILE);
    ctx.fillRect(0, i, TILE, 1);
    ctx.fillStyle = weave.highlight;
    ctx.fillRect((i + 1) % TILE, 0, 1, TILE);
    ctx.fillRect(0, (i + 1) % TILE, TILE, 1);
  }
  const texture = Texture.from(canvas);
  texture.source.addressMode = "repeat";
  texture.source.autoGenerateMipmaps = true;
  texture.source.update();
  return texture;
}
