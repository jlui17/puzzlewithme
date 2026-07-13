import type { NextConfig } from "next";

/**
 * Origin of the game server's HTTP API, targeted by the reverse-proxy rewrite
 * below. In dev one env var (NEXT_PUBLIC_SERVER_URL) names the server for both
 * this rewrite and the client's WebSocket URL. In production the two diverge:
 * the browser's WS needs the public origin, while this rewrite runs inside the
 * deployment network and must hit the server directly — routing it through the
 * public origin would put an access-gated proxy (e.g. Cloudflare Access) in
 * front of a cookie-less server-side fetch and get it blocked. SERVER_INTERNAL_URL
 * overrides the rewrite target for that case; unset, dev behaves as before.
 */
const SERVER_ORIGIN =
  process.env["SERVER_INTERNAL_URL"] ??
  process.env.NEXT_PUBLIC_SERVER_URL ??
  "http://localhost:3001";

const nextConfig: NextConfig = {
  transpilePackages: ["@puzzlewithme/shared", "@puzzlewithme/geometry"],
  // The workspace packages use NodeNext-style ".js" relative imports in TS
  // source; webpack resolves those literally unless told to try .ts first.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  /**
   * Proxy every server HTTP call through this Next origin. The browser cannot
   * talk to the game server directly: the server sets no CORS headers, so a
   * cross-origin multipart POST (room create) preflights and is blocked, and a
   * cross-origin image loaded for WebGL taints the canvas so texImage2D throws.
   * The server is out of scope to modify, so same-origin is the only path that
   * works. NEXT_PUBLIC_SERVER_URL still names the server (it's the proxy target
   * and the WS host); only the transport changes.
   */
  async rewrites() {
    // One catch-all instead of per-route entries: the web app has no /api
    // routes of its own, and enumerating server routes here already bit once
    // (the gallery's /api/images was missed and thumbnails 404'd at this
    // layer while every server-side test passed).
    return [{ source: "/api/:path*", destination: `${SERVER_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
