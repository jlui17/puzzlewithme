import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";

const key = "abcdefghijklmnopqrstuv";
function setup() {
  const bytes = new Uint8Array([1, 2, 3]);
  const object = { body: new Response(bytes).body, size: 3, httpEtag: '"v1"', httpMetadata: { contentType: "image/webp" } };
  const env = { PHOTOS: { get: vi.fn().mockResolvedValue(object), head: vi.fn().mockResolvedValue(object) } };
  return { env, request: (path = `/photos/${key}`, init = {}) => worker.fetch(new Request(`https://puzzle.example.com${path}`, init), env) };
}

describe("photo delivery", () => {
  it("streams stored bytes with private caching and metadata", async () => {
    const { env, request } = setup();
    const res = await request();
    expect(env.PHOTOS.get).toHaveBeenCalledWith(key);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe('"v1"');
  });
  it("uses metadata only for HEAD", async () => {
    const { env, request } = setup();
    const res = await request(undefined, { method: "HEAD" });
    expect(env.PHOTOS.head).toHaveBeenCalledWith(key);
    expect(env.PHOTOS.get).not.toHaveBeenCalled();
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-length")).toBe("3");
  });
  it.each(['"v1"', 'W/"v1"', '"other", "v1"', '*'])("revalidates %s", async tag => {
    const { request } = setup();
    const res = await request(undefined, { headers: { "If-None-Match": tag } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });
  it("returns changed objects and missing-object 404s", async () => {
    const { env, request } = setup();
    expect((await request(undefined, { headers: { "If-None-Match": '"old"' } })).status).toBe(200);
    env.PHOTOS.get.mockResolvedValue(null);
    expect((await request()).status).toBe(404);
  });
  it.each(["/photos/", "/photos/integration-test/probe", `/other/${key}`, `/photos/${key}%2Fextra`])("rejects invalid key %s before storage", async path => {
    const { env, request } = setup();
    expect((await request(path)).status).toBe(404);
    expect(env.PHOTOS.get).not.toHaveBeenCalled();
  });
  it("does not allow writes", async () => {
    const { env, request } = setup();
    expect((await request(undefined, { method: "POST" })).status).toBe(405);
    expect(env.PHOTOS.get).not.toHaveBeenCalled();
  });
});
