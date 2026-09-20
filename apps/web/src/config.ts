/**
 * Server access, resolved from one env var (spec: base URL from
 * NEXT_PUBLIC_SERVER_URL, default localhost:3001; ws:// derived from it).
 *
 * HTTP goes same-origin through the Next rewrite (see next.config.ts for why:
 * CORS + WebGL canvas taint), so API paths are relative. The WebSocket, which
 * a rewrite can't proxy in dev, connects directly to the server host derived
 * from the same env var.
 */
const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001";

/** Same-origin API base: requests hit Next and get reverse-proxied to the server. */
export const apiBase = "";

/** Set to "worker" at build time after the R2 bucket and route are ready. */
const IMAGE_DELIVERY = process.env.NEXT_PUBLIC_IMAGE_DELIVERY;

export function imageUrl(imageId: string): string {
  const prefix = IMAGE_DELIVERY === "worker" ? "/photos" : "/api/images";
  return `${prefix}/${encodeURIComponent(imageId)}`;
}

/** WebSocket endpoint for live play. The join intent carries the roomId (pinned path: /ws). */
export function wsUrl(): string {
  const ws = SERVER_URL.replace(/^http/, "ws");
  return `${ws.replace(/\/$/, "")}/ws`;
}

/** Compatibility path for room summaries from older servers. */
export function roomImageUrl(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/image`;
}
