# Deploying

Deploy with `./deploy.sh [host]`. The [fleet skill](~/.agents/skills/fleet/SKILL.md)
holds the srv operating rules; its [apps resource](~/.agents/skills/fleet/resources/apps.md)
holds the deploy contract and first-deploy setup.

## App state and configuration

SQLite and local uploaded images live in the `puzzlewithme_server-data` volume.
The server flushes active rooms on SIGTERM; players reconnect after a restart.
Back up state with `docker compose cp server:/app/apps/server/data ./backup`
while the server is stopped, or use SQLite's backup API for a live database.

`NEXT_PUBLIC_SERVER_URL` is baked into the web image, so changing
`PUZZLE_HOSTNAME` requires a rebuild through `./deploy.sh`.

The tunnel routes `/ws` to `http://server:3001` before the catch-all route to
`http://web:3000`. Both routes use the same Cloudflare Access application.

## R2 photo cutover

This is a separate production operation, not part of building the app.

1. Create a private R2 bucket named `puzzlewithme-photos` and bucket-scoped
   read/write API credentials for the game server. Do not enable a public bucket URL.
2. Copy existing S3 objects to R2, preserving every key, byte and content type.
   Use Cloudflare Super Slurper or an S3-compatible transfer tool. Do not delete
   the source. Pause new uploads for the final copy and verification so no room
   can reference an object left behind in S3. Compare object counts and verify
   bytes for the room and gallery images before switching. No database edits.
3. Review `worker/wrangler.jsonc`: the route must use the game's existing hostname
   and the binding must name the destination bucket. Keep `workers_dev` and
   `preview_urls` disabled. Keep the hostname's Cloudflare Access policy covering
   `/photos/*`; Access is evaluated before the Worker.
4. From `worker`, run `bunx wrangler deploy`. Check an existing photo through an
   authenticated browser and confirm an unauthenticated request is denied by Access.
5. Set the Compose `.env`: `S3_BUCKET=puzzlewithme-photos`,
   `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`, `AWS_REGION=auto`,
   and the R2 credentials in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.
   Set `NEXT_PUBLIC_IMAGE_DELIVERY=worker` and rebuild/redeploy the app.
6. Verify a new upload, an old room, gallery selection, puzzle textures and the
   full-image preview. Browser requests should use `/photos/<key>`, not the image API.
   Resume uploads after verification.

The Worker uses private, year-long immutable browser caching, not shared edge
caching. It handles GET, HEAD and ETag revalidation. Object IDs never change content.

To roll back delivery, clear `NEXT_PUBLIC_IMAGE_DELIVERY` and rebuild the web app.
Keep the server pointed at R2: the existing image API can read it, including new
uploads. Switching storage back to S3 requires copying post-cutover objects back
first; otherwise newer rooms would lose their photos.

For a local-disk source, copy the files in `uploaded-images` to R2 under the
same names. Each `.meta.json` sidecar provides the object's `contentType`; do
not upload the sidecars as photos. Stop the server for the final copy, retain
a database/volume backup, and verify every room's `imageRef` exists in R2
before starting the R2-configured server. Keep the original files for rollback.

## Email-backed accounts

The game server validates Cloudflare Access assertions on every HTTP request and
WebSocket upgrade. Set `CF_ACCESS_ISSUER` to the team's
`https://TEAM.cloudflareaccess.com` URL and `CF_ACCESS_AUD` to this Access
application's audience tag. Compose requires both before starting. Preserve the
`Cf-Access-Jwt-Assertion` header through the Next.js API rewrite and route `/ws`
through the same Access application. Do not add Access bypass policies.

`GET /api/me` returns the current account. Email comparison trims whitespace and
ignores case, but preserves dots and plus-tags. Email stays out of game broadcasts.
Existing user IDs remain the primary keys; new emails get a server-generated ID.
API paths naming another user return 403. Room creation and game joins ignore
client-supplied ownership. Authenticated joins ignore old resume tokens. Sockets
close when their assertion expires; reload the page to complete Access login again.

### Migrate existing browser accounts

Stop the game server before applying a mapping, so live room checkpoints cannot
overwrite migrated identities. Rehearse against a consistent SQLite backup first.
Do not copy a live database file without its WAL; use SQLite's backup API.

Create a private mapping file outside tracked source:

```json
[
  {
    "email": "person@example.com",
    "userId": "canonical-existing-user-id",
    "legacyUserIds": ["another-device-user-id"],
    "displayName": "Chosen name",
    "roomNames": { "room-with-conflicting-names": "Chosen room name" }
  }
]
```

Have each owner confirm their old IDs. The tool does not infer ownership or accept
browser claims. `roomNames` is only needed for conflicting personal room labels.
Unmapped accounts remain untouched and cannot be claimed through the app.

From `apps/server`, using Node/tsx (not Bun's SQLite runtime):

```sh
bun run tsx src/migrate-accounts.ts /path/to/copy.db /private/mapping.json
# After reviewing the rehearsal, with the game server stopped:
bun run tsx src/migrate-accounts.ts /path/to/live.db /private/mapping.json --apply-offline
```

The default is read-only. Apply creates a SQLite backup before making one
transactional change. It merges gallery ownership, memberships, and room players,
sums their scores, rotates migrated resume tokens, and preserves puzzle geometry,
credited pieces, image references, timestamps, and solving time. A conflicting
email or unresolved room name fails before writing. Run once with all reviewed
mappings before allowing first login to create new accounts.

### Rollout checks

1. Run tests, typecheck, build, and the offline migration rehearsal.
2. Configure issuer/audience and deploy after the reviewed migration.
3. Through the real hostname, sign in in two independent browser profiles. Verify
   `/api/me`, profile/gallery/history, and the same in-room player on both.
4. Clear local storage and reload. Verify the account and room identity remain.
5. Switch emails. Verify the second account cannot reuse the first account's ID
   or old resume token. Verify both `/api` and `/ws` reject missing assertions.

A local preview proves app behavior but does not prove live Cloudflare forwarding.
For rollback, stop the server and restore the pre-migration backup together with
previous application code. Writes since that backup would be lost; keep the
rollout paused until smoke checks pass.
