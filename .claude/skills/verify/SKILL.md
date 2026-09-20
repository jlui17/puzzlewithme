---
name: verify
description: Verify runtime changes in a real browser, or smoke-test production through Cloudflare Access. Use after changes to apps/web, apps/server, packages/geometry, or packages/shared with a runtime surface.
---

# Browser validation for PuzzleWithMe

Drives the real app (Next.js web + game server + WebSocket sync + PixiJS board). Prefer the OpenClaw browser when available; use `agent-browser` as the fallback.

This is the browser tier of the repo's test strategy (TESTING.md): the only coverage for the Pixi scene actually rendering and for real pointer events, run on demand rather than in `bun run test`. Anything expressible as a vitest test at a lower layer belongs there, not here.

## Choose the target and browser

1. Use the isolated stack below for development. For an authorized production check, follow [production.md](production.md) instead of starting or resetting a local stack.
2. With OpenClaw, call browser `status`, then `start` if needed, and `open` the target URL. Use its current tool schema for interactions. Confirm a snapshot and screenshot work before testing the board. If unavailable or a required interaction is unsupported, report the limitation and use the fallback.
3. With `agent-browser`, load `agent-browser skills get core` first. The CLI recipes below describe the fallback; run the same UI flow with OpenClaw when selected.

## Fallback harness notes

- **Check the host before using repo browser flags.** `agent-browser.json` sets `--use-angle=metal` for macOS. Use an appropriate backend on Linux; the OpenClaw-managed browser does not inherit this file. Earlier macOS runs deadlocked with SwiftShader on the board's antialiased canvas. Test the actual board before claiming rendering support.
- **Recover only the browser owned by this test.** If its daemon wedges, identify its session/process before stopping it; shared browser processes may belong to other work.
- **Use absolute screenshot paths.** Relative CLI paths may land in `~/.agent-browser/tmp/screenshots/`.
- **Check image loading separately from capture.** Earlier CLI runs hit screenshot/evaluation failures on pages with loading `<img>` elements. Inspect image completion and network errors before retrying; do not treat that historical harness issue as a blanket ban on image-page screenshots.

## Stack lifecycle

```bash
scripts/e2e-env.sh start            # web :3100, server :3101 — isolated from dev's 3000/3001
scripts/e2e-env.sh start --fresh    # same, after wiping rooms and uploads
scripts/e2e-env.sh stop
scripts/e2e-env.sh status
scripts/e2e-env.sh reset            # stop, then wipe
```

State lives in gitignored `.e2e/data` (SQLite db + uploads) and survives a stop/start, so rooms and gallery images from an earlier run are still there when you come back. Nothing touches the real dev DB or S3 either way. Use `--fresh` when leftovers would confuse the check — anything reading the home gallery or a room list — or when you want to prove first-run behavior. The web compile is isolated too, via `NEXT_DIST_DIR=.next-e2e`: `NEXT_PUBLIC_SERVER_URL` is inlined at compile time, so a shared `.next` would hand dev's browsers a bundle pointed at this stack's server, where none of dev's rooms exist. Logs: `.e2e/server.log`, `.e2e/web.log`. `start` warms the `/` and `/room/[id]` dev compiles so the browser never waits on them.

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
agent-browser wait --text "Closest clean fit"   # the slip's step-02 note, which only appears once the picked image has been measured
agent-browser find role button click --name "Brew this puzzle →"
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
- Brew slip (top left): `N of M pieces placed`. Players card (top right, "At the table"): display names and per-player counts.
- Tray buttons: `See the picture`, `Hide who's here`, `Switch to night` (the theme switch names the light it will change to, so it reads `Switch to day` once it's night), `Head out`.
- Append `?debug=1` to the room URL for the sync-diagnostics overlay (message counts per type).

A drag that survives `mouse up` (piece stays where dropped in the next screenshot) proves the full grab→move→drop round trip through the server, not just local rendering.

## Multiplayer / sync checks

Separate browser sessions provide separate WebSocket connections. Account identity follows [TESTING.md's authenticated-account guidance](../../../TESTING.md#authenticated-accounts), not localStorage. With the isolated stack, this is a same-account cross-session sync check:

```bash
AGENT_BROWSER_SESSION=p2 agent-browser open "http://localhost:3100/room/$ROOM"
```

Then assert session p2 sees session 1's moves (screenshot). A distinct-player check needs two separately authenticated accounts; two tabs sharing cookies do not establish it. Close extras with `AGENT_BROWSER_SESSION=p2 agent-browser close`.

## Cleanup

```bash
agent-browser close
scripts/e2e-env.sh stop
```

For OpenClaw, close only this test's tabs. Stop the local stack only if this run started it. Production cleanup follows the production recipe.
