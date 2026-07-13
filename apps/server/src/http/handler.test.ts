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

  it("rejects room creation with a body that is neither multipart nor gallery JSON", async () => {
    const res = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/multipart/);

    const badShape = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: 100 }),
    });
    expect(badShape.status).toBe(400);
    expect((await json(badShape)).error).toMatch(/imageId/);
  });

  it("rejects room creation with a missing image field", async () => {
    const form = new FormData();
    form.set("pieces", "100");
    const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/image/);
  });

  it("rejects an out-of-range or non-integer piece count", async () => {
    const bytes = await makeJpeg(800, 600);
    for (const bad of ["99", "1001", "550.5", "abc"]) {
      const form = new FormData();
      form.set("image", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
      form.set("pieces", bad);
      const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toMatch(/pieces must be an integer between/);
    }
  });

  it("accepts an arbitrary in-range piece count and snaps it to the derived grid", async () => {
    const width = 1920;
    const height = 1080;
    const bytes = await makeJpeg(width, height);
    const form = new FormData();
    form.set("image", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
    form.set("pieces", "550");
    const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const created = await json(res);
    const expectedGrid = deriveGrid(550, width, height);
    expect(created.rows).toBe(expectedGrid.rows);
    expect(created.cols).toBe(expectedGrid.cols);
  });

  it("rejects an unprocessable image with a human-readable reason", async () => {
    const form = new FormData();
    form.set("image", new Blob([Buffer.from("not an image")], { type: "image/jpeg" }), "photo.jpg");
    form.set("pieces", "100");
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
    form.set("pieces", "250");

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
    form.set("pieces", "100");
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

  it("renames a user's room, reflects it in the list, and clears it with null", async () => {
    const bytes = await makeJpeg(800, 600);
    const form = new FormData();
    form.set("image", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
    form.set("pieces", "100");
    form.set("userId", "user-rename");
    const createRes = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
    const { roomId } = await json(createRes);

    const renameRes = await fetch(`${baseUrl}/api/users/user-rename/rooms/${roomId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  Family photo  " }),
    });
    expect(renameRes.status).toBe(200);
    expect(await json(renameRes)).toEqual({ roomId, name: "Family photo" });

    const listRes = await fetch(`${baseUrl}/api/users/user-rename/rooms`);
    const { rooms } = await json(listRes);
    expect(rooms.find((r: { roomId: string }) => r.roomId === roomId)?.name).toBe("Family photo");

    const clearRes = await fetch(`${baseUrl}/api/users/user-rename/rooms/${roomId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: null }),
    });
    expect(clearRes.status).toBe(200);
    const after = await json(await fetch(`${baseUrl}/api/users/user-rename/rooms`));
    expect(after.rooms.find((r: { roomId: string }) => r.roomId === roomId)?.name).toBeNull();
  });

  it("rejects a rename with a bad body and 404s a room the user never touched", async () => {
    const badBody = await fetch(`${baseUrl}/api/users/someone/rooms/some-room`, {
      method: "PATCH",
      body: "not json",
    });
    expect(badBody.status).toBe(400);

    const badName = await fetch(`${baseUrl}/api/users/someone/rooms/some-room`, {
      method: "PATCH",
      body: JSON.stringify({ name: "" }),
    });
    expect(badName.status).toBe(400);

    const notMember = await fetch(`${baseUrl}/api/users/someone/rooms/some-room`, {
      method: "PATCH",
      body: JSON.stringify({ name: "hello" }),
    });
    expect(notMember.status).toBe(404);

    const wrongMethod = await fetch(`${baseUrl}/api/users/someone/rooms/some-room`, { method: "GET" });
    expect(wrongMethod.status).toBe(405);
  });

  it("mints a stable random display name on first fetch, then round-trips a trimmed rename", async () => {
    const first = await fetch(`${baseUrl}/api/users/profile-user/profile`);
    expect(first.status).toBe(200);
    const { displayName: minted } = await json(first);
    // AdjectiveNoun-A00 shape from engine/names.ts randomName.
    expect(minted).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+-[A-Z][0-9]{2}$/);

    // Minted once and persisted, not re-rolled per request.
    const second = await fetch(`${baseUrl}/api/users/profile-user/profile`);
    expect(await json(second)).toEqual({ displayName: minted });

    const patch = await fetch(`${baseUrl}/api/users/profile-user/profile`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "  Justin  " }),
    });
    expect(patch.status).toBe(200);
    expect(await json(patch)).toEqual({ displayName: "Justin" });

    const after = await fetch(`${baseUrl}/api/users/profile-user/profile`);
    expect(await json(after)).toEqual({ displayName: "Justin" });
  });

  it("rejects a profile fetch with an oversized userId instead of minting a row for it", async () => {
    const res = await fetch(`${baseUrl}/api/users/${"x".repeat(129)}/profile`);
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range display name and a non-GET/PATCH method", async () => {
    const empty = await fetch(`${baseUrl}/api/users/profile-user2/profile`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "   " }),
    });
    expect(empty.status).toBe(400);

    const tooLong = await fetch(`${baseUrl}/api/users/profile-user2/profile`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "x".repeat(41) }),
    });
    expect(tooLong.status).toBe(400);

    const badShape = await fetch(`${baseUrl}/api/users/profile-user2/profile`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Justin" }),
    });
    expect(badShape.status).toBe(400);

    const wrongMethod = await fetch(`${baseUrl}/api/users/profile-user2/profile`, { method: "DELETE" });
    expect(wrongMethod.status).toBe(405);
  });

  describe("image gallery", () => {
    /** Uploads a fresh image as `userId` and returns the created room + the gallery entry it produced. */
    async function uploadAs(
      userId: string,
      width = 1600,
      height = 1200,
    ): Promise<{ roomId: string; imageId: string }> {
      const form = new FormData();
      form.set("image", new Blob([await makeJpeg(width, height)], { type: "image/jpeg" }), "photo.jpg");
      form.set("pieces", "100");
      form.set("userId", userId);
      const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
      expect(res.status).toBe(201);
      const { roomId } = await json(res);
      const { images } = await json(await fetch(`${baseUrl}/api/users/${userId}/images`));
      const newest = images[0];
      expect(newest).toBeDefined();
      return { roomId, imageId: newest.imageId as string };
    }

    it("records an upload in the uploader's gallery with the original dimensions", async () => {
      const { roomId, imageId } = await uploadAs("gallery-owner", 1600, 1200);

      const { images } = await json(await fetch(`${baseUrl}/api/users/gallery-owner/images`));
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ imageId, width: 1600, height: 1200 });

      // The room references the gallery image, and both routes serve the same bytes.
      const { settings } = await json(await fetch(`${baseUrl}/api/rooms/${roomId}`));
      expect(settings.imageRef).toBe(imageId);
      const viaRoom = Buffer.from(await (await fetch(`${baseUrl}/api/rooms/${roomId}/image`)).arrayBuffer());
      const standaloneRes = await fetch(`${baseUrl}/api/images/${imageId}`);
      expect(standaloneRes.status).toBe(200);
      expect(standaloneRes.headers.get("cache-control")).toMatch(/immutable/);
      expect(Buffer.from(await standaloneRes.arrayBuffer()).equals(viaRoom)).toBe(true);
    });

    it("keeps an anonymous upload (no userId) out of every gallery but still serves its image", async () => {
      const form = new FormData();
      form.set("image", new Blob([await makeJpeg(800, 600)], { type: "image/jpeg" }), "photo.jpg");
      form.set("pieces", "100");
      const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
      expect(res.status).toBe(201);
      const { roomId } = await json(res);
      const { settings } = await json(await fetch(`${baseUrl}/api/rooms/${roomId}`));
      expect((await fetch(`${baseUrl}/api/images/${settings.imageRef}`)).status).toBe(200);
    });

    it("creates a new room from a gallery image with a different piece count", async () => {
      const { roomId: firstRoom, imageId } = await uploadAs("gallery-reuser", 1920, 1080);

      const res = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageId, pieces: 250, userId: "gallery-reuser" }),
      });
      expect(res.status).toBe(201);
      const created = await json(res);
      expect(created.roomId).not.toBe(firstRoom);
      // Grid derives from the ORIGINAL upload dimensions, same as a fresh upload would.
      const expectedGrid = deriveGrid(250, 1920, 1080);
      expect(created.rows).toBe(expectedGrid.rows);
      expect(created.cols).toBe(expectedGrid.cols);

      // The new room shares the image and lists in the creator's session history.
      const { settings } = await json(await fetch(`${baseUrl}/api/rooms/${created.roomId}`));
      expect(settings.imageRef).toBe(imageId);
      expect((await fetch(`${baseUrl}/api/rooms/${created.roomId}/image`)).status).toBe(200);
      const { rooms } = await json(await fetch(`${baseUrl}/api/users/gallery-reuser/rooms`));
      expect(rooms.find((r: { roomId: string }) => r.roomId === created.roomId)).toMatchObject({
        createdByUser: true,
      });
    });

    it("refuses create-from-gallery for someone else's image, an unknown image, and bad inputs", async () => {
      const { imageId } = await uploadAs("gallery-victim");

      const stolen = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageId, pieces: 100, userId: "gallery-thief" }),
      });
      expect(stolen.status).toBe(404);

      const unknown = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageId: "no-such-image", pieces: 100, userId: "gallery-victim" }),
      });
      expect(unknown.status).toBe(404);

      const badPieces = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageId, pieces: 99, userId: "gallery-victim" }),
      });
      expect(badPieces.status).toBe(400);
      expect((await json(badPieces)).error).toMatch(/pieces must be an integer between/);
    });

    it("rejects a piece count the image's resolution can't support", async () => {
      // 800x600 supports 100 pieces (cells ~66px) but not 1000 (cells <50px floor).
      const { imageId } = await uploadAs("gallery-lowres", 800, 600);
      const res = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageId, pieces: 1000, userId: "gallery-lowres" }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toMatch(/resolution too low/);
    });

    it("deletes a gallery entry (owner only) while existing rooms keep their image", async () => {
      const { roomId, imageId } = await uploadAs("gallery-deleter");

      const stranger = await fetch(`${baseUrl}/api/users/not-the-owner/images/${imageId}`, { method: "DELETE" });
      expect(stranger.status).toBe(404);

      const del = await fetch(`${baseUrl}/api/users/gallery-deleter/images/${imageId}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      expect(await json(del)).toEqual({ imageId, deleted: true });

      // Gone from the gallery: listing, re-delete, and create-from-gallery all miss.
      const { images } = await json(await fetch(`${baseUrl}/api/users/gallery-deleter/images`));
      expect(images).toEqual([]);
      expect((await fetch(`${baseUrl}/api/users/gallery-deleter/images/${imageId}`, { method: "DELETE" })).status).toBe(404);
      const recreate = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageId, pieces: 100, userId: "gallery-deleter" }),
      });
      expect(recreate.status).toBe(404);

      // The room that was created from it still renders.
      expect((await fetch(`${baseUrl}/api/rooms/${roomId}/image`)).status).toBe(200);
    });

    it("405s wrong methods on the gallery routes and 404s an unknown standalone image", async () => {
      expect((await fetch(`${baseUrl}/api/users/someone/images`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${baseUrl}/api/users/someone/images/some-image`, { method: "GET" })).status).toBe(405);
      expect((await fetch(`${baseUrl}/api/images/some-image`, { method: "DELETE" })).status).toBe(405);
      expect((await fetch(`${baseUrl}/api/images/does-not-exist`)).status).toBe(404);
    });
  });

  it("gives two created rooms distinct, unguessable-length ids", async () => {
    const bytes = await makeJpeg(800, 800);
    async function create(): Promise<string> {
      const form = new FormData();
      form.set("image", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
      form.set("pieces", "100");
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
