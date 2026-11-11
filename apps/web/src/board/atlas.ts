import { CELL_SIZE, pieceSvgPath, type Puzzle } from "@puzzlewithme/geometry";
import { Rectangle, Texture } from "pixi.js";
import type { ShadowFrom } from "../theme";
import {
  ATLAS_SIZE,
  MAX_TILE_PX,
  MIN_TILE_PX,
  OVERHANG,
  PIECE_EDGE_WIDTH,
  PIECE_JOINT_COLOR,
  PIECE_JOINT_WIDTH,
  SHADOW_BLUR,
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
 * the tilePx-square region at that slot. An atlas's canvas is only as big as
 * the tiles it holds, so a 1000-piece board's second atlas is a sliver, not
 * another full 4096 square.
 *
 * Next to the faces, each piece gets three plain white tiles the renderer
 * tints: its silhouette grown by the edge width (the side face and the light
 * edge of a loose piece) and a blurred silhouette for each light (its shadow).
 * They are baked at lower resolution than the faces (they are dark, thin or
 * blurred) into their own atlases, and every atlas is in the same draw batch.
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

// Silhouette and shadow resolution as a fraction of the face bake's. The
// silhouette shows as a 3-unit side face and a half-unit edge, so half
// resolution holds its outline; a shadow is a blur, so a quarter is plenty.
const SILHOUETTE_RES = 0.5;
const SHADOW_RES = 0.25;

/** World margin around the piece tile that holds the grown silhouette. */
const SILHOUETTE_PAD = 2 * PIECE_EDGE_WIDTH;
/** World margin around the piece tile that holds the softest shadow's blur (3 sigma). */
const SHADOW_PAD = 3 * Math.max(SHADOW_BLUR.lamp, SHADOW_BLUR.overhead);

export interface EffectTile {
  pad: number;
  world: number;
}

export interface AtlasResult {
  /** Per-piece sub-texture keyed by piece id. */
  pieceTextures: Map<number, Texture>;
  /** Per-piece white silhouette, grown by the edge width; tinted for the side face and the edge. */
  silhouetteTextures: Map<number, Texture>;
  /** Per-piece white blurred silhouette for each light; tinted black for the shadow. */
  shadowTextures: Record<ShadowFrom, Map<number, Texture>>;
  /** World size a baked tile represents (cell + overhang on all sides). */
  tileWorld: number;
  /** Tab overhang baked around each cell, in world units. */
  overhang: number;
  /** Silhouette tiles: the world margin they add around the piece tile on every side, and their world size. */
  silhouetteTile: EffectTile;
  /** Shadow tiles, likewise. */
  shadowTile: EffectTile;
  /** Atlas textures to destroy on teardown. */
  atlases: Texture[];
}

/**
 * Intersect a tile's world box (cell plus overhang on all sides) with the
 * frame (= the image's world extent), in world units. The overhang region past
 * the frame edge holds no image anyway (a border piece's flat side), so the
 * clamped draw is visually identical to the spec's proportional clipping —
 * but it never hands drawImage an out-of-bounds source rect, which iOS Safari
 * refuses to draw at all instead of clipping.
 */
export function clampTileToFrame(
  cellX: number,
  cellY: number,
  overhang: number,
  tileWorld: number,
  frameW: number,
  frameH: number,
): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.max(0, cellX - overhang),
    y0: Math.max(0, cellY - overhang),
    x1: Math.min(frameW, cellX - overhang + tileWorld),
    y1: Math.min(frameH, cellY - overhang + tileWorld),
  };
}

/**
 * Packs `count` square tiles of `tilePx` into as few atlases as fit, calling
 * `draw` once per tile with its slot's top-left, and returns each tile's frame
 * in order.
 */
