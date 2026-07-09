import { deriveGrid, type Grid, type Tier } from "@puzzlewithme/geometry";
import sharp from "sharp";
import {
  ALLOWED_IMAGE_FORMATS,
  MAX_DIMENSION_PX,
  MAX_UPLOAD_BYTES,
  MIN_CELL_PX,
  STORED_WEBP_QUALITY,
} from "./constants.js";

export interface ProcessedImage {
  bytes: Buffer;
  width: number;
  height: number;
  contentType: "image/webp";
  /**
   * The grid validated against this upload's original dimensions (FR-3).
   * Callers should use this rather than re-deriving from `width`/`height`:
   * deriveGrid is a discrete cost-minimization search over aspect ratio, and
   * the downscale below can shift the processed aspect by a rounding hair,
   * which can occasionally flip the search to an adjacent (rows, cols) pair
   * that this image was never validated against.
   */
  grid: Grid;
}

export type ProcessImageResult =
  | { ok: true; image: ProcessedImage }
  | { ok: false; reason: string };

/**
 * Validate and normalize an uploaded room image (FR-1, FR-2, §7.1). Always
 * re-encodes to webp — one stored format means one code path for serving
 * and for any future re-processing, and webp comfortably beats jpeg/png at
 * matched quality for the photographic content this app expects.
 *
 * Format is read from the file's actual decoded bytes (sharp's metadata),
 * never a client-supplied Content-Type header, since that header is
 * attacker-controlled input (NFR-7).
 */
export async function processUploadedImage(bytes: Buffer, tier: Tier): Promise<ProcessImageResult> {
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `image exceeds the ${MAX_UPLOAD_BYTES}-byte upload limit (got ${bytes.length} bytes)` };
  }

  // failOn: "error" (sharp's default is "warning") tolerates the minor
  // warnings real-world phone/camera photos often trip (e.g. odd ICC
  // profiles) without loosening so much that truncated/corrupt data passes.
  const source = sharp(bytes, { failOn: "error" });
  let format: string | undefined;
  let originalWidth: number | undefined;
  let originalHeight: number | undefined;
  try {
    ({ format, width: originalWidth, height: originalHeight } = await source.metadata());
  } catch {
    return { ok: false, reason: "could not read image data; the file may be corrupt or not an image" };
  }
  if (format === undefined || !ALLOWED_IMAGE_FORMATS.has(format)) {
    return {
      ok: false,
      reason: `unsupported image format "${format ?? "unknown"}"; only JPEG, PNG, and WebP are accepted`,
    };
  }
  if (originalWidth === undefined || originalHeight === undefined) {
    return { ok: false, reason: "could not read image dimensions" };
  }

  // Validated against the ORIGINAL upload, not the post-downscale size: the
  // task requires an upload to have "enough pixels" and a rejection reason
  // naming the required size, which only makes sense as a property of what
  // the user uploaded (something they can fix by uploading a bigger file).
  // This grid is returned to the caller (see ProcessedImage.grid) rather
  // than re-derived from the processed dimensions, so the grid a room is
  // created with is always exactly the grid this validation ran against.
  const grid = deriveGrid(tier, originalWidth, originalHeight);
  const minCellPx = Math.min(originalWidth / grid.cols, originalHeight / grid.rows);
  if (minCellPx < MIN_CELL_PX) {
    const requiredWidth = Math.ceil(MIN_CELL_PX * grid.cols);
    const requiredHeight = Math.ceil(MIN_CELL_PX * grid.rows);
    return {
      ok: false,
      reason:
        `image resolution too low for the ${tier}-piece tier: pieces would render from ` +
        `~${Math.floor(minCellPx)}px, need at least ${MIN_CELL_PX}px ` +
        `(image is ${originalWidth}x${originalHeight}, need at least ${requiredWidth}x${requiredHeight} ` +
        `for a ${grid.rows}x${grid.cols} grid)`,
    };
  }

  let data: Buffer;
  let info: { width: number; height: number };
  try {
    ({ data, info } = await source
      // fit: "inside" + withoutEnlargement preserves aspect ratio and never
      // upscales a smaller-than-cap image (FR-2 is a ceiling, not a target).
      .resize({ width: MAX_DIMENSION_PX, height: MAX_DIMENSION_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: STORED_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true }));
  } catch {
    return { ok: false, reason: "could not process image data; the file may be corrupt or not an image" };
  }

  return {
    ok: true,
    image: { bytes: data, width: info.width, height: info.height, contentType: "image/webp", grid },
  };
}
