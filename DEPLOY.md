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
