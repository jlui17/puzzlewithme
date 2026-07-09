import type { Server as HttpServer } from "node:http";
import { parseClientMessage, type ErrorCode } from "@puzzlewithme/shared";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { RoomConnection, RoomRegistry } from "./registry.js";

/** Upgrade path the client is pinned to; the `join` intent carries the roomId, so the path itself is fixed. */
export const WS_PATH = "/ws";

/**
 * Invalid messages tolerated before we close the socket. NFR-7: one malformed
 * message gets an `error` and the server keeps serving; a client spraying
 * garbage is closed rather than answered forever. 5 is generous for an honest
 * client that hit a transient encoding glitch while still bounding abuse; a
 * guess, not measured.
 */
const MAX_INVALID_MESSAGES = 5;

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/**
 * Attach the WebSocket layer to an existing http.Server. Uses noServer + a
 * manual `upgrade` handler so it coexists with the HTTP request listener on one
 * port: only `/ws` upgrades succeed; anything else has its socket destroyed.
 */
export function attachWebSocketServer(server: HttpServer, registry: RoomRegistry): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://internal.invalid");
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const conn: RoomConnection = {
      send: (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
    };

    let state: "awaiting_join" | "joined" = "awaiting_join";
    let roomId: string | null = null;
    let playerId: string | null = null;
    let invalidCount = 0;

    const reject = (code: ErrorCode, message: string): void => {
      conn.send({ type: "error", code, message });
      invalidCount += 1;
      if (invalidCount >= MAX_INVALID_MESSAGES) {
        ws.close(1008, "too many invalid messages");
      }
    };

    async function handle(data: RawData): Promise<void> {
      let raw: unknown;
      try {
        raw = JSON.parse(rawDataToString(data));
      } catch {
        reject("invalid_message", "message was not valid JSON");
        return;
      }
      const parsed = parseClientMessage(raw);
      if (!parsed.ok) {
        reject("invalid_message", "message failed validation");
        return;
      }
      const message = parsed.message;

      if (state === "awaiting_join") {
        if (message.type !== "join") {
          reject("invalid_message", "first message must be a join");
          return;
        }
        const outcome = await registry.join(conn, message.roomId, message.resumeToken);
        if (!outcome.ok) {
          if (outcome.reason === "room_full") conn.send({ type: "room_full" });
          else conn.send({ type: "error", code: "room_not_found", message: "room_not_found" });
          ws.close(1000, outcome.reason);
          return;
        }
        state = "joined";
        roomId = message.roomId;
        playerId = outcome.playerId;
        return;
      }

      // Joined: roomId and playerId are set for every branch below.
      switch (message.type) {
        case "join":
          reject("invalid_message", "already joined");
          return;
        case "grab":
          registry.grab(conn, roomId!, playerId!, message.groupId);
          return;
        case "move":
          registry.move(conn, roomId!, playerId!, message.groupId, message.x, message.y);
          return;
        case "drop":
          await registry.drop(conn, roomId!, playerId!, message.groupId, message.x, message.y);
          return;
        case "cursor":
          registry.cursor(conn, roomId!, playerId!, message.x, message.y);
          return;
        case "rename":
          registry.rename(conn, roomId!, playerId!, message.name);
          return;
      }
    }

    // Serialize handling per connection: join is async, and any intent that
    // arrives before join resolves must wait, or it would run against an
    // unjoined connection. ws delivers frames in order; this preserves that.
    let queue: Promise<void> = Promise.resolve();
    ws.on("message", (data: RawData) => {
      queue = queue.then(() => handle(data)).catch((err: unknown) => {
        // A handler bug must never take the process down (NFR-7); log and keep the socket alive.
        console.error("error handling ws message", err);
      });
    });

    ws.on("close", () => {
      if (state === "joined" && roomId !== null && playerId !== null) {
        registry.leave(conn, roomId, playerId);
      }
    });

    // 'error' is always followed by 'close', where cleanup happens; swallow here
    // so an unhandled 'error' event can't crash the process.
    ws.on("error", () => {});
  });

  return wss;
}
