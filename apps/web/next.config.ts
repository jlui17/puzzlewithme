import type { NextConfig } from "next";

/**
 * Origin of the game server's HTTP API. Read here (build/runtime, server side)
 * to target the reverse-proxy rewrite below, and in the client to derive the
 * WebSocket URL. One env var stays the single source of truth for "where the
 * server is" (spec: base URL from NEXT_PUBLIC_SERVER_URL).
 */
const SERVER_ORIGIN = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001";

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
    return [
      { source: "/api/rooms", destination: `${SERVER_ORIGIN}/api/rooms` },
      { source: "/api/rooms/:path*", destination: `${SERVER_ORIGIN}/api/rooms/:path*` },
    ];
  },
};

export default nextConfig;
