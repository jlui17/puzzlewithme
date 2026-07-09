import { CELL_SIZE, pieceSvgPath, type Puzzle } from "@puzzlewithme/geometry";
import { Rectangle, Texture } from "pixi.js";
import {
  ATLAS_SIZE,
  MAX_TILE_PX,
  MIN_TILE_PX,
  OVERHANG,
  TILE_WORLD,
} from "./constants";

/**
 * Bakes each piece's outline-clipped bitmap ONCE into a few large texture
 * atlases (NFR-1: 1000 pieces at 60 fps). A per-piece canvas/texture would mean
 * 1000 GPU textures and 1000 draw batches; instead we render every piece into
 * shared ~4096px canvases and hand out per-piece sub-textures (frames) that all
 * share one GPU texture per atlas, so the renderer can batch pieces into few
 * draw calls.
 *
 * Atlas math (see constants.ts for the pixel budget rationale):
 *   tilePx   = clamp(TILE_WORLD * imagePxPerWorldUnit, MIN, MAX)  — bake res
 *   stride   = tilePx + TILE_PAD                                  — avoid bleed
 *   perRow   = floor(ATLAS_SIZE / stride)                          — tiles/row
 *   perAtlas = perRow^2
 *   atlases  = ceil(pieceCount / perAtlas)
 * Piece id maps to (atlas, tileCol, tileRow) by simple division; the frame is
 * the tilePx-square region at that slot.
 */

// 2px transparent gutter between tiles so a neighbor's texels never bleed into a
// piece under linear filtering at fractional zoom.
const TILE_PAD = 2;

// Outward edge bleed in atlas texels. clip() antialiases the outline, so a
// piece's boundary texels carry fractional alpha; two snapped pieces share the
// identical curve (path.ts) but are baked in separate tiles with independent
// pixel grids, so their AA coverage doesn't sum to 1 where they abut and the
// deficit lets the dark board show through as a thin black seam at joints. We
// re-stamp each piece's clipped draw at 8 sub-texel offsets to dilate its opaque
// region outward by BLEED_PX, so at every seam point at least one side is fully
// opaque and the board can't peek through.
//
// BLEED_PX = 1: lower bound is >=1 texel, the minimum overlap that closes the
// sub-texel AA gap between the two independently-rasterized edges. Upper bound is
// < TILE_PAD (2), so even where a tab tip touches its tile border the bleed lands
// in the transparent gutter and never reaches a neighbor cell's frame rectangle.
// Chosen at the low end of that 1..2 window; not measured on-device.
const BLEED_PX = 1;

export interface AtlasResult {
  /** Per-piece sub-texture keyed by piece id. */
  pieceTextures: Map<number, Texture>;
  /** World size a baked tile represents (cell + overhang on all sides). */
  tileWorld: number;
  /** Tab overhang baked around each cell, in world units. */
  overhang: number;
  /** Atlas textures to destroy on teardown. */
  atlases: Texture[];
}

export function buildAtlases(
  puzzle: Puzzle,
  image: CanvasImageSource,
  imageWidth: number,
  imageHeight: number,
): AtlasResult {
  const { rows, cols, pieces } = puzzle;
  const frameW = cols * CELL_SIZE;
  const frameH = rows * CELL_SIZE;

  // Image pixels per world unit. The image is mapped onto the frame (0,0)..
  // (frameW, frameH); pieces are ~square per FR-3, so a small per-axis stretch
  // is expected and harmless.
  const imgScaleX = imageWidth / frameW;
  const imgScaleY = imageHeight / frameH;
  const avgScale = (imgScaleX + imgScaleY) / 2;

  const tilePx = Math.max(MIN_TILE_PX, Math.min(MAX_TILE_PX, Math.round(TILE_WORLD * avgScale)));
  const stride = tilePx + TILE_PAD;
  const perRow = Math.max(1, Math.floor(ATLAS_SIZE / stride));
  const perAtlas = perRow * perRow;
  const atlasCount = Math.ceil(pieces.length / perAtlas);
  const pixelScale = tilePx / TILE_WORLD;

  const pieceTextures = new Map<number, Texture>();
  const atlases: Texture[] = [];

  for (let a = 0; a < atlasCount; a++) {
    const canvas = document.createElement("canvas");
    canvas.width = ATLAS_SIZE;
    canvas.height = ATLAS_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable for atlas bake");

    const startId = a * perAtlas;
    const endId = Math.min(pieces.length, startId + perAtlas);

    for (let id = startId; id < endId; id++) {
      const piece = pieces[id]!;
      const slot = id - startId;
      const tileCol = slot % perRow;
      const tileRow = Math.floor(slot / perRow);
      const slotX = tileCol * stride;
      const slotY = tileRow * stride;

      const cell = piece.framePosition;

      // Clip to the piece outline (local coords are relative to the cell origin).
      const path = new Path2D(pieceSvgPath(piece, { local: true }));

      // Draw the image region under this tile. Source rect maps the tile's world
      // box to image pixels; drawImage clips a partly-off-image source (border
      // overhang) proportionally, keeping alignment.
      const srcX = (cell.x - OVERHANG) * imgScaleX;
      const srcY = (cell.y - OVERHANG) * imgScaleY;
      const srcW = TILE_WORLD * imgScaleX;
      const srcH = TILE_WORLD * imgScaleY;

      // Stamp the clipped piece at a pixel offset. Offsetting the whole tile
      // space moves clip and image together, so a shifted stamp is the same piece
      // translated by (dx, dy) atlas texels.
      const stamp = (dx: number, dy: number): void => {
        ctx.save();
        ctx.translate(slotX + dx, slotY + dy);
        ctx.scale(pixelScale, pixelScale);
        ctx.translate(OVERHANG, OVERHANG);
        ctx.clip(path);
        ctx.drawImage(image, srcX, srcY, srcW, srcH, -OVERHANG, -OVERHANG, TILE_WORLD, TILE_WORLD);
        ctx.restore();
      };

      // 8-way dilation: the diagonal stamps matter because a texel one unit
      // diagonally outside the outline is reached only by the diagonal offset;
      // the axis stamps each miss it in the other axis. Centered stamp drawn last
      // so its opaque interior sits on top and the piece stays crisp inside.
      const b = BLEED_PX;
      stamp(-b, -b);
      stamp(0, -b);
      stamp(b, -b);
      stamp(-b, 0);
      stamp(b, 0);
      stamp(-b, b);
      stamp(0, b);
      stamp(b, b);
      stamp(0, 0);
    }

    const atlasTexture = Texture.from(canvas);
    atlases.push(atlasTexture);

    for (let id = startId; id < endId; id++) {
      const slot = id - startId;
      const tileCol = slot % perRow;
      const tileRow = Math.floor(slot / perRow);
      pieceTextures.set(
        id,
        new Texture({
          source: atlasTexture.source,
          frame: new Rectangle(tileCol * stride, tileRow * stride, tilePx, tilePx),
        }),
      );
    }
  }

  return { pieceTextures, tileWorld: TILE_WORLD, overhang: OVERHANG, atlases };
}
