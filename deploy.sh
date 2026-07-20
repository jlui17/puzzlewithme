#!/usr/bin/env bash
# Deploy the working tree to the VPS and rebuild there (see DEPLOY.md).
#
# Ships the local tree via rsync rather than git-pulling on the VPS so a
# deploy needs no GitHub auth on the box and works from any local state.
# The flip side: whatever is in your working tree is what ships, committed
# or not.
set -euo pipefail
cd "$(dirname "$0")"

# Set DEPLOY_MODE=local when running this script on the VPS itself. Local
# deploys target the current user's home directory, so no VPS username or
# absolute path is baked into the public repo.
MODE="${DEPLOY_MODE:-remote}"
HOST="${DEPLOY_HOST:-oc}"
DIR="puzzlewithme"

case "$MODE" in
  local)
    TARGET="$HOME/$DIR"
    ;;
  remote)
    TARGET="$HOST:~/$DIR"
    ;;
  *)
    echo "DEPLOY_MODE must be 'local' or 'remote'" >&2
    exit 2
    ;;
esac

echo "==> typecheck"
bun run typecheck

echo "==> sync to $TARGET"
# --delete keeps the remote tree an exact mirror so removed files don't
# linger. Excluded paths are both not-shipped and protected from that
# deletion; .env matters most (the VPS's tunnel token lives there and must
# never be overwritten or deleted by a deploy).
rsync -az --delete \
  --exclude .env \
  --exclude .git \
  --exclude node_modules \
  --exclude .next \
  --exclude dist \
  --exclude data \
  --exclude uploaded-images \
  --exclude coverage \
  --exclude .e2e \
  --exclude .claude/worktrees \
  --exclude '*.tsbuildinfo' \
  --exclude next-env.d.ts \
  ./ "$TARGET/"

echo "==> build + restart"
# compose only rebuilds layers whose inputs changed, so an unchanged app is a
# no-op and the server flushes rooms on SIGTERM before restarting.
if [[ "$MODE" == local ]]; then
  (cd "$TARGET" && sudo docker compose up -d --build) | tail -5
else
  ssh "$HOST" "cd ~/$DIR && sudo docker compose up -d --build" | tail -5
fi

echo "==> health check"
# From inside the compose network: homepage via web, and an API route that
# only answers through the web->server rewrite, proving both containers and
# their wiring are up. Public-URL checks would only see the Access login.
# Retries because compose returns before the recreated containers finish
# booting; 15x2s comfortably covers the observed ~seconds startup while
# still failing fast on a genuinely broken deploy.
HEALTH_CHECK="
const check = () => Promise.all([
  fetch('http://localhost:3000/').then(r => { if (r.status !== 200) throw new Error('homepage ' + r.status); }),
  fetch('http://localhost:3000/api/rooms/deploy-check').then(r => { if (r.status !== 404) throw new Error('api ' + r.status); }),
]);
const retry = (n) => check().then(() => console.log('healthy')).catch(e => {
  if (n <= 0) { console.error(e.message); process.exit(1); }
  setTimeout(() => retry(n - 1), 2000);
});
retry(15);"

if [[ "$MODE" == local ]]; then
  (cd "$TARGET" && sudo docker compose exec -T web node -e "$HEALTH_CHECK")
else
  ssh "$HOST" "cd ~/$DIR && sudo docker compose exec -T web node -e \"$HEALTH_CHECK\""
fi

echo "==> deployed"
