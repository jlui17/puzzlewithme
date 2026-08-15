import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";

function stubFetch(handler: (input: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api result mapping", () => {
  it("listRooms unwraps the rooms envelope", async () => {
    stubFetch((url) => {
      expect(url).toBe("/api/users/u%2F1/rooms");
      return json(200, { rooms: [{ roomId: "r1" }] });
    });
    const res = await api.listRooms("u/1");
    expect(res).toEqual({ ok: true, value: [{ roomId: "r1" }] });
  });

  it("a non-ok status becomes an error result, not a throw", async () => {
    stubFetch(() => json(500, {}));
    const res = await api.listImages("u1");
    expect(res).toEqual({ ok: false, error: "Server error (500)." });
  });

  it("a network failure becomes an error result", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    const res = await api.getProfile("u1");
    expect(res).toEqual({ ok: false, error: "Could not reach the server." });
  });
});

describe("createRoom", () => {
  it("gallery source sends a JSON reuse body (no bytes re-sent)", async () => {
    stubFetch((url, init) => {
      expect(url).toBe("/api/rooms");
      expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
      expect(JSON.parse(init?.body as string)).toEqual({ imageId: "img1", pieces: 100, userId: "u1" });
      return json(201, { roomId: "r9" });
    });
    const res = await api.createRoom(
      { kind: "gallery", image: { imageId: "img1", createdAt: "", width: 800, height: 600 } },
      100,
      "u1",
    );
    expect(res).toEqual({ ok: true, value: { roomId: "r9" } });
  });

  it("upload source sends multipart form data with the file", async () => {
    const file = new File(["x"], "cat.png", { type: "image/png" });
    stubFetch((url, init) => {
      const body = init?.body as FormData;
      expect(body.get("image")).toBe(file);
      expect(body.get("pieces")).toBe("100");
      expect(body.get("userId")).toBeNull();
      return json(201, { roomId: "r9" });
    });
    const res = await api.createRoom({ kind: "upload", file, url: "blob:x" }, 100, null);
    expect(res.ok).toBe(true);
  });

  it("surfaces the server's human-readable error when present", async () => {
    stubFetch(() => json(400, { error: "image too small for 1000 pieces" }));
    const res = await api.createRoom(
      { kind: "upload", file: new File(["x"], "a.png", { type: "image/png" }), url: "blob:x" },
      1000,
      null,
    );
    expect(res).toEqual({ ok: false, error: "image too small for 1000 pieces" });
  });

  it("falls back to a status message on a non-JSON error body", async () => {
    stubFetch(() => new Response("boom", { status: 502 }));
    const res = await api.createRoom(
      { kind: "upload", file: new File(["x"], "a.png", { type: "image/png" }), url: "blob:x" },
      100,
      null,
    );
    expect(res).toEqual({ ok: false, error: "Room creation failed (502)." });
  });
});

describe("getRoom", () => {
  it("distinguishes not_found from other failures", async () => {
    stubFetch(() => new Response(null, { status: 404 }));
    expect(await api.getRoom("nope")).toEqual({ kind: "not_found" });

    stubFetch(() => new Response(null, { status: 500 }));
    expect(await api.getRoom("r1")).toEqual({ kind: "error", message: "Server error (500)." });

    stubFetch(() => json(200, { exists: true, status: "active", settings: { rows: 2 } }));
    const ready = await api.getRoom("r1");
    expect(ready.kind).toBe("ready");
  });
});
