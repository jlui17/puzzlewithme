import type sharp from "sharp";

/**
 * The downscaled-but-unencoded pipeline plus the source's decoded format
 * (jpeg/png/webp, from sharp's metadata on the original upload). The default
 * encoder branches on `sourceFormat` to pick lossy vs. lossless; a swapped-in
 * encoder is free to ignore it and always encode one way.
 */
export interface EncodeInput {
  pipeline: sharp.Sharp;
  sourceFormat: string;
}

export interface EncodedImage {
  data: Buffer;
  contentType: string;
}

/**
 * Injectable encoding strategy for processUploadedImage. Extracted so the
 * compression choice (format, quality, lossless-vs-lossy) can change without
 * touching validation/downscale logic, and so tests can substitute a fake to
 * prove the seam is actually used.
 */
export interface ImageEncoder {
  encode(input: EncodeInput): Promise<EncodedImage>;
}
