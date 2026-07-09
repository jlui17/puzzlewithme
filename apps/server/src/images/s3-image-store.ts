import {
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import type { ImageStore } from "./image-store.js";

/**
 * The slice of S3Client this store actually calls, narrowed to the two
 * commands it issues. A real S3Client satisfies this structurally (its
 * `send` is generic over the command type), so production code passes one
 * in directly; tests pass a plain object implementing just these two
 * overloads, with no real client, network, or credentials involved.
 */
export interface S3ClientLike {
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
}

export interface S3ImageStoreOptions {
  client: S3ClientLike;
  bucket: string;
}

/**
 * S3-backed ImageStore (§6.1.4): one object per id, holding the processed
 * webp bytes with contentType carried in S3's native per-object metadata —
 * no sidecar file needed here, unlike LocalDiskImageStore, since GetObject
 * always returns ContentType alongside the body.
 *
 * `delete` is intentionally left unimplemented: the IAM credentials this
 * store runs under grant only ListBucket on the bucket and GetObject/PutObject
 * on its objects (no DeleteObject), which matches FR-4 — a room's image never
 * changes or is removed after creation — so a delete path would have nothing
 * its own deployment permissions would let it do.
 */
export class S3ImageStore implements ImageStore {
  private readonly client: S3ClientLike;
  private readonly bucket: string;

  constructor(options: S3ImageStoreOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
  }

  async put(id: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: id, Body: bytes, ContentType: contentType }));
  }

  async get(id: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: id }));
      // GetObject only omits Body on a HEAD-style empty response, which this
      // command never produces; the SDK types it optional purely because the
      // same output shape is reused elsewhere. Defensive fallback, not a
      // path expected to run.
      const bytes = (await result.Body?.transformToByteArray()) ?? new Uint8Array();
      return { bytes: Buffer.from(bytes), contentType: result.ContentType ?? "application/octet-stream" };
    } catch (err) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }
}

/**
 * S3 returns a 404 with error name "NoSuchKey" for a missing object — but
 * only because the IAM policy grants s3:ListBucket; without it, a missing
 * key 403s as AccessDenied instead (S3 hides object existence from callers
 * who can't list). Duck-typed (rather than `instanceof NoSuchKey`) so a
 * fake client in tests doesn't need to construct the SDK's real error class.
 */
function isNoSuchKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "NoSuchKey";
}
