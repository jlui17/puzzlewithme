/**
 * Room player cap (NFR-3): 20 simultaneous players, "generous for the social
 * use case (a group of friends or a small team) while keeping presence
 * broadcast fan-out trivial; raise later if demand appears." The cap counts
 * connected players; disconnected identities persist (FR-24) and don't hold a
 * slot.
 */
export const ROOM_CAP = 20;

/**
 * Idle-hold timeout (SPEC §9: "holds carry a generous inactivity timeout —
 * minutes, not seconds"). 3 minutes: long enough that a player studying the
 * board mid-hold or answering a doorbell isn't interrupted, short enough that
 * an AFK holder can't freeze a piece for a whole session. Guessed against the
 * spec's "minutes, not seconds" guidance, not measured; §9 requires it be a
 * tunable, which it is (expireIdleHolds compares against this one constant).
 */
export const HOLD_TIMEOUT_MS = 3 * 60_000;

/**
 * Salt for the guest-name RNG stream (see geometry's createRng). Keeps the
 * name stream decorrelated from the geometry package's PUZZLE_SALT/SCATTER_SALT
 * streams so drawing names can never shift puzzle geometry. Value is arbitrary
 * but must stay stable only within one process lifetime — names are persisted,
 * never re-derived — so changing it is safe, unlike the geometry salts.
 */
export const NAME_SALT = 0xc2b2ae35;
