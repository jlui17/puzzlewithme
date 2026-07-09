# PuzzleWithMe — Specification v1.0

## 1. Purpose

PuzzleWithMe is a browser-based cooperative jigsaw puzzle game. A player turns any image into a jigsaw puzzle and shares a link; anyone with the link joins the same live board and solves it together, seeing each other's cursors and moves in real time. A puzzle can be left and resumed indefinitely via its link.

There is nothing competitive between rooms and no accounts. The product is the shared table: the social experience of assembling a puzzle together, whether in one sitting or across weeks.

## 2. Design principles

- **Zero-friction join.** Clicking a room link puts you on the board within seconds: no account, no form, an auto-generated editable guest name.
- **Fully shared board.** Every player sees and can touch the same table. No private trays, hands, or per-player views.
- **The server is the referee.** All game-rule outcomes (who holds a piece, what snapped, what's placed) are decided by the server. Clients render and predict but never decide rules. This prevents conflicting states between players and cheating.
- **Deterministic puzzle from a seed.** Piece shapes, layout, and initial scatter derive entirely from `(image, rows, cols, seed)`. Any component that knows the seed can reproduce the full puzzle geometry independently, so per-piece data never needs to be generated, stored, or transmitted.
- **The link is the save file.** A room persists forever and any state a player caused is durable. Leaving and returning requires nothing but the URL.

## 3. Users and journeys

Two roles, differing only at creation time. The **host** creates a room; **players** (including the host) solve. The host has no special powers after creation.

### 3.1 Host creates a room
1. Host visits the site, uploads an image from their device (the only image source), and picks a piece count tier: 100 / 250 / 500 / 1000.
2. The system validates the image (type, size, minimum resolution), stores it, generates the room with a fresh seed, and returns the room's unique, unguessable link.
3. Host lands on the board and can share the link by any outside channel (no in-app invite system).

### 3.2 Player joins
1. Player opens the link, receives an auto-generated guest name (editable at any time) and a distinct cursor color, and lands on the live board.
2. If the puzzle is untouched, they see the seeded initial scatter; otherwise the board's current state, including pieces other players are holding at that moment.
3. Player count per room is capped (see NFR-3); over-capacity joiners see a "room full" message.

### 3.3 Solving
1. A player grabs a piece (or an assembled chunk), drags it, and drops it. Everyone sees the grab, the motion, and the result live.
2. Pieces snap to correct neighbors or into the frame per the rules in §4.3. Placed-piece credit accrues to a per-player score visible to all (§4.5).
3. Players pan and zoom their own viewport freely; viewports are per-player, board state is shared.

### 3.4 Leaving, returning, finishing
1. Leaving requires no action; the board state is durable. Reopening the link resumes exactly where the room left off, with the same guest identity if the same browser is used.
2. When the last piece locks, all present players see a completion moment: the full image, total elapsed active time, and per-player contribution. The completed room remains viewable forever via its link but is read-only. Playing again means creating a new room.

## 4. Functional requirements

### 4.1 Room creation
- **FR-1**: The system accepts an image upload, rejecting files that are not common image formats, exceed the size cap, or fall below the minimum resolution needed for the chosen piece count. Rejections carry a human-readable reason.
- **FR-2**: The system downscales stored images to a bounded maximum dimension, since pieces never need more resolution than a screen shows.
- **FR-3**: The host chooses one piece count tier: 100, 250, 500, or 1000. The actual grid (rows × cols) is derived from the tier and the image's aspect ratio so pieces stay roughly square; the resulting count may differ slightly from the tier.
- **FR-4**: Room settings (image, piece count) are immutable after creation.
- **FR-5**: Each room gets a unique, unguessable identifier; the room URL is the sole access credential. There is no public listing of rooms.

### 4.2 Puzzle generation
- **FR-6**: Piece shapes are classic jigsaw (interlocking tabs and blanks) with per-edge random variation, generated deterministically from the room's seed. The same seed always yields the identical puzzle.
- **FR-7**: The initial scatter places all pieces around a centered empty frame, unoverlapping enough to be individually pickable, deterministically from the seed.
- **FR-8**: The board (table area) is several times larger than the frame in each dimension, giving room to sort. The frame shows a subtle outline of where the puzzle assembles.

### 4.3 Piece manipulation and snapping
The unit of manipulation is the **group**: a set of one or more correctly-joined pieces that moves as a whole. Every piece starts as its own group.

- **FR-9**: A player grabs a group by pressing on any of its pieces. A group can be held by at most one player; a grab on a held group fails visibly ("held by X"). First grab wins.
- **FR-10**: While held, the group follows the holder's cursor and all players see its motion continuously.
- **FR-11**: On release, the system evaluates snapping: if any piece in the dropped group is within the snap tolerance of its correct offset from a piece in another group, the groups merge and align; if any piece is within tolerance of its correct frame position, the whole group locks into the frame. Both can cascade in one drop.
- **FR-12**: Locked (frame-placed) groups are immovable permanently.
- **FR-13**: Snap tolerance starts at ~15% of piece width. Chosen by feel from comparable games (tighter frustrates trackpad users, looser causes unintended snaps); must be tunable without redeploying clients.
- **FR-14**: If a player disconnects while holding a group, the group is released in place and becomes grabbable.
- **FR-15**: Groups cannot be dropped outside the board bounds; a drop beyond the edge lands the group clamped to the boundary.
- **FR-16**: No piece rotation: pieces always spawn and stay upright.

### 4.4 Presence
- **FR-17**: Each player's cursor position renders live on all other players' screens with their name label and color.
- **FR-18**: A visible player list shows who is currently in the room; joins and leaves update it immediately.
- **FR-19**: While a group is held, all players can see who is holding it.

### 4.5 Scoring
- **FR-20**: The player list shows each player's placed-piece count and percentage share, plus overall room progress (e.g. "314 / 588").
- **FR-21**: Credit rule: a piece scores exactly once, at the first snap event that connects it to anything (merge or frame lock), for the player who dropped. Chunk-internal pieces already credited never re-credit, so per-player counts always sum to the room total.
- **FR-22**: Scores are attached to the room's guest identities and persist with the room. There is no aggregation across rooms.

### 4.6 Persistence and lifecycle
- **FR-23**: All state a player caused (positions, merges, locks, scores, names) is durable; rooms never expire.
- **FR-24**: A returning player on the same browser resumes their prior guest identity and score in that room; a new browser gets a new guest identity.
- **FR-25**: A completed room is permanently read-only: viewable, not playable.

### 4.7 Board navigation
- **FR-26**: Pan and zoom are per-player and unrestricted within the board bounds, on both mouse (drag empty space, scroll to zoom) and touch (drag, pinch).
- **FR-27**: Zoom range lets a player see the whole board at once and also magnify a single piece to comfortable working size.

## 5. Non-functional requirements

- **NFR-1 (rendering performance)**: The board stays smooth (target 60 fps, floor 30) with 1000 pieces on a mid-range laptop from ~2021 and a mid-range phone.
- **NFR-2 (latency)**: One player's grab, motion, and snap results appear on other players' screens within ~200 ms on typical home connections. Motion may be interpolated; it must look continuous, not teleporting.
- **NFR-3 (room capacity)**: 20 simultaneous players per room. Chosen as generous for the social use case (a group of friends or a small team) while keeping presence broadcast fan-out trivial; raise later if demand appears.
- **NFR-4 (join time)**: From clicking a link to an interactive board in under 5 seconds on a typical connection, including image download.
- **NFR-5 (durability)**: A server crash or restart loses at most the last few seconds of piece movement; merges, locks, and scores already confirmed to players survive.
- **NFR-6 (consistency)**: All players converge to the identical board state. Momentary divergence during motion is acceptable; divergence in placements, merges, or scores is not.
- **NFR-7 (security)**: Room IDs are unguessable (link possession = access). Uploads are validated as images and size-capped. Clients are untrusted: the server rejects moves of locked groups, drops by non-holders, and malformed events.
- **NFR-8 (compatibility)**: Current versions of the major evergreen browsers, desktop and mobile. Touch works; a polished mobile experience is not a v1 goal.
- **NFR-9 (scale)**: Design for hundreds of concurrent rooms; nothing in the architecture may require all rooms to share one machine's memory.

## 6. System architecture

Five logical components. Implementation technology is the implementer's choice within the constraints below.

### 6.1 Components

1. **Web client** — everything the player sees and touches. Renders the board from local state; sends the player's intents (grab, move, drop, cursor) to the game server; applies the server's authoritative results. Predicts its own actions optimistically (the local player's drag never waits on the network) and reconciles when results differ.
2. **Game server** — the referee and the single writer of room state. Holds each active room's live state, grants/releases holds, validates every drop against the seed-derived geometry (it regenerates the same puzzle the clients do), executes merges/locks/scoring, and broadcasts results to the room. Requires a persistent bidirectional message channel with each client.
3. **Room store** — durable record of every room: settings `(image reference, grid, seed)`, current board state, scores, guest identities, completion status. The game server is its only writer.
4. **Image store** — durable storage for uploaded images, served to clients efficiently (cacheable, since a room's image never changes).
5. **Puzzle geometry module** — the deterministic seed → geometry rules (piece shapes, neighbor relations, scatter, snap positions). Not a running process but a shared capability: client and game server must both apply it and must produce bit-identical results. Divergence here breaks snapping silently, so identical behavior across both is a hard requirement (sharing one implementation is the obvious way to satisfy it).

### 6.2 Authority and data-flow rules

- Clients send **intents**, never outcomes ("I dropped group G at (x,y)", never "these groups merged").
- The game server is the only component that mutates room state; every mutation is broadcast to all clients in the room.
- Held-group motion is the one relaxed path: the server relays the holder's positions to others without evaluation, because correctness only matters at the drop.
- Ephemeral data (cursor positions, in-flight motion) is broadcast but never persisted.

### 6.3 Technology choices

Recommended stack per component. These are architecture-level picks, open to challenge by the implementer if a constraint they hit warrants it; the requirements they satisfy are not.

| Component | Pick | Why |
|---|---|---|
| Web client | Next.js + TypeScript; PixiJS (WebGL) for the board | 1000 pieces at 60 fps (NFR-1) rules out DOM and strains canvas 2D; WebGL batching handles it comfortably |
| Game server | Node + WebSockets, rooms in memory | WebSockets provide the persistent bidirectional channel §6.1.2 requires; Node lets the geometry module be one TypeScript package shared with the client, satisfying the bit-identical constraint (§6.1.5) by construction |
| Room store | Postgres | One room row + state JSON; relational is overkill-proof and familiar |
| Image store | Object storage (S3/R2) behind a CDN | Images are immutable per room, so cache-forever delivery meets NFR-4 |
| Geometry module | Shared TypeScript package used by client and server | The only structural pick: one implementation makes client/server divergence impossible rather than merely unlikely |
| Hosting | Fly.io / Railway (long-lived process) | The game server holds sockets and in-memory rooms; serverless platforms that can't hold either are ruled out |

**Alternatives considered**
- **Cloudflare Durable Objects (one object per room)** — *deferred*: elegant fit for the room model and scales to zero, but a second platform to learn; the Node server reaches playable faster and the room abstraction ports cleanly later. Satisfies NFR-9 either way (rooms are independent; nothing requires shared memory across rooms).
- **CRDT / client-authoritative sync** — *rejected*: merges and locks are game rules needing a referee (§2); CRDTs give convergence, not correctness.
- **Canvas 2D renderer** — *rejected*: fine to ~300 pieces, misses NFR-1 at 1000 on mid hardware.
- **Server-rendered piece images** — *rejected*: contradicts the seed-determinism principle (§2); a thousand images to generate, store, and ship per room versus none.

## 7. Key processes

### 7.1 Room creation
Host uploads image → system validates (FR-1), downscales (FR-2), stores it in the image store → derives grid from tier + aspect ratio, generates a seed → creates the room record → returns the room URL. No puzzle geometry is computed at creation; the seed implies all of it.

### 7.2 Join / resume
Client opens the room URL → game server loads the room from the room store if not already live in memory → client is assigned (or re-associated with, FR-24) a guest identity → server sends a full **state snapshot**: room settings, all deviations from the seeded initial layout (moved/merged/locked groups), scores, current players, currently-held groups → client fetches the image, regenerates geometry from the seed, renders, and begins consuming the live event stream. Snapshot + subsequent events must yield exactly the state every other player sees (NFR-6).

### 7.3 Grab → move → drop (the core loop)
1. Player presses on a piece → client asks the server for a hold on that group and optimistically starts dragging.
2. Server grants (first-grab-wins) or rejects (already held → client abandons the drag and shows the holder's name, FR-9).
3. While held, the client streams positions; the server relays to all others; other clients render the motion smoothly (NFR-2).
4. On release, the client reports the drop position. The server — sole authority — evaluates snapping against its own geometry (FR-11), applies merges/locks/score credit atomically, releases the hold, and broadcasts the result.
5. All clients (including the dropper, whose optimistic position may be corrected) apply the result.

### 7.4 Disconnect and hold recovery
Server detects a client's channel loss → removes the player from presence → any group they held is released at its last relayed position (FR-14) → both facts broadcast. The player's identity and score remain in the room record for their return.

### 7.5 Room dormancy and revival
Last player leaves → server flushes final state to the room store and evicts the room from memory. Next visit to the link revives it (§7.2). Active rooms checkpoint to the room store frequently enough to honor NFR-5.

### 7.6 Completion
A drop that locks the final piece → server marks the room completed in the same atomic step, broadcasts a completion event with final stats → clients show the completion moment (§3.4) → room is thereafter read-only (FR-25).

## 8. Conceptual data model

- **Room**: unguessable ID, image reference, grid dimensions, seed, status (active / completed), created time, total active solving time.
- **Piece**: implied by the seed, not stored. Identified by grid coordinate. Its shape, neighbors, correct frame position, and initial scatter position are all derivable.
- **Group**: the stored unit of board state. Set of piece coordinates, current position, held-by (transient), locked flag. Only groups deviating from the initial seeded layout need storing; an untouched room stores none.
- **Guest identity**: per-room player record: generated name (editable), cursor color, browser association for resume, placed-piece count.
- **Event stream (transient)**: grab, motion, drop-result, cursor, presence — the live traffic of §7; only its state-changing outcomes are reflected into Room/Group/Guest records.

## 9. Edge cases and failure handling

- **Two players grab simultaneously** → server ordering decides; exactly one wins, the other sees "held by X" (FR-9).
- **Player disconnects mid-drag** → hold released in place (FR-14, §7.4).
- **Player holds a group and idles indefinitely** → holds carry a generous inactivity timeout (minutes, not seconds) after which the group releases in place, so one AFK player can't freeze pieces forever. Timeout length is a tunable.
- **Server restarts mid-session** → clients reconnect automatically and resume via snapshot (§7.2); at most the last few seconds of motion are lost (NFR-5).
- **Conflicting drops near the same spot** → server processes drops serially; the second drop re-evaluates against post-first-drop state. No partial merges.
- **Client and server geometry disagree** → must be impossible by construction (§6.1.5); treat any detected divergence as a defect, not a runtime case to handle.
- **Upload failures** (wrong type, oversized, under-resolution, network) → clear inline error at the create form; no partial rooms created.
- **Room link opened while at player capacity** → "room full" message; no queueing in v1.
- **Completed room reopened** → read-only board view with the completion stats (FR-25).

## 10. Out of scope (v1)

Accounts and cross-device identity; piece rotation; chat (cursors and presence carry the social load); private trays or any per-player board state; cross-room leaderboards; edge-pieces filter; image moderation (rooms are link-private; revisit if any public discovery is added); native mobile apps; spectator mode; in-app invitations.

## 11. Decisions record

| Decision | Choice |
|---|---|
| Max piece count | 1000 (tiers 100 / 250 / 500 / 1000) |
| Image source | Upload only |
| Room lifetime | Forever; dormant rooms revive on visit |
| Board model | Fully shared; no per-player state |
| Scoring | In-room per-player placed counts; credit-once-at-first-connection rule (FR-21) |
| Rotation | None in v1 |
| Visual direction | Dark theme; tanggle.io as inspiration, intuitiveness over imitation |
| Host privileges | None after creation; settings immutable |
| Post-completion | Room permanently read-only; replay = new room |
