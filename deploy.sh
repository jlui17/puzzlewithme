#!/usr/bin/env bash
# Deploy the pushed HEAD commit to srv (see the fleet skill's resources/apps.md).
set -euo pipefail
cd "$(dirname "$0")"

git fetch --all --prune
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty; commit or stash changes before deploying." >&2
  exit 1
fi
if [[ -z "$(git branch -r --contains HEAD)" ]]; then
  echo "HEAD is not contained in any remote branch; push it before deploying." >&2
  exit 1
fi

HOST="${1:-$(fleet target srv)}"
DIR="apps/puzzlewithme"
SHA="$(git rev-parse HEAD)"
MACHINE="$(fleet whoami 2>/dev/null | awk 'NR == 1 { sub(/:$/, "", $1); print $1 }')" || MACHINE="$(hostname)"
MACHINE="${MACHINE:-$(hostname)}"
if ! ssh -o BatchMode=yes "$HOST" "test -f ~/$DIR/.env"; then
  echo "Create ~/$DIR/.env on $HOST (chmod 600) with PUZZLE_HOSTNAME, TUNNEL_TOKEN, CF_ACCESS_ISSUER, and CF_ACCESS_AUD; see .env.example." >&2
  exit 1
fi
echo "==> typecheck"
bun run typecheck

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git archive HEAD | tar -x -C "$TMP"
echo "==> sync $SHA to $HOST:~/$DIR"
rsync -az --delete --exclude .env --exclude deploys.log -e 'ssh -o BatchMode=yes' "$TMP/" "$HOST:~/$DIR/"

DEPLOY='set -euo pipefail
cd "$HOME/$1"
SHA="$2"
MACHINE="$3"
receipt() { printf "%s %s %s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SHA" "$MACHINE" "$1" >> deploys.log; }
REASON="compose up"
finish() { local status=$?; if (( status != 0 )); then receipt "failed: $REASON"; fi; }
trap finish EXIT
receipt started
echo "==> build + restart"
docker compose up -d --build

REASON="services not running"
echo "==> service check"
SERVICES="$(docker compose config --services)"
for ((attempt=1; attempt<=15; attempt++)); do
  RUNNING="$(docker compose ps --status running --services)"
  MISSING=""
  for service in $SERVICES; do
    if ! grep -Fxq "$service" <<< "$RUNNING"; then MISSING="$MISSING $service"; fi
  done
  if [[ -z "$MISSING" ]]; then break; fi
  if (( attempt == 15 )); then
    REASON="services not running:$MISSING"
    echo "$REASON" >&2
    exit 1
  fi
  sleep 2
done

REASON="HTTP health check"
echo "==> health check"
docker compose exec -T web node -e "
const check = () => Promise.all([
  fetch(\"http://localhost:3000/\").then(r => { if (r.status !== 200) throw new Error(\"homepage \" + r.status); }),
  fetch(\"http://localhost:3000/api/me\").then(r => { if (r.status !== 401) throw new Error(\"unauthenticated api \" + r.status); }),
]);
const retry = (n) => check().then(() => console.log(\"healthy\")).catch(e => {
  if (n <= 0) { console.error(e.message); process.exit(1); }
  setTimeout(() => retry(n - 1), 2000);
});
retry(15);" </dev/null
receipt ok
echo "==> deployed"'
# Pass the script as an argument: compose exec must not consume its remaining stdin.
ssh -o BatchMode=yes "$HOST" "bash -c $(printf '%q' "$DEPLOY") -- $(printf '%q ' "$DIR" "$SHA" "$MACHINE")"
