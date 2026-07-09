// Must run before any other import touches process.env (S3_BUCKET,
// AWS_*, DATABASE_URL, etc. below): a plain side-effecting import, not
// --env-file/--env-file-if-exists, since the latter either errors on a
// missing .env (older --env-file) or needs Node >=22.9 (--env-file-if-exists)
// — neither survives across this repo's supported engines.node (>=20) and a
// laptop/VPS with no .env at all. dotenv/config no-ops silently when the
// file is absent, which is what makes it work in both cases.
import "dotenv/config";
import { S3Client } from "@aws-sdk/client-s3";
import { createGameServer } from "./net/server.js";
import { type ImageStore } from "./images/image-store.js";
import { LocalDiskImageStore } from "./images/local-disk-image-store.js";
import { S3ImageStore } from "./images/s3-image-store.js";
import { type RoomStore } from "./store/room-store.js";
import { PostgresRoomStore } from "./store/postgres-room-store.js";
import { SqliteRoomStore } from "./store/sqlite-room-store.js";

// The web client defaults to localhost:3001, so this port is pinned; PORT only
// overrides it for deployment where the platform assigns one.
const DEFAULT_PORT = 3001;

// Zero-setup durable default: a file-backed SQLite db under the repo so a
// restart keeps rooms without installing anything. Relative to cwd (not
// __dirname) so it lands next to wherever the server is run from, matching
// IMAGE_UPLOADS_DIR's convention.
const DEFAULT_SQLITE_PATH = "./data/puzzlewithme.db";

function buildRoomStore(): RoomStore {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl !== undefined && databaseUrl !== "") {
    console.log("room store: Postgres (DATABASE_URL set)");
    return new PostgresRoomStore({ connectionString: databaseUrl });
  }
  const sqlitePath = process.env["SQLITE_PATH"] ?? DEFAULT_SQLITE_PATH;
  // SQLITE_PATH=":memory:" doubles as the in-memory escape hatch (e.g. tests
  // that want RoomStore's real SQL/JSON round-trip without a file) — no
  // separate flag needed since better-sqlite3 already treats that path
  // specially.
  console.log(`room store: SQLite (${sqlitePath})`);
  return new SqliteRoomStore({ path: sqlitePath });
}

function buildImageStore(): ImageStore {
  const bucket = process.env["S3_BUCKET"];
  if (bucket !== undefined && bucket !== "") {
    console.log(`image store: S3 (bucket ${bucket})`);
    // Region/credentials come from the environment (AWS_REGION,
    // AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) via the SDK's default
    // provider chain, same as any other AWS SDK client — no explicit wiring
    // needed here beyond dotenv/config having populated process.env above.
    const client = new S3Client({});
    return new S3ImageStore({ client, bucket });
  }
  console.log("image store: local disk (S3_BUCKET not set)");
  return new LocalDiskImageStore();
}

function start(): void {
  const port = Number(process.env["PORT"] ?? DEFAULT_PORT);
  const roomStore = buildRoomStore();
  const imageStore = buildImageStore();
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
