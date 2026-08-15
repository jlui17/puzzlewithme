# puzzlewithme

Multiplayer jigsaw puzzle: a Next.js web client with a PixiJS board, a Bun
server holding authoritative room state over WebSockets, and shared geometry.

## Language

**Theme**:
A named look for the whole café scene — board colors, wood, prop colors, and a
matching CSS block in globals.css. The sole palette home; `night: boolean` is
not a theme selector.
_Avoid_: palette (for the whole look), skin, mode

**WorldLayer**:
A themed layer of the board's camera viewport (the table slab, the props) with
a uniform shape, so a theme change swaps any layer the same way.
_Avoid_: prop layer, decoration

**Reconciliation**:
The plan for one server message — which board mutations apply, what the local
drag becomes, what surfaces to the UI — decided purely by reconcile() from the
message and the drag in flight. The local drag leads its own group; the server
wins everything else.
_Avoid_: message handling, merge

**RoomSession**:
A joined player's handle on their room, returned by the registry's join: the
proof the handshake completed. Intents flow through it; holding one replaces
nullable roomId/playerId state.
_Avoid_: connection state, joined flag

**Effect**:
What one intent does to a room, declaratively: who gets which messages, and
how the mutation persists. One executor applies every Effect, so fan-out
policy lives in one place.
_Avoid_: broadcast logic, side effects (plural, vague)

**Source**:
What the next puzzle is made from: a fresh upload or an already-uploaded
gallery image. One value; the two picks are mutually exclusive by type.
_Avoid_: file + galleryPick (as separate state)

**Mat**:
The linen cloth the puzzle is laid out on, drawn over the table.

**Table**:
The walnut café table under everything. Exists twice on purpose: a CSS backdrop
behind the transparent canvas and a Pixi slab inside the board world.
