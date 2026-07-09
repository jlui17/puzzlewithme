import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { formatAwareWebpEncoder } from "./format-aware-webp-encoder.js";

function makeNoise(width: number, height: number): Buffer {
  // Pixel noise, not a flat fill: a solid color round-trips exactly and
  // compresses to near-nothing under *any* webp mode, so it can't
  // distinguish lossless from quality-90 the way near-worst-case noise can.
  return Buffer.from(Array.from({ length: width * height * 3 }, () => Math.floor(Math.random() * 256)));
}

describe("formatAwareWebpEncoder", () => {
  it("encodes a png source losslessly (pixel-exact round trip)", async () => {
    const width = 256;
    const height = 256;
    const noise = makeNoise(width, height);
    const pngSource = await sharp(noise, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const sourcePixels = await sharp(pngSource).raw().toBuffer();

    const { data, contentType } = await formatAwareWebpEncoder.encode({
      pipeline: sharp(pngSource),
      sourceFormat: "png",
    });

    expect(contentType).toBe("image/webp");
    const outMeta = await sharp(data).metadata();
    expect(outMeta.format).toBe("webp");
    const outPixels = await sharp(data).raw().toBuffer();
    expect(outPixels).toEqual(sourcePixels);
  });

  it("encodes a jpeg/webp source lossily, substantially smaller than a lossless encode of the same pixels", async () => {
    const width = 800;
    const height = 600;
    const noise = makeNoise(width, height);
    // A jpeg-derived source: quality 95 keeps the pixels close to the noise
    // above so the lossy-vs-lossless comparison below isolates the
    // formatAwareWebpEncoder branch, not the jpeg source's own artifacting.
    const jpegSource = await sharp(noise, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();

    const lossy = await formatAwareWebpEncoder.encode({ pipeline: sharp(jpegSource), sourceFormat: "jpeg" });
    // sourceFormat "png" forces the encoder's lossless branch on the exact
    // same pixels, isolating the format-driven branch as the only variable
    // between this call and the one above.
    const lossless = await formatAwareWebpEncoder.encode({ pipeline: sharp(jpegSource), sourceFormat: "png" });

    expect(lossy.contentType).toBe("image/webp");
    const lossyMeta = await sharp(lossy.data).metadata();
    expect(lossyMeta.format).toBe("webp");

    // ~2.8x measured in the encoder's own rationale comment on photographic
    // content; 1.5x here is a conservative floor against noise (a harder
    // compression case than a real photo) so the test isn't flaky.
    expect(lossy.data.length).toBeLessThan(lossless.data.length / 1.5);
  });

  it("treats a webp source the same as jpeg: lossy output", async () => {
    const width = 400;
    const height = 300;
    const noise = makeNoise(width, height);
    const webpSource = await sharp(noise, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();

    const lossy = await formatAwareWebpEncoder.encode({ pipeline: sharp(webpSource), sourceFormat: "webp" });
    const lossless = await formatAwareWebpEncoder.encode({ pipeline: sharp(webpSource), sourceFormat: "png" });

    expect(lossy.data.length).toBeLessThan(lossless.data.length);
  });
});
