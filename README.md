# PuzzleWithMe

A browser-based cooperative jigsaw puzzle game. Upload an image, pick a piece count, share the link; anyone with it joins the same live board and solves it together in real time, no account required. Full spec: [SPEC.md](./SPEC.md).

## Architecture

Five components (SPEC §6):

| Component | Directory | What it does |
|---|---|---|
| Web client | `apps/web` | Next.js UI; renders the board, sends grab/move/drop intents, applies server results. Headless sync logic lives in `apps/web/src/sync` (DOM-free, socket injected) so it's unit-testable without a browser; `apps/web/src/sync/websocket-adapter.ts` is the real-socket adapter used in the browser. |
| Game server | `apps/server` | The referee (`apps/server/src/engine`) and the single writer of room state. `apps/server/src/net/server.ts`'s `createGameServer` mounts the HTTP handler (`apps/server/src/http`) and the WebSocket layer (`apps/server/src/net`) on one `http.Server`. Entrypoint: `apps/server/src/main.ts`. |
| Room store | `apps/server/src/store` | Durable room record (settings, board deviations, scores). `InMemoryRoomStore` for dev/tests, `PostgresRoomStore` for production; both implement the same `RoomStore` interface. |
| Image store | `apps/server/src/images` | Durable storage for uploaded images. `LocalDiskImageStore` writes to disk; validates/downscales/re-encodes uploads to webp on the way in (`process-image.ts`). |
| Puzzle geometry | `packages/geometry` | Deterministic `(image, rows, cols, seed) → piece shapes, layout, scatter`. Pure, seed-driven, no I/O. Imported by both the server (referee) and the web client (rendering/prediction), so they can never disagree on geometry by construction. |

`packages/shared` holds the wire protocol (client/server message types, zod validation for inbound client messages, room/group/score state shapes) that the server and web client both import.

## Running locally

Two processes:

```
pnpm --filter @puzzlewithme/server dev   # :3001 — HTTP API + WebSocket
pnpm --filter @puzzlewithme/web dev      # :3000 — Next.js UI
```

Env vars (server):
- `PORT` — HTTP/WS port, defaults to 3001.
- `DATABASE_URL` — Postgres connection string. Set it to persist rooms across restarts; omit it and the server falls back to an in-memory room store (rooms are lost on restart, no setup needed for local dev).
- `IMAGE_UPLOADS_DIR` — where uploaded images are stored, defaults to `./uploaded-images`.

Env vars (web):
- `NEXT_PUBLIC_SERVER_URL` — the game server's origin, defaults to `http://localhost:3001`.

The web app's Next config (`apps/web/next.config.ts`) rewrites `/api/*` to the server so browser HTTP calls stay same-origin (the server sets no CORS headers, and a cross-origin image would taint the WebGL canvas). The WebSocket connects directly to `NEXT_PUBLIC_SERVER_URL`'s host at `/ws`, since a rewrite can't proxy an upgrade in dev.

## Testing

```
pnpm test        # all packages
pnpm typecheck
pnpm build
```

`pnpm test` runs everything except the Postgres room-store suite, which is skipped unless `DATABASE_URL` is set (run `pnpm --filter @puzzlewithme/server migrate` first to create the table).

**Why the server and sync logic are unit-testable at all:** puzzle geometry is a pure function of a seed (`packages/geometry`), so a test can compute the exact expected piece positions and drive a real grab/move/drop sequence without faking randomness. `apps/server/src/e2e.test.ts` uses this to boot the real HTTP+WS server in-process, create a room through the actual multipart upload endpoint, and play a real solve sequence across two WebSocket clients, asserting both converge on identical results and a late-joining third client's snapshot matches. The web client's sync layer (`apps/web/src/sync`) is DOM-free for the same reason: it takes an injected socket, so `sync-client.test.ts` and `board-store.test.ts` drive it with a fake one.

The rendering/input layer (`apps/web/src/board`, PixiJS canvas and pointer handling) has no equivalent automated coverage; it's tested manually.
