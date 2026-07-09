import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDiskImageStore } from "./local-disk-image-store.js";

describe("LocalDiskImageStore", () => {
  let dir: string;
  let store: LocalDiskImageStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "puzzlewithme-images-"));
    store = new LocalDiskImageStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips bytes and content type", async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    await store.put("room-1", bytes, "image/webp");
    const loaded = await store.get("room-1");
    expect(loaded?.bytes).toEqual(bytes);
    expect(loaded?.contentType).toBe("image/webp");
  });

  it("returns null for an unknown id", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("creates the base directory on first put", async () => {
    const nested = new LocalDiskImageStore(join(dir, "nested", "path"));
    await nested.put("room-1", Buffer.from("x"), "image/webp");
    expect(await nested.get("room-1")).not.toBeNull();
  });

  it("deletes both the data and metadata files", async () => {
    await store.put("room-1", Buffer.from("x"), "image/webp");
    await store.delete?.("room-1");
    expect(await store.get("room-1")).toBeNull();
  });

  it("rejects ids that could escape the base directory", async () => {
    await expect(store.put("../escape", Buffer.from("x"), "image/webp")).rejects.toThrow(/invalid image id/);
    await expect(store.get("a/b")).rejects.toThrow(/invalid image id/);
  });
});
