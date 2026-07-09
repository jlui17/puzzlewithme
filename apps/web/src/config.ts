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

export function roomImageUrl(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/image`;
}

/** WebSocket endpoint for live play. The join intent carries the roomId (pinned path: /ws). */
export function wsUrl(): string {
  const ws = SERVER_URL.replace(/^http/, "ws");
  return `${ws.replace(/\/$/, "")}/ws`;
}
