import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveGrid } from "@puzzlewithme/geometry";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDiskImageStore } from "../images/local-disk-image-store.js";
import { InMemoryRoomStore } from "../store/room-store.js";
import { createHttpHandler } from "./handler.js";

// Response.json() is typed Promise<unknown> under this repo's strict
// settings; every response body here is trusted test-authored JSON, so one
// narrow `any` cast point is simpler than typing each response shape.
async function json(res: Response): Promise<any> {
  return res.json();
}

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 80, g: 90, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

describe("http handler", () => {
  let server: Server;
  let baseUrl: string;
  let uploadsDir: string;
  let roomStore: InMemoryRoomStore;

  beforeAll(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), "puzzlewithme-http-images-"));
    roomStore = new InMemoryRoomStore();
    const imageStore = new LocalDiskImageStore(uploadsDir);
    server = createServer(createHttpHandler({ roomStore, imageStore }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(uploadsDir, { recursive: true, force: true });
  });

  it("returns 404 for unknown routes and methods", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe("not_found");
  });

  it("returns 405 for a non-GET on a room route", async () => {
    const res = await fetch(`${baseUrl}/api/rooms/whatever`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("returns 404 for an unknown room and its image", async () => {
    const roomRes = await fetch(`${baseUrl}/api/rooms/does-not-exist`);
    expect(roomRes.status).toBe(404);
    expect((await json(roomRes)).error).toBe("room_not_found");

    const imageRes = await fetch(`${baseUrl}/api/rooms/does-not-exist/image`);
    expect(imageRes.status).toBe(404);
  });

  it("rejects room creation with a non-multipart body", async () => {
    const res = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: 100 }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/multipart/);
  });

  it("rejects room creation with a missing image field", async () => {
    const form = new FormData();
    form.set("tier", "100");
    const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/image/);
  });

  it("rejects an invalid tier", async () => {
    const bytes = await makeJpeg(800, 600);
    const form = new FormData();
    form.set("image", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
    form.set("tier", "99");
    const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/tier must be one of/);
  });

  it("rejects an unprocessable image with a human-readable reason", async () => {
    const form = new FormData();
    form.set("image", new Blob([Buffer.from("not an image")], { type: "image/jpeg" }), "photo.jpg");
    form.set("tier", "100");
    const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("creates a room end to end and serves the stored image back", async () => {
    const width = 1600;
    const height = 1200;
    const bytes = await makeJpeg(width, height);
    const form = new FormData();
    form.set("image", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
    form.set("tier", "250");

    const createRes = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
    expect(createRes.status).toBe(201);
    const created = await json(createRes);
    expect(typeof created.roomId).toBe("string");
    expect(created.roomId.length).toBeGreaterThan(0);

    const expectedGrid = deriveGrid(250, width, height);
    expect(created.rows).toBe(expectedGrid.rows);
    expect(created.cols).toBe(expectedGrid.cols);

    // The room is loadable from the store with settings matching what deriveGrid produced.
    const loaded = await roomStore.load(created.roomId);
    expect(loaded).not.toBeNull();
    expect(loaded?.settings.rows).toBe(expectedGrid.rows);
    expect(loaded?.settings.cols).toBe(expectedGrid.cols);
    expect(loaded?.settings.status).toBe("active");

    const getRes = await fetch(`${baseUrl}/api/rooms/${created.roomId}`);
    expect(getRes.status).toBe(200);
    const getBody = await json(getRes);
    expect(getBody.exists).toBe(true);
    expect(getBody.status).toBe("active");
    expect(getBody.settings.roomId).toBe(created.roomId);

    const imageRes = await fetch(`${baseUrl}/api/rooms/${created.roomId}/image`);
    expect(imageRes.status).toBe(200);
    expect(imageRes.headers.get("content-type")).toBe("image/webp");
    expect(imageRes.headers.get("cache-control")).toMatch(/immutable/);
    const imageBytes = Buffer.from(await imageRes.arrayBuffer());
    const meta = await sharp(imageBytes).metadata();
    expect(meta.format).toBe("webp");
  });

  it("lists a user's rooms after creating one with a userId, and stays empty for others", async () => {
    const bytes = await makeJpeg(800, 600);
    const form = new FormData();
    form.set("image", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
    form.set("tier", "100");
    form.set("userId", "user-history");
    const createRes = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
    expect(createRes.status).toBe(201);
    const { roomId } = await json(createRes);

    const listRes = await fetch(`${baseUrl}/api/users/user-history/rooms`);
    expect(listRes.status).toBe(200);
    const { rooms } = await json(listRes);
    expect(Array.isArray(rooms)).toBe(true);
    const mine = rooms.find((r: { roomId: string }) => r.roomId === roomId);
    expect(mine).toMatchObject({ createdByUser: true, status: "active", placedPieces: 0 });
    expect(mine.totalPieces).toBeGreaterThan(0);

    const otherRes = await fetch(`${baseUrl}/api/users/nobody/rooms`);
    expect(otherRes.status).toBe(200);
    expect((await json(otherRes)).rooms).toEqual([]);
  });

  it("returns 405 for a non-GET on the user-rooms route", async () => {
    const res = await fetch(`${baseUrl}/api/users/someone/rooms`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("gives two created rooms distinct, unguessable-length ids", async () => {
    const bytes = await makeJpeg(800, 800);
    async function create(): Promise<string> {
      const form = new FormData();
      form.set("image", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
      form.set("tier", "100");
      const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
      const body = await json(res);
      return body.roomId as string;
    }
    const [a, b] = await Promise.all([create(), create()]);
    expect(a).not.toBe(b);
    // base64url of 16 random bytes -> 22 characters (128 bits, no padding).
    expect(a.length).toBe(22);
    expect(b.length).toBe(22);
  });
});
