# PuzzleWithMe

A browser-based cooperative jigsaw puzzle game. Upload an image, pick a piece count, share the link; anyone with it joins the same live board and solves it together in real time, no account required. Full spec: [SPEC.md](./SPEC.md).

## Architecture

Five components (SPEC §6):

| Component | Directory | What it does |
|---|---|---|
| Web client | `apps/web` | Next.js UI; renders the board, sends grab/move/drop intents, applies server results. Headless sync logic lives in `apps/web/src/sync` (DOM-free, socket injected) so it's unit-testable without a browser; `apps/web/src/sync/websocket-adapter.ts` is the real-socket adapter used in the browser. |
| Game server | `apps/server` | The referee (`apps/server/src/engine`) and the single writer of room state. `apps/server/src/net/server.ts`'s `createGameServer` mounts the HTTP handler (`apps/server/src/http`) and the WebSocket layer (`apps/server/src/net`) on one `http.Server`. Entrypoint: `apps/server/src/main.ts`. |
| Room store | `apps/server/src/store` | Durable room record (settings, board deviations, scores). `SqliteRoomStore` is the zero-setup default, `PostgresRoomStore` for production, `InMemoryRoomStore` for tests; all three implement the same `RoomStore` interface. |
| Image store | `apps/server/src/images` | Durable storage for uploaded images. `S3ImageStore` (production) or `LocalDiskImageStore` (zero-setup default) writes the bytes; `process-image.ts` validates/downscales/re-encodes uploads to lossless webp on the way in, regardless of which store holds the result. |
| Puzzle geometry | `packages/geometry` | Deterministic `(image, rows, cols, seed) → piece shapes, layout, scatter`. Pure, seed-driven, no I/O. Imported by both the server (referee) and the web client (rendering/prediction), so they can never disagree on geometry by construction. |

`packages/shared` holds the wire protocol (client/server message types, zod validation for inbound client messages, room/group/score state shapes) that the server and web client both import.

## Running locally

Two processes:

```
pnpm --filter @puzzlewithme/server dev   # :3001 — HTTP API + WebSocket
pnpm --filter @puzzlewithme/web dev      # :3000 — Next.js UI
```

The server loads `apps/server/.env` automatically on boot (a plain `import "dotenv/config"` at the top of `main.ts`, before anything else touches `process.env`) — it's a no-op if the file doesn't exist, so this works the same whether you're running locally with a `.env` or deploying to a VPS with real env vars set another way. Both `pnpm --filter @puzzlewithme/server dev` and `pnpm --filter @puzzlewithme/server start` go through this. (Node's own `--env-file`/`--env-file-if-exists` flags were considered and rejected: the former errors when the file is missing, the latter needs Node ≥22.9, and this repo supports Node ≥20.)

Env vars (server):
- `PORT` — HTTP/WS port, defaults to 3001.
- `DATABASE_URL` — Postgres connection string. Set it to use Postgres as the room store; omit it and the server falls back to SQLite (see `SQLITE_PATH`), so persistence works with no database to install.
- `SQLITE_PATH` — path to the SQLite room-store file, used when `DATABASE_URL` is unset. Defaults to `./data/puzzlewithme.db` (created on first boot). Set it to `:memory:` for an ephemeral, non-persistent store.
- `S3_BUCKET` — S3 bucket name for uploaded images. Set it to use `S3ImageStore` as the image store; omit it and the server falls back to `LocalDiskImageStore` (see `IMAGE_UPLOADS_DIR`), so image storage works with no bucket to provision.
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — credentials for `S3_BUCKET`, read by the AWS SDK's default provider chain (nothing in this repo parses them directly). The IAM identity only needs `s3:ListBucket` on the bucket and `s3:GetObject`/`s3:PutObject` on its objects — no delete permission, matching `ImageStore`'s contract that a room's image is written once and never changed or removed.
- `IMAGE_UPLOADS_DIR` — where uploaded images are stored when `S3_BUCKET` is unset, defaults to `./uploaded-images`.

Env vars (web):
- `NEXT_PUBLIC_SERVER_URL` — the game server's origin, defaults to `http://localhost:3001`.

The web app's Next config (`apps/web/next.config.ts`) rewrites `/api/*` to the server so browser HTTP calls stay same-origin (the server sets no CORS headers, and a cross-origin image would taint the WebGL canvas). The WebSocket connects directly to `NEXT_PUBLIC_SERVER_URL`'s host at `/ws`, since a rewrite can't proxy an upgrade in dev.

## Testing

```
pnpm test        # all packages
pnpm typecheck
pnpm build
```

`pnpm test` runs everything except two integration suites gated on real infrastructure: the Postgres room-store suite, skipped unless `DATABASE_URL` is set (run `pnpm --filter @puzzlewithme/server migrate` first to create the table), and the S3 image-store suite, skipped unless `S3_BUCKET` is set. Both are unit-tested against a fake in `pnpm test`'s default run (`InMemoryRoomStore`'s contract tests, `S3ImageStore`'s fake-client tests); the gated suites just confirm the real SDK/driver calls round-trip. The S3 suite can't clean up after itself (its IAM credentials have no delete permission), so it always overwrites one fixed object key rather than minting a new one per run.

**Why the server and sync logic are unit-testable at all:** puzzle geometry is a pure function of a seed (`packages/geometry`), so a test can compute the exact expected piece positions and drive a real grab/move/drop sequence without faking randomness. `apps/server/src/e2e.test.ts` uses this to boot the real HTTP+WS server in-process, create a room through the actual multipart upload endpoint, and play a real solve sequence across two WebSocket clients, asserting both converge on identical results and a late-joining third client's snapshot matches. The web client's sync layer (`apps/web/src/sync`) is DOM-free for the same reason: it takes an injected socket, so `sync-client.test.ts` and `board-store.test.ts` drive it with a fake one.

The rendering/input layer (`apps/web/src/board`, PixiJS canvas and pointer handling) has no equivalent automated coverage; it's tested manually.
