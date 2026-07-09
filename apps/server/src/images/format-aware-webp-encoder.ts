import type { EncodedImage, EncodeInput, ImageEncoder } from "./image-encoder.js";

/**
 * Visually transparent at ≤2048px (MAX_DIMENSION_PX) under the bilinear
 * sampling the client's WebGL renderer uses to display pieces — chosen by
 * eye against photographic test images, not a measured PSNR/SSIM threshold.
 * Revisit if pieces are ever rendered at higher zoom than that.
 */
const LOSSY_WEBP_QUALITY = 90;

/**
 * Default processUploadedImage encoder: picks lossless vs. lossy webp from
 * the source format rather than always re-encoding losslessly. png is the
 * one guaranteed-lossless upload format and typically graphics/text, where
 * lossy webp visibly smears edges and lossless webp already compresses well.
 * jpeg/webp uploads are already lossy, so a lossless re-encode only preserves
 * the source's own compression artifacts, at ~2.8x the storage (measured on
 * a 1600x1200 photographic test image: 493KB at quality 90 vs. 1379KB
 * lossless) with no integrity gain over quality-90 to show for it.
 */
export const formatAwareWebpEncoder: ImageEncoder = {
  async encode({ pipeline, sourceFormat }: EncodeInput): Promise<EncodedImage> {
    const lossless = sourceFormat === "png";
    const data = await pipeline.webp(lossless ? { lossless: true } : { quality: LOSSY_WEBP_QUALITY }).toBuffer();
    return { data, contentType: "image/webp" };
  },
};
