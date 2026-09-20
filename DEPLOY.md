# Deploying

Production runs on a single VPS with docker compose, published through a
Cloudflare Tunnel, with Cloudflare Access as the door. Only people on an email
allowlist you control can reach any part of the app; the repo stays public
because every secret lives in the VPS's gitignored `.env`.

```
browser ──► Cloudflare (Access: email allowlist)
                │ tunnel
                ▼
            VPS: docker compose ── no ports open on the host
                ├─ cloudflared   routes  /ws ──────────► server:3001
                │                everything else ──────► web:3000
                ├─ web (Next)    proxies /api/rooms* ──► server:3001 (in-network)
                └─ server        SQLite + images on the `server-data` volume
```

Why this shape:

- **The VPS listens on nothing.** `cloudflared` dials out to Cloudflare, so
  there is no origin IP to hit and no way around Access. No TLS certs to
  manage either; Cloudflare terminates TLS.
- **Access covers everything** because the WebSocket and all HTTP share one
  hostname. The browser's `CF_Authorization` cookie rides the WS upgrade too.
- Room IDs were already unguessable (128-bit), but `POST /api/rooms` was open
  to anyone who found the host; Access closes that.

## One-time setup

### 1. Point the domain's DNS at Cloudflare

The domain stays registered at Squarespace; only DNS moves.

1. Create a free Cloudflare account, **Add a domain**, pick the Free plan.
   Cloudflare imports your existing DNS records; check anything the domain
   currently serves (e.g. a Squarespace site) survived the import.
2. Cloudflare shows two nameservers. In Squarespace: **Domains → your domain →
   DNS → Nameservers → Use custom nameservers**, paste them.
3. Wait for Cloudflare to email that the zone is active (minutes to hours).

### 2. Create the tunnel

In [one.dash.cloudflare.com](https://one.dash.cloudflare.com) (Zero Trust):

1. **Networks → Tunnels → Create a tunnel → Cloudflared.** Name it
   (`puzzlewithme`), and copy the token from the install command it shows
   (the long string after `--token`). That goes in the VPS `.env` as
   `TUNNEL_TOKEN`. Skip the connector install step; compose runs it.
2. On the tunnel, add **two public hostnames, in this order** (first match
   wins, so `/ws` must be above the catch-all):

   | Order | Hostname | Path | Service |
   |---|---|---|---|
   | 1 | `puzzle.<your-domain>` | `ws` | `http://server:3001` |
   | 2 | `puzzle.<your-domain>` | *(empty)* | `http://web:3000` |

   The service URLs are compose service names; cloudflared resolves them on
   the compose network. Cloudflare creates the DNS record for the hostname
   automatically.

### 3. Gate it with Access

Still in Zero Trust:

1. **Access → Applications → Add an application → Self-hosted.**
   Application domain: `puzzle.<your-domain>` (whole hostname, no path, so
   pages, API, and WebSocket are all behind it).
2. Add an **Allow** policy: Include → **Emails** → list the addresses of the
   people you're inviting. That list *is* the access control; add or remove a
   line to grant or revoke.
3. Login method: **One-time PIN** is the zero-setup option (visitors get a
   code by email). Session duration default (24h) means one login a day.

### 4. Run it on the VPS

Needs Docker with the compose plugin (`docker compose version`; on a bare
VPS: `curl -fsSL https://get.docker.com | sh`), and an ssh-config alias for
the box (default `oc`, override with `DEPLOY_HOST`).

One-time: put the secrets on the VPS (they live only there, never in git):

```sh
scp .env.example oc:~/puzzlewithme/.env   # then fill in PUZZLE_HOSTNAME and TUNNEL_TOKEN over ssh
```

Then, from your machine:

```sh
./deploy.sh
```

When deploying from the VPS itself, run:

```sh
DEPLOY_MODE=local ./deploy.sh
```

Local mode syncs to `~/puzzlewithme`, using the home directory of the user
running the deploy. Remote mode remains the default for laptop deployments.

Open `https://puzzle.<your-domain>`: you should hit the Cloudflare Access
login, and the app after the emailed code.

## Operating it

- **Deploy an update:** `./deploy.sh`. It typechecks, rsyncs the working
  tree (whatever is in it, committed or not), rebuilds only what changed,
  and health-checks web + server wiring from inside the compose network.
  The server flushes active rooms on SIGTERM (`main.ts` shutdown handler),
  so a restart mid-game persists state; players reconnect when it's back.
- **State** (SQLite db + uploaded images) lives on the `server-data` volume
  and survives rebuilds. Back it up with
  `docker compose cp server:/app/apps/server/data ./backup`.
- **S3 images instead of the volume:** set the `S3_BUCKET`/`AWS_*` vars in
  `.env` and `docker compose up -d` (the server picks S3 when `S3_BUCKET` is
  set, see `main.ts`).
- **Logs:** `docker compose logs -f server` (or `web`, `cloudflared`).

## Limits worth knowing

- **Access allowlist caps at 50 users on the free plan.** Fine for
  "select people"; not a public-launch path.
- **Anyone on the allowlist can create rooms and upload images.** There is no
  per-user quota inside the app; the trust boundary is the email list.
- **`NEXT_PUBLIC_SERVER_URL` is baked into the web image at build time**
  (Next inlines it into the client bundle), so changing `PUZZLE_HOSTNAME`
  requires `docker compose up -d --build`, not just a restart.

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
