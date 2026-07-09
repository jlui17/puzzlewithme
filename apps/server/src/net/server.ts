import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createHttpHandler } from "../http/handler.js";
import type { ImageStore } from "../images/image-store.js";
import type { RoomStore } from "../store/room-store.js";
import { RoomRegistry, type RoomRegistryOptions } from "./registry.js";
import { attachWebSocketServer } from "./ws.js";

export interface GameServerOptions {
  roomStore: RoomStore;
  imageStore: ImageStore;
  /** Registry tuning (clock, checkpoint/sweep intervals, snap tolerance) forwarded verbatim; tests inject these for determinism. */
  registry?: Omit<RoomRegistryOptions, "store">;
}

export interface GameServer {
  server: HttpServer;
  registry: RoomRegistry;
  /** Graceful shutdown: flush active rooms (§7.5), then stop accepting and close sockets. */
  close(): Promise<void>;
}

/**
 * Assemble the game server: the room-creation HTTP handler and the live-play
 * WebSocket layer sharing one http.Server (one port). Pure wiring — callers
 * (main.ts, tests) provide the stores and choose when to listen.
 */
export function createGameServer(options: GameServerOptions): GameServer {
  const registry = new RoomRegistry({ store: options.roomStore, ...options.registry });
  const handler = createHttpHandler({ roomStore: options.roomStore, imageStore: options.imageStore });
  const server = createHttpServer(handler);
  const wss = attachWebSocketServer(server, registry);

  const close = async (): Promise<void> => {
    // Flush + clear rooms before dropping sockets, so the terminate below can't
    // race the flush (a terminated socket's leave is a no-op once closing).
    await registry.shutdown();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { server, registry, close };
}
