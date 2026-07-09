import { createGameServer } from "./net/server.js";
import { LocalDiskImageStore } from "./images/local-disk-image-store.js";
import { InMemoryRoomStore, type RoomStore } from "./store/room-store.js";
import { PostgresRoomStore } from "./store/postgres-room-store.js";

// The web client defaults to localhost:3001, so this port is pinned; PORT only
// overrides it for deployment where the platform assigns one.
const DEFAULT_PORT = 3001;

function buildRoomStore(): RoomStore {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl !== undefined && databaseUrl !== "") {
    console.log("room store: Postgres (DATABASE_URL set)");
    return new PostgresRoomStore({ connectionString: databaseUrl });
  }
  // Zero-setup dev default: no database needed to run the server, at the cost
  // of losing all rooms on restart (fine locally, never for deployment).
  console.log("room store: in-memory (no DATABASE_URL; rooms are lost on restart)");
  return new InMemoryRoomStore();
}

function start(): void {
  const port = Number(process.env["PORT"] ?? DEFAULT_PORT);
  const roomStore = buildRoomStore();
  const imageStore = new LocalDiskImageStore();
  const game = createGameServer({ roomStore, imageStore });

  game.server.listen(port, () => {
    console.log(`puzzlewithme server listening on http://localhost:${port} (ws at ${port}/ws)`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, flushing active rooms and shutting down`);
    game
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error("error during shutdown", err);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start();
