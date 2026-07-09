import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MAX_DIMENSION_PX, MAX_UPLOAD_BYTES } from "./constants.js";
import type { ImageEncoder } from "./image-encoder.js";
import { processUploadedImage } from "./process-image.js";

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 140, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 200, b: 30 } },
  })
    .png()
    .toBuffer();
}

describe("processUploadedImage", () => {
  it("accepts a well-formed jpeg and re-encodes to webp", async () => {
    const bytes = await makeJpeg(1200, 800);
    const result = await processUploadedImage(bytes, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.image.contentType).toBe("image/webp");
    const meta = await sharp(result.image.bytes).metadata();
    expect(meta.format).toBe("webp");
  });

  it("re-encodes losslessly: decoded pixels match the source exactly", async () => {
    // Noise, not a flat fill: a solid color round-trips exactly under *any*
    // webp mode (lossy included), so it can't distinguish lossless from
    // quality-90 the way pixel noise (near worst-case for compression) can.
    // 512x512 clears MIN_CELL_PX (50px) at tier 100's ~10x10 grid; a smaller
    // image would fail resolution validation before reaching the lossless
    // re-encode this test targets.
    const width = 512;
    const height = 512;
    const noise = Buffer.from(Array.from({ length: width * height * 3 }, () => Math.floor(Math.random() * 256)));
    const source = await sharp(noise, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const sourcePixels = await sharp(source).raw().toBuffer();

    const result = await processUploadedImage(source, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const processedPixels = await sharp(result.image.bytes).raw().toBuffer();
    expect(processedPixels).toEqual(sourcePixels);
  });

  it("uses an injected encoder in place of the default", async () => {
    const bytes = await makeJpeg(600, 400);
    let calledWithSourceFormat: string | undefined;
    // Encodes to png (not webp) so the assertions below can only pass if
    // processUploadedImage actually delegates to this encoder rather than
    // hardcoding webp anywhere else in its own pipeline.
    const fakeEncoder: ImageEncoder = {
      async encode({ pipeline, sourceFormat }) {
        calledWithSourceFormat = sourceFormat;
        const data = await pipeline.png().toBuffer();
        return { data, contentType: "application/x-test-encoder" };
      },
    };

    const result = await processUploadedImage(bytes, 100, { encoder: fakeEncoder });
    expect(calledWithSourceFormat).toBe("jpeg");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.image.contentType).toBe("application/x-test-encoder");
    const meta = await sharp(result.image.bytes).metadata();
    expect(meta.format).toBe("png");
  });

  it("re-encodes a jpeg source lossily by default, substantially smaller than a forced-lossless encode of the same downscaled image", async () => {
    // Noise (not a flat fill) for the same reason as the lossless round-trip
    // test above: a solid color compresses to near-nothing under either
    // webp mode and can't distinguish lossy from lossless output size.
    const width = 800;
    const height = 600;
    const noise = Buffer.from(Array.from({ length: width * height * 3 }, () => Math.floor(Math.random() * 256)));
    const jpeg = await sharp(noise, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();

    const lossyResult = await processUploadedImage(jpeg, 100);
    expect(lossyResult.ok).toBe(true);
    if (!lossyResult.ok) throw new Error("unreachable");

    const forceLosslessEncoder: ImageEncoder = {
      async encode({ pipeline }) {
        const data = await pipeline.webp({ lossless: true }).toBuffer();
        return { data, contentType: "image/webp" };
      },
    };
    const losslessResult = await processUploadedImage(jpeg, 100, { encoder: forceLosslessEncoder });
    expect(losslessResult.ok).toBe(true);
    if (!losslessResult.ok) throw new Error("unreachable");

    // Conservative floor (see format-aware-webp-encoder.test.ts for the full
    // rationale and the ~2.8x figure measured on photographic content).
    expect(lossyResult.image.bytes.length).toBeLessThan(losslessResult.image.bytes.length / 1.5);
  });

  it("accepts png and webp inputs", async () => {
    const png = await makePng(900, 900);
    const pngResult = await processUploadedImage(png, 100);
    expect(pngResult.ok).toBe(true);

    const webp = await sharp(png).webp().toBuffer();
    const webpResult = await processUploadedImage(webp, 100);
    expect(webpResult.ok).toBe(true);
  });

  it("rejects an unsupported format (tiff)", async () => {
    const tiff = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .toFormat("tiff")
      .toBuffer();
    const result = await processUploadedImage(tiff, 100);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/unsupported image format/);
  });

  it("rejects data that isn't an image at all", async () => {
    const garbage = Buffer.from("this is definitely not an image file", "utf8");
    const result = await processUploadedImage(garbage, 100);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/could not read image data/);
  });

  it("rejects an oversized upload before touching sharp", async () => {
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    const result = await processUploadedImage(oversized, 100);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/exceeds the/);
  });

  it("rejects an image with too few pixels per cell for the chosen tier", async () => {
    // 100x100 square image tiered at 1000 pieces: grid is roughly 31x31,
    // so each cell would render from ~3px, far under MIN_CELL_PX.
    const tiny = await makeJpeg(100, 100);
    const result = await processUploadedImage(tiny, 1000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/resolution too low/);
    expect(result.reason).toMatch(/100x100/);
    expect(result.reason).toMatch(/need at least \d+x\d+/);
  });

  it("accepts an image whose cells clear the minimum by a comfortable margin", async () => {
    // 100 pieces on a 1000x1000 image: grid ~10x10, cells ~100px, well over MIN_CELL_PX.
    const bytes = await makeJpeg(1000, 1000);
    const result = await processUploadedImage(bytes, 100);
    expect(result.ok).toBe(true);
  });

  it("validates against the original upload, not the post-downscale size", async () => {
    // A 4K 16:9 upload at tier 1000: original cells are comfortably >50px
    // (validated here), but downscaling to MAX_DIMENSION_PX=2048 would drop
    // cells to ~48px — if validation ran post-downscale, this mainstream
    // resolution/aspect/tier combination would be unfixably rejected (no
    // larger upload changes the post-downscale grid's cell size).
    const bytes = await makeJpeg(3840, 2160);
    const result = await processUploadedImage(bytes, 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Math.max(result.image.width, result.image.height)).toBe(2048);
  });

  it("downscales an image larger than MAX_DIMENSION_PX and preserves aspect ratio", async () => {
    const bytes = await makeJpeg(4000, 2000);
    const result = await processUploadedImage(bytes, 500);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Math.max(result.image.width, result.image.height)).toBe(MAX_DIMENSION_PX);
    expect(result.image.width / result.image.height).toBeCloseTo(4000 / 2000, 2);
  });

  it("never enlarges an image already under MAX_DIMENSION_PX", async () => {
    const bytes = await makeJpeg(600, 400);
    const result = await processUploadedImage(bytes, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.image.width).toBe(600);
    expect(result.image.height).toBe(400);
  });
});
