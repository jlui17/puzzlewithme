# puzzlewithme

Multiplayer jigsaw puzzle: a Next.js web client with a PixiJS board, a Bun
server holding authoritative room state over WebSockets, and shared geometry.

## Language

**Theme**:
One of the window seat's two lights: "Rainy evening" (`evening`, the default)
or "Overcast morning" (`morning`). Each is a Pixi board palette in theme.ts and
a matching `[data-theme]` CSS block in globals.css; these are the sole palette
home. The id is not a boolean: there is no `night`/`day` flag.
_Avoid_: palette (for the whole look), skin, mode, day/night

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

**Table**:
The wooden plane every screen sits on, tilted about its far edge under a
perspective view. It is CSS only (`Table`): the board's transparent Pixi canvas
lies on it and tilts with it, and the board drives the tilt through a
`TableHandle`. Nothing in the board draws a table.
_Avoid_: slab, world layer
