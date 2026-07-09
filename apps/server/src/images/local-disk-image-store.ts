import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageStore } from "./image-store.js";

/**
 * Local-disk ImageStore: each id gets two sibling files — the raw bytes, and
 * a `.meta.json` sidecar carrying contentType. A sidecar (rather than
 * encoding contentType into the filename/extension) keeps the interface
 * genuinely generic even though this app's own pipeline always stores webp.
 */
export class LocalDiskImageStore implements ImageStore {
  constructor(
    // Env-configurable per the task; defaults to the already-gitignored
    // ./uploaded-images so local dev needs no setup.
    private readonly baseDir: string = process.env["IMAGE_UPLOADS_DIR"] ?? "./uploaded-images",
  ) {}

  private assertSafeId(id: string): void {
    // ids are used verbatim as filenames; reject anything that could escape
    // baseDir. In practice ids are crypto-random room ids (see http/handler),
    // but the interface doesn't guarantee that, so guard defensively.
    if (id.length === 0 || id.includes("/") || id.includes("\\") || id.includes("..")) {
      throw new Error(`invalid image id: ${JSON.stringify(id)}`);
    }
  }

  private dataPath(id: string): string {
    return join(this.baseDir, id);
  }

  private metaPath(id: string): string {
    return join(this.baseDir, `${id}.meta.json`);
  }

  async put(id: string, bytes: Buffer, contentType: string): Promise<void> {
    this.assertSafeId(id);
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.dataPath(id), bytes);
    await writeFile(this.metaPath(id), JSON.stringify({ contentType }));
  }

  async get(id: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    this.assertSafeId(id);
    try {
      const [bytes, metaRaw] = await Promise.all([
        readFile(this.dataPath(id)),
        readFile(this.metaPath(id), "utf8"),
      ]);
      const meta = JSON.parse(metaRaw) as { contentType: string };
      return { bytes, contentType: meta.contentType };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    this.assertSafeId(id);
    await Promise.all(
      [this.dataPath(id), this.metaPath(id)].map(async (path) => {
        try {
          await unlink(path);
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }),
    );
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}
