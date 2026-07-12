#!/usr/bin/env bash
# Deploy the working tree to the VPS and rebuild there (see DEPLOY.md).
#
# Ships the local tree via rsync rather than git-pulling on the VPS so a
# deploy needs no GitHub auth on the box and works from any local state.
# The flip side: whatever is in your working tree is what ships, committed
# or not.
set -euo pipefail
cd "$(dirname "$0")"

# SSH destination for the VPS. An ssh-config alias by default so the public
# repo carries no hostname/IP/user; point DEPLOY_HOST elsewhere to deploy to
# a different box.
HOST="${DEPLOY_HOST:-oc}"
DIR="puzzlewithme"

echo "==> typecheck"
pnpm typecheck

echo "==> sync to $HOST:~/$DIR"
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
  ./ "$HOST:~/$DIR/"

echo "==> build + restart"
# compose only rebuilds layers whose inputs changed, so an unchanged app is a
# no-op and the server flushes rooms on SIGTERM before restarting.
ssh "$HOST" "cd ~/$DIR && sudo docker compose up -d --build" | tail -5

echo "==> health check"
# From inside the compose network: homepage via web, and an API route that
# only answers through the web->server rewrite, proving both containers and
# their wiring are up. Public-URL checks would only see the Access login.
# Retries because compose returns before the recreated containers finish
# booting; 15x2s comfortably covers the observed ~seconds startup while
# still failing fast on a genuinely broken deploy.
ssh "$HOST" "cd ~/$DIR && sudo docker compose exec -T web node -e \"
const check = () => Promise.all([
  fetch('http://localhost:3000/').then(r => { if (r.status !== 200) throw new Error('homepage ' + r.status); }),
  fetch('http://localhost:3000/api/rooms/deploy-check').then(r => { if (r.status !== 404) throw new Error('api ' + r.status); }),
]);
const retry = (n) => check().then(() => console.log('healthy')).catch(e => {
  if (n <= 0) { console.error(e.message); process.exit(1); }
  setTimeout(() => retry(n - 1), 2000);
});
retry(15);\""

echo "==> deployed"
