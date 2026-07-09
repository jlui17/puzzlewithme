import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3ImageStore, type S3ClientLike } from "./s3-image-store.js";

/**
 * In-memory stand-in for S3ClientLike: keyed by object key, storing exactly
 * what a real bucket would (bytes + ContentType), so put/get round-trip the
 * same way they would against S3 without any network or credentials.
 */
class FakeS3Client implements S3ClientLike {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async send(command: PutObjectCommand): Promise<any>;
  async send(command: GetObjectCommand): Promise<any>;
  async send(command: PutObjectCommand | GetObjectCommand): Promise<any> {
    if (command instanceof PutObjectCommand) {
      const { Key, Body, ContentType } = command.input;
      this.objects.set(Key!, { bytes: Body as Uint8Array, contentType: ContentType! });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(command.input.Key!);
      if (object === undefined) {
        const err = new Error("The specified key does not exist.");
        err.name = "NoSuchKey";
        throw err;
      }
      return {
        ContentType: object.contentType,
        Body: { transformToByteArray: async () => object.bytes },
      };
    }
    throw new Error("unexpected command");
  }
}

describe("S3ImageStore", () => {
  it("round-trips bytes and content type", async () => {
    const store = new S3ImageStore({ client: new FakeS3Client(), bucket: "test-bucket" });
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    await store.put("room-1", bytes, "image/webp");
    const loaded = await store.get("room-1");
    expect(loaded?.bytes).toEqual(bytes);
    expect(loaded?.contentType).toBe("image/webp");
  });

  it("returns null for an unknown id (NoSuchKey)", async () => {
    const store = new S3ImageStore({ client: new FakeS3Client(), bucket: "test-bucket" });
    expect(await store.get("nope")).toBeNull();
  });

  it("propagates errors that aren't NoSuchKey", async () => {
    const client: S3ClientLike = {
      send: async () => {
        const err = new Error("access denied");
        err.name = "AccessDenied";
        throw err;
      },
    };
    const store = new S3ImageStore({ client, bucket: "test-bucket" });
    await expect(store.get("room-1")).rejects.toThrow(/access denied/);
  });

  it("propagates put errors", async () => {
    const client: S3ClientLike = {
      send: async () => {
        throw new Error("network error");
      },
    };
    const store = new S3ImageStore({ client, bucket: "test-bucket" });
    await expect(store.put("room-1", Buffer.from("x"), "image/webp")).rejects.toThrow(/network error/);
  });
});
