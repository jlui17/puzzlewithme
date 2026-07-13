#!/usr/bin/env bash
# Isolated browser-validation stack: web + server on their own ports with
# throwaway state, so it can run alongside (or instead of) the normal dev
# servers without touching their DB or uploads.
#
# Usage: scripts/e2e-env.sh start|stop|status
#
# Ports 3100/3101 mirror the dev pair 3000/3001 (+100) so the mapping is easy
# to remember while never colliding with a dev stack someone left running.
WEB_PORT=3100
SERVER_PORT=3101

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Runtime state (pids, logs, uploads, fixture) lives in a gitignored dir so a
# crashed run leaves nothing for git to pick up.
STATE_DIR="$ROOT/.e2e"

# The server has no health route; any HTTP status (even 404) proves the
# process is up, while curl reports 000 when nothing is listening.
responds() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$1")" != "000" ]
}

start() {
  if [ -f "$STATE_DIR/server.pid" ] && kill -0 "$(cat "$STATE_DIR/server.pid")" 2>/dev/null; then
    echo "already running (use 'stop' first)"; status; return 0
  fi
  mkdir -p "$STATE_DIR"

  # Job control gives each background pipeline its own process group, so
  # stop() can kill the whole pnpm -> tsx/next tree with one kill -- -pgid.
  set -m

  # :memory: SQLite + throwaway uploads dir: every start is a clean slate, so
  # validation steps never depend on leftovers from a previous run.
  # S3_BUCKET="" beats apps/server/.env pointing at real S3: dotenv never
  # overrides an existing env var, and main.ts treats empty as unset.
  PORT=$SERVER_PORT SQLITE_PATH=":memory:" S3_BUCKET="" IMAGE_UPLOADS_DIR="$STATE_DIR/uploads" \
    pnpm --filter @puzzlewithme/server dev >"$STATE_DIR/server.log" 2>&1 &
  echo $! > "$STATE_DIR/server.pid"

  # PORT env instead of `-- -p`: pnpm forwards the literal `--` to next dev,
  # which reads it as a project directory and dies.
  PORT=$WEB_PORT NEXT_PUBLIC_SERVER_URL="http://localhost:$SERVER_PORT" \
    pnpm --filter @puzzlewithme/web dev >"$STATE_DIR/web.log" 2>&1 &
  echo $! > "$STATE_DIR/web.pid"

  # Server boot is tsx + sqlite (fast); Next dev compiles on demand, so its
  # readiness here only means the port is accepting — the first page load
  # still pays the compile. 60 tries × 0.5s covers a cold pnpm/tsx start.
  for _ in $(seq 1 60); do
    server_up=$(responds "http://localhost:$SERVER_PORT/api/rooms" && echo 1 || echo "")
    web_up=$(responds "http://localhost:$WEB_PORT" && echo 1 || echo "")
    [ -n "$server_up" ] && [ -n "$web_up" ] && break
    sleep 0.5
  done

  status
  if [ -z "$web_up" ] || [ -z "$server_up" ]; then
    echo "--- server.log (tail) ---"; tail -20 "$STATE_DIR/server.log"
    echo "--- web.log (tail) ---"; tail -20 "$STATE_DIR/web.log"
    return 1
  fi

  # Warm the two routes the validation flow hits, so agent-browser never
  # stares at a Next dev-compile spinner.
  curl -sf -o /dev/null "http://localhost:$WEB_PORT" || true
  curl -sf -o /dev/null "http://localhost:$WEB_PORT/room/warmup" || true
  echo "ready: web http://localhost:$WEB_PORT  server http://localhost:$SERVER_PORT  logs $STATE_DIR/*.log"
}

stop() {
  for name in server web; do
    pidfile="$STATE_DIR/$name.pid"
    if [ -f "$pidfile" ]; then
      pid=$(cat "$pidfile")
      # pnpm wraps the real process; kill the whole process group it leads.
      kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      rm -f "$pidfile"
      echo "stopped $name ($pid)"
    fi
  done
  # Belt and braces: anything still holding our ports is ours (the ports
  # exist only for this script).
  for port in $WEB_PORT $SERVER_PORT; do
    lsof -ti tcp:$port 2>/dev/null | xargs kill 2>/dev/null || true
  done
}

status() {
  for entry in "web:$WEB_PORT" "server:$SERVER_PORT"; do
    name=${entry%%:*}; port=${entry##*:}
    if lsof -ti tcp:$port >/dev/null 2>&1; then
      echo "$name: up on :$port"
    else
      echo "$name: down (:$port)"
    fi
  done
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
