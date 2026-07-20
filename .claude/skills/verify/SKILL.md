---
name: verify
description: Validate a change end-to-end in a real browser with agent-browser. Boots an isolated web+server stack, creates a puzzle room, drives the PixiJS board, and checks sync across two browser sessions. Use after any change to apps/web, apps/server, packages/geometry, or packages/shared that has a runtime surface.
---

# Browser validation for PuzzleWithMe

Drives the real app (Next.js web + game server + WebSocket sync + PixiJS board) with the `agent-browser` CLI. Every command below was validated working; deviate only when the UI has changed.

## Hard requirements (read first)

- **Run every `agent-browser` command from the repo root.** `./agent-browser.json` there passes `--use-angle=metal` to Chrome. Without it, headless Chrome falls back to swiftshader WebGL, which deadlocks on the board's `antialias: true` canvas and wedges the whole agent-browser daemon (every later command fails with `Resource temporarily unavailable (os error 35)`).
- **If the daemon wedges anyway**: `pkill -9 -f agent-browser-darwin; pkill -9 -f "Chrome for Testing"` and start over. `agent-browser close` will hang; don't wait on it.
- **Screenshot paths must be absolute.** A relative path silently lands in `~/.agent-browser/tmp/screenshots/` instead.

## Stack lifecycle

```bash
scripts/e2e-env.sh start    # web :3100, server :3101 — isolated from dev's 3000/3001
scripts/e2e-env.sh stop
scripts/e2e-env.sh status
```

State is throwaway by design (`SQLITE_PATH=:memory:`, uploads under gitignored `.e2e/`), so every start is a clean slate and nothing touches the real dev DB or S3. Logs: `.e2e/server.log`, `.e2e/web.log`. `start` warms the `/` and `/room/[id]` dev compiles so the browser never waits on them.

## Fixture image

```bash
bun scripts/make-test-image.mjs         # writes .e2e/fixture.png
```

800×600, 8×6 labeled color cells: adjacent pieces almost always differ in color and each carries its `row,col` label, so a screenshot shows at a glance whether pieces rendered and carry the right image region.

## Recipe: full UI flow (menu → create → board)

```bash
agent-browser open http://localhost:3100
agent-browser wait --text "PuzzleWithMe"
agent-browser upload 'input[type=file]' .e2e/fixture.png   # the file input is hidden; CSS selector works anyway
agent-browser wait --text "fixture.png"
agent-browser find role button click --name "Create puzzle"
agent-browser wait --url "**/room/**"
sleep 5    # board boot: image fetch + atlas build + WS join; no DOM signal marks it done
agent-browser screenshot /abs/path/board.png
```

## Recipe: room via API (faster when the menu isn't what changed)

```bash
ROOM=$(curl -s -X POST http://localhost:3101/api/rooms -F image=@.e2e/fixture.png -F pieces=100 \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['roomId'])")
agent-browser open "http://localhost:3100/room/$ROOM"
```

`pieces` must be 100–1000 (server validates). 100 pieces on this fixture yields a 12×9=108 board.

## Interacting with the board

Pieces live in a canvas — invisible to `snapshot`. Verify visually via screenshots and interact via mouse coordinates:

```bash
agent-browser eval "JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})"
# viewport matches screenshot pixels 1:1 at dpr 1, so read drag coordinates straight off a screenshot
agent-browser mouse move 935 481    # over a piece (from screenshot)
agent-browser mouse down
agent-browser mouse move 800 400    # intermediate steps make the drag realistic
agent-browser mouse move 660 300
agent-browser mouse up
```

DOM-verifiable signals (these ARE in `snapshot` / `wait --text`):
- Progress panel: `N / M` placed count and the player list with display names.
- Bottom bar buttons: `🖼️ Preview`, `👥 Hide players`, `🏠 Menu`.
- Append `?debug=1` to the room URL for the sync-diagnostics overlay (message counts per type).

A drag that survives `mouse up` (piece stays where dropped in the next screenshot) proves the full grab→move→drop round trip through the server, not just local rendering.

## Multiplayer / sync checks

Separate browser sessions are separate users (own localStorage identity, own WS):

```bash
AGENT_BROWSER_SESSION=p2 agent-browser open "http://localhost:3100/room/$ROOM"
```

Then assert session p2 sees session 1's moves (screenshot) and both names in the progress panel. Close extras with `AGENT_BROWSER_SESSION=p2 agent-browser close`.

## Cleanup

```bash
agent-browser close --all
scripts/e2e-env.sh stop
```
