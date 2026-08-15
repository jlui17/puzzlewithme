# Testing

The strategy in one sentence: push logic into pure or seam-injected modules and test it there exhaustively; give each component one in-process integration suite against real neighbors where the seam is the risk; keep exactly one full-stack smoke test; check rendering in a real browser on demand, not in CI.

Run everything:

```
bun run test        # vitest across all workspaces (vitest.config.ts projects)
bun run typecheck
```

## Which layer owns which failure

A bug should fail in the lowest layer that can express it. Before writing a test, find the row; before debugging a high-layer failure, ask which lower layer should have caught it (and add the missing low test alongside the fix).

| A bug in... | ...fails in | Example suites |
|---|---|---|
| Piece shapes, snapping, scatter, grid math | `packages/geometry` unit tests | `snap.test.ts`, `puzzle.test.ts` |
| Wire-message shape or validation | `packages/shared` unit tests | `validation.test.ts` |
| Local-vs-authoritative arbitration | `apps/web/src/sync/reconcile.test.ts` | pure function, no socket |
| Client connect/reconnect/throttle/state | sync-layer tests with fakes | `sync-client.test.ts`, `board-store.test.ts`, `throttle.test.ts` |
| Room rules (grab/move/drop legality, scoring) | `apps/server/src/engine` unit tests | `room.test.ts` |
| Store durability semantics | the `RoomStore` contract suite | `store/contract.test-suite.ts` |
| WS wiring, join handshake, fan-out policy | in-process integration | `net/ws-integration.test.ts`, `net/registry.test.ts` |
| HTTP routing/multipart | `http/handler.test.ts` | |
| Camera math, hit-testing, gesture arbitration | `apps/web/src/board` unit tests | `camera.test.ts`, `hit-test.test.ts`, `input.test.ts` |
| A seam only visible with everything wired | the one full-stack smoke | `apps/server/src/e2e.test.ts` |
| Rendering, input feel, atlas on a real GPU | browser check (on demand) | `.claude/skills/verify` |

## The layers and their patterns

**Pure core: test the function, not the system.** Geometry is deterministic `(image, rows, cols, seed) → layout` (`packages/geometry`, seeded PRNG in `prng.ts`), so tests compute exact expected positions instead of faking randomness. When logic can be made pure, make it pure and test it here; `reconcile()` in the sync layer is the same move on the client.

**Seams and fakes: no real time, no real sockets.** The sync layer takes injected `Clock`, `Scheduler`, and `SocketFactory` interfaces (`apps/web/src/sync/interfaces.ts`); tests drive them with the doubles in `test-fakes.ts` (not a `.test.ts` file, so it never runs as a suite). Reconnect and backoff tests advance a fake clock and fire timers explicitly. Never test async behavior with real `setTimeout` or sleeps.

**Contract suites: one behavior spec per interface, run against every implementation.** `store/contract.test-suite.ts` runs against both `InMemoryRoomStore` and `SqliteRoomStore`, which is what makes it honest for integration tests to substitute the in-memory one. A new implementation of a shared interface plugs into the existing suite before getting tests of its own.

**In-process integration: real server, real sockets, stubbed far neighbors.** `createGameServer` boots on an ephemeral port; tests connect real `ws` clients and stub what the path under test never touches (a no-op `ImageStore` for WS tests). Async assertions use the buffering `TestClient` with `waitFor(predicate)`, so sequential awaits consume messages in order instead of racing.

**Exactly one full-stack smoke.** `apps/server/src/e2e.test.ts` wires everything the way `main.ts` does: real multipart upload, two WS clients playing a real solve, a late joiner converging. It exists so seam-only bugs have somewhere to surface. Resist adding more tests at this layer; a failure that could be expressed lower belongs lower.

**Browser tier: on demand, not in `bun run test`.** The `verify` skill (`.claude/skills/verify/SKILL.md`) drives the real app with agent-browser against an isolated stack (`scripts/e2e-env.sh`, ports 3100/3101). It is the only coverage for the PixiJS canvas actually rendering and for pointer input, and it stays manual because headless WebGL is fragile enough (documented in the skill) that automating it would spend its budget fighting the harness.

## Deliberately untested

- **`renderer.ts`** (the Pixi scene itself: sprites, atlas bake, weave/hem drawing) has no unit coverage; the browser check owns it. Its DOM-free neighbors are tested: `camera.ts` and `hit-test.ts` are pure modules with colocated tests, and `input.ts`'s gesture arbitration runs against fakes of its canvas/renderer/sync seams (`input.test.ts`). When logic grows inside the renderer, extract it into a DOM-free module and test it there, the same way `sync/` was carved out of the client.
- **React room components** (`apps/web/src/room`): thin composition over the tested sync layer; covered by the browser check only.
- **The S3 image-store round-trip** is gated on `S3_BUCKET` (`s3-image-store.integration.test.ts`); the default run unit-tests `S3ImageStore` against a fake client. The gated suite overwrites one fixed object key because its IAM credentials have no delete permission.

## Conventions

- Tests are colocated `*.test.ts` next to the module; shared doubles live in a plain `.ts` file (`test-fakes.ts`) so they never run as a suite.
- Determinism over mocking: prefer a seed or an injected clock to a mocked module.
- A "fixed" bug gets its reproducing test at the owning layer first, then the fix.
