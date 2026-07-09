import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MAX_DIMENSION_PX, MAX_UPLOAD_BYTES } from "./constants.js";
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