function bakeTiles(
  count: number,
  tilePx: number,
  atlases: Texture[],
  draw: (ctx: CanvasRenderingContext2D, index: number, slotX: number, slotY: number) => void,
): Texture[] {
  const stride = tilePx + TILE_PAD;
  const perRow = Math.max(1, Math.floor(ATLAS_SIZE / stride));
  const perAtlas = perRow * perRow;
  const frames: Texture[] = [];
  for (let start = 0; start < count; start += perAtlas) {
    const n = Math.min(perAtlas, count - start);
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(n, perRow) * stride;
    canvas.height = Math.ceil(n / perRow) * stride;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable for atlas bake");
    const slot = (i: number) => ({ x: (i % perRow) * stride, y: Math.floor(i / perRow) * stride });
    for (let i = 0; i < n; i++) {
      const { x, y } = slot(i);
      draw(ctx, start + i, x, y);
    }
    const atlas = Texture.from(canvas);
    atlases.push(atlas);
    for (let i = 0; i < n; i++) {
      const { x, y } = slot(i);
      frames.push(new Texture({ source: atlas.source, frame: new Rectangle(x, y, tilePx, tilePx) }));
    }
  }
  return frames;
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
  const pixelScale = tilePx / TILE_WORLD;
  const paths = pieces.map((piece) => new Path2D(pieceSvgPath(piece, { local: true })));
  const atlases: Texture[] = [];
  const byPiece = (frames: Texture[]) => new Map(frames.map((frame, id) => [id, frame]));

  const faces = bakeTiles(pieces.length, tilePx, atlases, (ctx, id, slotX, slotY) => {
    const cell = pieces[id]!.framePosition;
    // Clip to the piece outline (local coords are relative to the cell origin).
    const path = paths[id]!;

    // Draw the image region under this tile, clipping the source rect to the
    // image OURSELVES. The spec says drawImage clips a partly-off-image
    // source proportionally, and desktop browsers do — but iOS Safari
    // silently draws NOTHING for an out-of-bounds source rect, which blanked
    // every border piece's tile (their overhang margin pokes past the photo
    // edge) and made edge pieces invisible on iPhones.
    const vis = clampTileToFrame(cell.x, cell.y, OVERHANG, TILE_WORLD, frameW, frameH);
    const srcX = vis.x0 * imgScaleX;
    const srcY = vis.y0 * imgScaleY;
    const srcW = (vis.x1 - vis.x0) * imgScaleX;
    const srcH = (vis.y1 - vis.y0) * imgScaleY;

    // Stamp the clipped piece at a pixel offset. Offsetting the whole tile
    // space moves clip and image together, so a shifted stamp is the same piece
    // translated by (dx, dy) atlas texels. Draw coordinates are cell-local
    // (the translate(OVERHANG, OVERHANG) puts the cell origin at 0,0), so the
    // clamped world box maps to dest by subtracting the cell origin.
    const stamp = (dx: number, dy: number): void => {
      ctx.save();
      ctx.translate(slotX + dx, slotY + dy);
      ctx.scale(pixelScale, pixelScale);
      ctx.translate(OVERHANG, OVERHANG);
      ctx.clip(path);
      ctx.drawImage(
        image,
        srcX,
        srcY,
        srcW,
        srcH,
        vis.x0 - cell.x,
        vis.y0 - cell.y,
        vis.x1 - vis.x0,
        vis.y1 - vis.y0,
      );
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

    // The joint line: a stroke on the outline, clipped to the piece so only its
    // inner half lands, which with the neighbor's inner half makes the full line.
    ctx.save();
    ctx.translate(slotX, slotY);
    ctx.scale(pixelScale, pixelScale);
    ctx.translate(OVERHANG, OVERHANG);
    ctx.clip(path);
    ctx.lineWidth = PIECE_JOINT_WIDTH;
    ctx.lineJoin = "round";
    ctx.strokeStyle = PIECE_JOINT_COLOR;
    ctx.stroke(path);
    ctx.restore();
  });

  const silhouetteScale = pixelScale * SILHOUETTE_RES;
  const silhouetteOrigin = SILHOUETTE_PAD + OVERHANG;
  const silhouettePx = Math.ceil((TILE_WORLD + 2 * SILHOUETTE_PAD) * silhouetteScale);
  const silhouettes = bakeTiles(pieces.length, silhouettePx, atlases, (ctx, id, slotX, slotY) => {
    ctx.setTransform(
      silhouetteScale,
      0,
      0,
      silhouetteScale,
      slotX + silhouetteOrigin * silhouetteScale,
      slotY + silhouetteOrigin * silhouetteScale,
    );
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    // A centered stroke twice the edge width grows the outline by the edge width.
    ctx.lineWidth = 2 * PIECE_EDGE_WIDTH;
    ctx.lineJoin = "round";
    ctx.fill(paths[id]!);
    ctx.stroke(paths[id]!);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  });

  const shadowScale = pixelScale * SHADOW_RES;
  const shadowOrigin = SHADOW_PAD + OVERHANG;
  const shadowPx = Math.ceil((TILE_WORLD + 2 * SHADOW_PAD) * shadowScale);
  const bakeShadows = (blur: number): Texture[] =>
    bakeTiles(pieces.length, shadowPx, atlases, (ctx, id, slotX, slotY) => {
      // Canvas has no blur that every target browser supports except
      // shadowBlur, so fill the outline off the canvas and let only its shadow
      // land in the slot. The shadow's offset and blur are in canvas pixels,
      // untouched by the transform; its sigma is half of shadowBlur.
      const away = ATLAS_SIZE * 2;
      ctx.setTransform(
        shadowScale,
        0,
        0,
        shadowScale,
        slotX + shadowOrigin * shadowScale - away,
        slotY + shadowOrigin * shadowScale,
      );
      ctx.shadowColor = "#fff";
      ctx.shadowBlur = 2 * blur * shadowScale;
      ctx.shadowOffsetX = away;
      ctx.fillStyle = "#fff";
      ctx.fill(paths[id]!);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    });

  return {
    pieceTextures: byPiece(faces),
    silhouetteTextures: byPiece(silhouettes),
    shadowTextures: {
      lamp: byPiece(bakeShadows(SHADOW_BLUR.lamp)),
      overhead: byPiece(bakeShadows(SHADOW_BLUR.overhead)),
    },
    tileWorld: TILE_WORLD,
    overhang: OVERHANG,
    silhouetteTile: { pad: SILHOUETTE_PAD, world: silhouettePx / silhouetteScale },
    shadowTile: { pad: SHADOW_PAD, world: shadowPx / shadowScale },
    atlases,
  };
}
