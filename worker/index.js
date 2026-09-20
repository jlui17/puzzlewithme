// Cloudflare Access on the site hostname protects this route before execution.
export default {
  async fetch(request, env) {
    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    // Upload IDs are 16 random bytes encoded as base64url, not arbitrary keys.
    const match = /^\/photos\/([A-Za-z0-9_-]{22})$/.exec(new URL(request.url).pathname);
    if (!match) return new Response(null, { status: 404 });
    const key = match[1];
    const object = request.method === "HEAD" ? await env.PHOTOS.head(key) : await env.PHOTOS.get(key);
    if (!object) return new Response(null, { status: 404 });
    const headers = {
      "Content-Type": object.httpMetadata?.contentType ?? "image/webp",
      "Content-Length": String(object.size),
      "ETag": object.httpEtag,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    };
    const tags = request.headers.get("If-None-Match");
    if (tags && tags.split(",").some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === object.httpEtag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
};
