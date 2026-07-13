import { deriveGrid, type Grid } from "@puzzlewithme/geometry";
import sharp from "sharp";
import { ALLOWED_IMAGE_FORMATS, MAX_DIMENSION_PX, MAX_UPLOAD_BYTES, MIN_CELL_PX } from "./constants.js";
import { formatAwareWebpEncoder } from "./format-aware-webp-encoder.js";
import type { ImageEncoder } from "./image-encoder.js";

export interface ProcessedImage {
  bytes: Buffer;
  width: number;
  height: number;
  /**
   * The upload's pre-downscale dimensions — what `grid` was validated
   * against. Persisted with the gallery record so re-creating a room from
   * this image later validates a new piece count against the same numbers.
   */
  originalWidth: number;
  originalHeight: number;
  /** Whatever contentType the encoder reports — not pinned to webp, since a swapped-in ImageEncoder may pick a different output format. */
  contentType: string;
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

export interface ProcessImageOptions {
  /**
   * Encoding strategy for the downscaled pixels. Defaults to
   * formatAwareWebpEncoder (see format-aware-webp-encoder.ts). Swappable
   * since the compression tradeoff (format/quality/lossless-vs-lossy) is
   * expected to change independently of the validation/downscale steps
   * around it.
   */
  encoder?: ImageEncoder;
}

export type PieceGridResult = { ok: true; grid: Grid } | { ok: false; reason: string };

/**
 * Derive the grid for a target piece count and check the image has enough
 * pixels for it (FR-1, FR-3): every cell must be at least MIN_CELL_PX on its
 * short side. `width`/`height` must be the ORIGINAL upload's dimensions (see
 * the validation comment in processUploadedImage). Shared by the upload path
 * and create-from-gallery so a piece count is judged identically whether the
 * image arrives fresh or from the gallery.
 */
export function validatePieceGrid(targetPieces: number, width: number, height: number): PieceGridResult {
  const grid = deriveGrid(targetPieces, width, height);
  const minCellPx = Math.min(width / grid.cols, height / grid.rows);
  if (minCellPx < MIN_CELL_PX) {
    const requiredWidth = Math.ceil(MIN_CELL_PX * grid.cols);
    const requiredHeight = Math.ceil(MIN_CELL_PX * grid.rows);
    return {
      ok: false,
      reason:
        `image resolution too low for ${targetPieces} pieces: pieces would render from ` +
        `~${Math.floor(minCellPx)}px, need at least ${MIN_CELL_PX}px ` +
        `(image is ${width}x${height}, need at least ${requiredWidth}x${requiredHeight} ` +
        `for a ${grid.rows}x${grid.cols} grid)`,
    };
  }
  return { ok: true, grid };
}

/**
 * Validate and normalize an uploaded room image (FR-1, FR-2, §7.1). Always
 * re-encodes via the injected ImageEncoder (default: formatAwareWebpEncoder)
 * — one stored format per upload means one code path for serving and any
 * future re-processing, decided in one place rather than scattered through
 * this function.
 *
 * Format is read from the file's actual decoded bytes (sharp's metadata),
 * never a client-supplied Content-Type header, since that header is
 * attacker-controlled input (NFR-7). The same decoded format is also handed
 * to the encoder, which the default strategy uses to pick lossless vs. lossy
 * output (see format-aware-webp-encoder.ts for the rationale).
 */
export async function processUploadedImage(
  bytes: Buffer,
  targetPieces: number,
  options: ProcessImageOptions = {},
): Promise<ProcessImageResult> {
  const encoder = options.encoder ?? formatAwareWebpEncoder;
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
  const gridResult = validatePieceGrid(targetPieces, originalWidth, originalHeight);
  if (!gridResult.ok) {
    return gridResult;
  }
  const { grid } = gridResult;

  // fit: "inside" + withoutEnlargement preserves aspect ratio and never
  // upscales a smaller-than-cap image (FR-2 is a ceiling, not a target).
  const pipeline = source.resize({
    width: MAX_DIMENSION_PX,
    height: MAX_DIMENSION_PX,
    fit: "inside",
    withoutEnlargement: true,
  });

  let data: Buffer;
  let contentType: string;
  try {
    ({ data, contentType } = await encoder.encode({ pipeline, sourceFormat: format }));
  } catch {
    return { ok: false, reason: "could not process image data; the file may be corrupt or not an image" };
  }

  // Read dimensions back off the encoder's own output bytes rather than
  // trusting sharp's pre-encode pipeline metadata: the encoder is an
  // injected strategy free to do its own thing with `pipeline`, so the only
  // dimensions guaranteed to match what's actually stored are the encoded
  // bytes' own.
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = await sharp(data).metadata());
  } catch {
    return { ok: false, reason: "could not process image data; the file may be corrupt or not an image" };
  }
  if (width === undefined || height === undefined) {
    return { ok: false, reason: "could not process image data; the file may be corrupt or not an image" };
  }

  return {
    ok: true,
    image: { bytes: data, width, height, originalWidth, originalHeight, contentType, grid },
  };
}
