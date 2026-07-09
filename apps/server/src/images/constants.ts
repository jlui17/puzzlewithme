/**
 * Bounds per-upload memory use. 10 MB is a guessed round number, not measured
 * against a device corpus, chosen to comfortably fit modern phone-camera
 * JPEGs (typically 2-8 MB) while keeping a single upload's buffered size a
 * non-issue for the process (FR-1).
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Formats sharp decodes reliably and that cover the vast majority of consumer photo uploads (FR-1). */
export const ALLOWED_IMAGE_FORMATS = new Set(["jpeg", "png", "webp"]);

/**
 * Pieces never need more resolution than a screen shows (FR-2). 2048px
 * covers common desktop/tablet viewport widths with margin for zoom, while
 * bounding per-room storage and the download NFR-4 budgets for.
 */
export const MAX_DIMENSION_PX = 2048;

/**
 * Floor for source pixels behind a single piece cell before it visibly
 * blurs when a player zooms in to work on it. Guessed (not measured against
 * a device/panel corpus), chosen comfortably above the ~20-30px range where
 * webp block artifacts become visible at typical piece-working zoom.
 * Checked against the ORIGINAL upload's dimensions, not the post-downscale
 * size: FR-1 requires the upload to have "enough pixels" and a rejection
 * naming the required size, which is only fixable by the uploader if it's a
 * property of what they uploaded, not of a fixed downstream cap. (A very
 * wide panorama can still end up sub-MIN_CELL_PX after the MAX_DIMENSION_PX
 * downscale despite passing this check — an accepted tradeoff, not a
 * requirement this floor is meant to catch.)
 */
export const MIN_CELL_PX = 50;
