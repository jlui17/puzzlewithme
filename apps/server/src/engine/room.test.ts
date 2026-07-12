import { boardBounds, clampGroupToBoard, initialScatter } from "@puzzlewithme/geometry";
import type { RoomSettings } from "@puzzlewithme/shared";
import { describe, expect, it } from "vitest";
import { HOLD_TIMEOUT_MS, ROOM_CAP } from "./constants.js";
import { RoomEngine } from "./room.js";

class FakeClock {
  private t = 1_000_000;
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

// 2x2 @ "test-seed" scatter (deterministic): piece 0 (-173.8,-154.9),
// 1 (-10.9,-152.5), 2 (-175.0,166.9), 3 (147.0,-178.8); board -200..400.
// Test drop coordinates below were chosen against these so unintended snaps
// can't occur (nearest wrong-fit distance is ~90 units, tolerance is 15).
function makeSettings(overrides: Partial<RoomSettings> = {}): RoomSettings {
  return {
    roomId: "room-1",
    imageRef: "img-1",
    rows: 2,
    cols: 2,
    seed: "test-seed",
    status: "active",
    ...overrides,
  };
}

function makeEngine(overrides: Partial<RoomSettings> = {}): { engine: RoomEngine; clock: FakeClock } {
  const clock = new FakeClock();
  const engine = new RoomEngine({ settings: makeSettings(overrides), now: clock.now });
  return { engine, clock };
}

function joinOk(engine: RoomEngine, token?: string | null) {
  const result = engine.join(token);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected join to succeed");
  return result;
}

function dropOk(engine: RoomEngine, playerId: string, groupId: string, x: number, y: number) {
  const grab = engine.grab(playerId, groupId);
  expect(grab.outcome).toBe("granted");
  const result = engine.drop(playerId, groupId, x, y);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error("expected drop to succeed");
  return result;
}

describe("join", () => {
  it("assigns a generated name, a cursor color, and an empty-deviation snapshot for an untouched room", () => {
    const { engine } = makeEngine();
    const joined = joinOk(engine);
    expect(joined.resumed).toBe(false);
    expect(joined.identity.name).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+-[A-Z][0-9]{2}$/);
    expect(joined.identity.color).toMatch(/^hsl\(/);
    expect(joined.identity.placedCount).toBe(0);
    expect(joined.snapshot.groups).toEqual([]);
    expect(joined.snapshot.players).toEqual([joined.identity]);
    expect(joined.snapshot.scoreboard).toEqual({
      players: [{ guestId: joined.identity.id, placedCount: 0 }],
      progress: { placedPieces: 0, totalPieces: 4 },
    });
    expect(joined.snapshot.settings).toEqual(makeSettings());
  });

  it("gives distinct names and colors to distinct joiners", () => {
    const { engine } = makeEngine();
    const a = joinOk(engine);
    const b = joinOk(engine);
    expect(b.identity.id).not.toBe(a.identity.id);
    expect(b.identity.name).not.toBe(a.identity.name);
    expect(b.identity.color).not.toBe(a.identity.color);
  });

  it("hands out a reproducible name sequence for the same room seed", () => {
    const a = joinOk(makeEngine().engine);
    const b = joinOk(makeEngine().engine);
    expect(a.identity.name).toBe(b.identity.name);
  });

  it("rejects the 21st simultaneous player with room_full and frees the slot on leave", () => {
    const { engine } = makeEngine();
    const players = Array.from({ length: ROOM_CAP }, () => joinOk(engine));
    expect(engine.join()).toEqual({ ok: false, reason: "room_full" });
    engine.leave(players[0]!.identity.id);
    expect(engine.join().ok).toBe(true);
  });

  it("counts the cap against connected players: a full room rejects a returning (disconnected) identity too", () => {
    const { engine } = makeEngine();
    const first = joinOk(engine);
    engine.leave(first.identity.id);
    for (let i = 0; i < ROOM_CAP; i++) joinOk(engine);
    expect(engine.join(first.resumeToken)).toEqual({ ok: false, reason: "room_full" });
  });

  it("lets an already-connected identity rejoin (second tab) without consuming a slot", () => {
    const { engine } = makeEngine();
    const first = joinOk(engine);
    for (let i = 0; i < ROOM_CAP - 1; i++) joinOk(engine);
    const again = joinOk(engine, first.resumeToken);
    expect(again.identity.id).toBe(first.identity.id);
  });
});

describe("resume (FR-24)", () => {
  it("re-associates the prior identity — name and score intact — via the resume token", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    engine.rename(p1.identity.id, "Alice");
    dropOk(engine, p1.identity.id, "0-0", -160, -60);
    dropOk(engine, p1.identity.id, "0-1", -56, -57); // merges: credits 2
    engine.leave(p1.identity.id);

    const back = joinOk(engine, p1.resumeToken);
    expect(back.resumed).toBe(true);
    expect(back.identity).toEqual({ ...p1.identity, name: "Alice", placedCount: 2 });
    expect(back.resumeToken).toBe(p1.resumeToken);
  });

  it("gives a new browser (no token, or an unknown token) a fresh identity", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    const noToken = joinOk(engine, null);
    const badToken = joinOk(engine, "not-a-real-token");
    expect(noToken.resumed).toBe(false);
    expect(badToken.resumed).toBe(false);
    const ids = new Set([p1.identity.id, noToken.identity.id, badToken.identity.id]);
    expect(ids.size).toBe(3);
  });
});

describe("resume by persistent userId", () => {
  it("re-associates the prior identity by userId even when the resume token is absent", () => {
    const { engine } = makeEngine();
    const first = engine.join(null, "user-A");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    engine.rename(first.identity.id, "Alice");
    dropOk(engine, first.identity.id, "0-0", -160, -60);
    dropOk(engine, first.identity.id, "0-1", -56, -57); // credits 2
    engine.leave(first.identity.id);

    // No token this time (e.g. per-room resume token cleared), only the userId.
    const back = engine.join(null, "user-A");
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error("unreachable");
    expect(back.resumed).toBe(true);
    expect(back.identity).toEqual({ ...first.identity, name: "Alice", placedCount: 2 });
  });

  it("prefers the resume token over the userId when both resolve", () => {
    const { engine } = makeEngine();
    const a = engine.join(null, "user-A");
    const b = engine.join(null, "user-B");
    if (!a.ok || !b.ok) throw new Error("unreachable");
    // A's token with B's userId: the token wins (this browser's exact identity).
    const back = engine.join(a.resumeToken, "user-B");
    if (!back.ok) throw new Error("unreachable");
    expect(back.identity.id).toBe(a.identity.id);
  });

  it("gives a distinct userId a fresh identity", () => {
    const { engine } = makeEngine();
    const a = engine.join(null, "user-A");
    const b = engine.join(null, "user-B");
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(b.resumed).toBe(false);
    expect(b.identity.id).not.toBe(a.identity.id);
  });
});

describe("app-wide display name", () => {
  it("mints a fresh identity with the user's display name instead of a generated one", () => {
    const { engine } = makeEngine();
    const a = engine.join(null, "user-A", "Justin");
    if (!a.ok) throw new Error("unreachable");
    expect(a.identity.name).toBe("Justin");
  });

  it("syncs a resumed identity to the display name (a rename made elsewhere follows the user)", () => {
    const { engine } = makeEngine();
    const first = engine.join(null, "user-A");
    if (!first.ok) throw new Error("unreachable");
    engine.leave(first.identity.id);

    const back = engine.join(null, "user-A", "Justin");
    if (!back.ok) throw new Error("unreachable");
    expect(back.identity.id).toBe(first.identity.id);
    expect(back.identity.name).toBe("Justin");
  });

  it("keeps the generated name when no display name is supplied", () => {
    const { engine } = makeEngine();
    const a = engine.join(null, "user-A", null);
    if (!a.ok) throw new Error("unreachable");
    expect(a.identity.name).not.toBe("");
  });

  it("does not touch a completed room's frozen identities on rejoin", () => {
    const { engine } = makeEngine();
    const a = engine.join(null, "user-A");
    if (!a.ok) throw new Error("unreachable");
    // Same completing sequence as the completion suite's completeRoom().
    dropOk(engine, a.identity.id, "0-0", -160, -60);
    dropOk(engine, a.identity.id, "0-1", -56, -57);
    dropOk(engine, a.identity.id, "0-1", 2, 1);
    dropOk(engine, a.identity.id, "1-0", 1, 102);
    dropOk(engine, a.identity.id, "1-1", 101, 101);

    const back = engine.join(null, "user-A", "Justin");
    if (!back.ok) throw new Error("unreachable");
    // FR-25: a completed room is read-only, including its scoreboard names.
    expect(back.identity.name).toBe(a.identity.name);
  });

  it("rename reports the identity's userId so the caller can persist the name app-wide", () => {
    const { engine } = makeEngine();
    const withUser = engine.join(null, "user-A");
    const anonymous = engine.join(null);
    if (!withUser.ok || !anonymous.ok) throw new Error("unreachable");

    const renamed = engine.rename(withUser.identity.id, "Justin");
    if (!renamed.ok) throw new Error("unreachable");
    expect(renamed.userId).toBe("user-A");

    const anonRenamed = engine.rename(anonymous.identity.id, "Ghost");
    if (!anonRenamed.ok) throw new Error("unreachable");
    expect(anonRenamed.userId).toBeUndefined();
  });

  it("round-trips the userId association through serialize -> construct", () => {
    const { engine, clock } = makeEngine();
    const a = engine.join(null, "user-A");
    if (!a.ok) throw new Error("unreachable");
    engine.rename(a.identity.id, "Alice");
    engine.leave(a.identity.id);

    const persisted = engine.serialize();
    const revived = new RoomEngine({ settings: persisted.settings, now: clock.now, persisted });
    const back = revived.join(null, "user-A");
    if (!back.ok) throw new Error("unreachable");
    expect(back.resumed).toBe(true);
    expect(back.identity).toMatchObject({ id: a.identity.id, name: "Alice" });
  });
});

describe("grab (FR-9, FR-12)", () => {
  it("grants exactly one of two conflicting grabs; the loser learns the holder's name", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    const p2 = joinOk(engine);
    expect(engine.grab(p1.identity.id, "0-0")).toEqual({ outcome: "granted", groupId: "0-0" });
    expect(engine.grab(p2.identity.id, "0-0")).toEqual({
      outcome: "held_by",
      groupId: "0-0",
      holderId: p1.identity.id,
      holderName: p1.identity.name,
    });
  });

  it("re-grants a grab by the current holder (idempotent refresh)", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    engine.grab(p1.identity.id, "0-0");
    expect(engine.grab(p1.identity.id, "0-0").outcome).toBe("granted");
  });

  it("rejects grabs of locked groups, unknown groups, and grabs by unknown players", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    dropOk(engine, p1.identity.id, "0-0", 2, 1); // locks piece 0 into the frame
    expect(engine.grab(p1.identity.id, "0-0")).toEqual({
      outcome: "rejected",
      groupId: "0-0",
      reason: "group_locked",
    });
    expect(engine.grab(p1.identity.id, "9-9")).toEqual({
      outcome: "rejected",
      groupId: "9-9",
      reason: "unknown_group",
    });
    expect(engine.grab("nobody", "0-1")).toEqual({
      outcome: "rejected",
      groupId: "0-1",
      reason: "unknown_player",
    });
  });
});

describe("move (NFR-7)", () => {
  it("accepts moves only from the holder", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    const p2 = joinOk(engine);
    engine.grab(p1.identity.id, "0-0");
    expect(engine.move(p2.identity.id, "0-0", 10, 10)).toEqual({ ok: false, reason: "not_holder" });
    expect(engine.move(p2.identity.id, "0-1", 10, 10)).toEqual({ ok: false, reason: "not_holder" });
    expect(engine.move(p1.identity.id, "0-0", 10, 10)).toEqual({ ok: true, groupId: "0-0", x: 10, y: 10 });
  });

  it("rejects moves of locked groups", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    dropOk(engine, p1.identity.id, "0-0", 2, 1);
    expect(engine.move(p1.identity.id, "0-0", 50, 50)).toEqual({ ok: false, reason: "group_locked" });
  });

  it("rejects drops by non-holders", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    const p2 = joinOk(engine);
    engine.grab(p1.identity.id, "0-0");
    expect(engine.drop(p2.identity.id, "0-0", 10, 10)).toEqual({ ok: false, reason: "not_holder" });
  });
});

describe("drop: merge and scoring (FR-11, FR-21)", () => {
  it("merging two singles credits the dropper both pieces", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    dropOk(engine, p1.identity.id, "0-0", -160, -60); // park, no snap
    const merge = dropOk(engine, p1.identity.id, "0-1", -56, -57);
    expect(merge.result).toEqual({
      type: "snap_result",
      droppedGroupId: "0-1",
      group: {
        id: "0-1",
        pieces: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
        ],
        position: { x: -160, y: -60 },
        lockedToFrame: false,
      },
      mergedGroupIds: ["0-0"],
      scoreCredits: [{ guestId: p1.identity.id, piecesCredited: 2 }],
      progress: { placedPieces: 2, totalPieces: 4 },
    });
    expect(merge.completion).toBeNull();
  });

  it("a parking drop with no snap credits nothing and reports the new position", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    const park = dropOk(engine, p1.identity.id, "0-0", -160, -60);
    expect(park.result.mergedGroupIds).toEqual([]);
    expect(park.result.scoreCredits).toEqual([]);
    expect(park.result.group.position).toEqual({ x: -160, y: -60 });
    expect(park.result.progress).toEqual({ placedPieces: 0, totalPieces: 4 });
  });

  it("frame-dropping an already-credited chunk credits nothing (credit-once)", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    const p2 = joinOk(engine);
    dropOk(engine, p1.identity.id, "0-0", -160, -60);
    dropOk(engine, p1.identity.id, "0-1", -56, -57); // p1 credited 2

    const lock = dropOk(engine, p2.identity.id, "0-1", 2, 1); // chunk locks into frame
    expect(lock.result.group.lockedToFrame).toBe(true);
    expect(lock.result.group.position).toEqual({ x: 0, y: 0 });
    expect(lock.result.scoreCredits).toEqual([]);
    expect(lock.result.progress).toEqual({ placedPieces: 2, totalPieces: 4 });
  });

  it("merging an uncredited single into a credited chunk credits only that single, and counts sum to the total", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    const p2 = joinOk(engine);
    dropOk(engine, p1.identity.id, "0-0", -160, -60);
    dropOk(engine, p1.identity.id, "0-1", -56, -57);
    dropOk(engine, p2.identity.id, "0-1", 2, 1);
    const merge = dropOk(engine, p2.identity.id, "1-0", 1, 102); // locks next to the locked chunk
    expect(merge.result.scoreCredits).toEqual([{ guestId: p2.identity.id, piecesCredited: 1 }]);
    expect(merge.result.group.lockedToFrame).toBe(true);

    const scoreboard = engine.snapshot().scoreboard;
    const sum = scoreboard.players.reduce((acc, p) => acc + p.placedCount, 0);
    expect(sum).toBe(scoreboard.progress.placedPieces);
    expect(scoreboard.progress.placedPieces).toBe(3);
  });

  it("a stale group id (absorbed by a merge) is unknown to grab and drop", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    dropOk(engine, p1.identity.id, "0-0", -160, -60);
    dropOk(engine, p1.identity.id, "0-1", -56, -57); // "0-0" absorbed into "0-1"
    expect(engine.grab(p1.identity.id, "0-0")).toEqual({
      outcome: "rejected",
      groupId: "0-0",
      reason: "unknown_group",
    });
  });

  it("clamps an out-of-bounds drop to the board edge (FR-15)", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    const out = dropOk(engine, p1.identity.id, "1-1", 99_999, 99_999);
    const expected = clampGroupToBoard({ x: 99_999, y: 99_999 }, [3], 2, 2);
    expect(out.result.group.position).toEqual(expected);
    const bounds = boardBounds(2, 2);
    expect(expected.x).toBeLessThan(bounds.maxX);
    expect(out.result.mergedGroupIds).toEqual([]);
  });
});

describe("drop: cascade merge", () => {
  // 3x3 @ "cascade-seed": pieces 0/1/2 scatter far from the parking spots
  // below, so the only in-tolerance fits are the two intended ones.
  it("dropping a piece between two consistent chunks merges all three atomically", () => {
    const clock = new FakeClock();
    const engine = new RoomEngine({
      settings: makeSettings({ rows: 3, cols: 3, seed: "cascade-seed" }),
      now: clock.now,
    });
    const p1 = joinOk(engine);
    dropOk(engine, p1.identity.id, "0-0", -250, 450);
    dropOk(engine, p1.identity.id, "0-2", -50, 450); // 0 and 2 aren't adjacent: no snap
    const cascade = dropOk(engine, p1.identity.id, "0-1", -147, 452);
    expect(cascade.result.mergedGroupIds).toEqual(["0-0", "0-2"]);
    expect(cascade.result.group).toEqual({
      id: "0-1",
      pieces: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 0, col: 2 },
      ],
      position: { x: -250, y: 450 },
      lockedToFrame: false,
    });
    expect(cascade.result.scoreCredits).toEqual([{ guestId: p1.identity.id, piecesCredited: 3 }]);
    expect(engine.snapshot().groups).toHaveLength(1);
  });

  it("ignores groups held by another player when evaluating a snap", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    const p2 = joinOk(engine);
    dropOk(engine, p1.identity.id, "0-0", -160, -60);
    engine.grab(p2.identity.id, "0-0"); // now in p2's hand
    const drop = dropOk(engine, p1.identity.id, "0-1", -56, -57); // would merge if 0-0 were free
    expect(drop.result.mergedGroupIds).toEqual([]);
    expect(drop.result.scoreCredits).toEqual([]);
  });
});

describe("completion (§7.6, FR-25)", () => {
  function completeRoom() {
    const { engine, clock } = makeEngine();
    const p1 = joinOk(engine);
    const p2 = joinOk(engine);
    clock.advance(60_000);
    dropOk(engine, p1.identity.id, "0-0", -160, -60);
    dropOk(engine, p1.identity.id, "0-1", -56, -57); // p1 +2
    dropOk(engine, p2.identity.id, "0-1", 2, 1); // lock, +0
    dropOk(engine, p2.identity.id, "1-0", 1, 102); // p2 +1
    const last = dropOk(engine, p1.identity.id, "1-1", 101, 101); // p1 +1, completes
    return { engine, clock, p1, p2, last };
  }

  it("locking the last piece completes the room with correct stats in the same step", () => {
    const { p1, p2, last } = completeRoom();
    expect(last.result.group.lockedToFrame).toBe(true);
    expect(last.completion).toEqual({
      type: "completion",
      scoreboard: {
        players: [
          { guestId: p1.identity.id, placedCount: 3 },
          { guestId: p2.identity.id, placedCount: 1 },
        ],
        progress: { placedPieces: 4, totalPieces: 4 },
      },
      totalActiveSolvingTimeMs: 60_000,
    });
  });

  it("rejects every mutation afterwards but still accepts viewers", () => {
    const { engine, p1 } = completeRoom();
    expect(engine.snapshot().settings.status).toBe("completed");
    expect(engine.grab(p1.identity.id, "0-1")).toEqual({
      outcome: "rejected",
      groupId: "0-1",
      reason: "room_completed",
    });
    expect(engine.move(p1.identity.id, "0-1", 1, 1)).toEqual({ ok: false, reason: "room_completed" });
    expect(engine.drop(p1.identity.id, "0-1", 1, 1)).toEqual({ ok: false, reason: "room_completed" });
    expect(engine.rename(p1.identity.id, "Zoe")).toEqual({ ok: false, reason: "room_completed" });

    const viewer = engine.join();
    expect(viewer.ok).toBe(true);
    if (viewer.ok) expect(viewer.snapshot.settings.status).toBe("completed");
  });

  it("stops accruing active time after completion", () => {
    const { engine, clock } = completeRoom();
    clock.advance(500_000); // players linger on the completion screen
    expect(engine.serialize().activeSolvingTimeMs).toBe(60_000);
  });
});

describe("hold lifecycle (FR-14, §9 AFK)", () => {
  it("expires a hold idle past HOLD_TIMEOUT and makes the group grabbable again", () => {
    const { engine, clock } = makeEngine();
    const p1 = joinOk(engine);
    const p2 = joinOk(engine);
    engine.grab(p1.identity.id, "0-0");

    clock.advance(HOLD_TIMEOUT_MS - 1);
    expect(engine.expireIdleHolds()).toEqual([]);

    clock.advance(1);
    const scatter = initialScatter(2, 2, "test-seed");
    expect(engine.expireIdleHolds()).toEqual([
      { groupId: "0-0", holderId: p1.identity.id, position: scatter[0]! },
    ]);
    expect(engine.grab(p2.identity.id, "0-0").outcome).toBe("granted");
  });

  it("move refreshes the AFK timer; expiry then releases at the moved position", () => {
    const { engine, clock } = makeEngine();
    const p1 = joinOk(engine);
    engine.grab(p1.identity.id, "0-0");
    clock.advance(HOLD_TIMEOUT_MS - 1_000);
    engine.move(p1.identity.id, "0-0", -120, -80);
    clock.advance(HOLD_TIMEOUT_MS - 1_000);
    expect(engine.expireIdleHolds()).toEqual([]);
    clock.advance(1_000);
    expect(engine.expireIdleHolds()).toEqual([
      { groupId: "0-0", holderId: p1.identity.id, position: { x: -120, y: -80 } },
    ]);
  });

  it("leave releases held groups at their last moved position and keeps identity and score", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    dropOk(engine, p1.identity.id, "0-0", -160, -60);
    dropOk(engine, p1.identity.id, "0-1", -56, -57); // score 2
    engine.grab(p1.identity.id, "1-0");
    engine.move(p1.identity.id, "1-0", -100, -90);

    expect(engine.leave(p1.identity.id)).toEqual({
      left: true,
      releasedHolds: [{ groupId: "1-0", holderId: p1.identity.id, position: { x: -100, y: -90 } }],
    });

    const snapshot = engine.snapshot();
    expect(snapshot.players).toEqual([]);
    expect(snapshot.scoreboard.players).toEqual([{ guestId: p1.identity.id, placedCount: 2 }]);
    const moved = snapshot.groups.find((g) => g.id === "1-0");
    expect(moved).toMatchObject({ position: { x: -100, y: -90 }, heldBy: null });
  });

  it("a duplicate leave is a no-op", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    engine.leave(p1.identity.id);
    expect(engine.leave(p1.identity.id)).toEqual({ left: false, releasedHolds: [] });
  });

  it("snapshot shows a held-but-unmoved group with its holder, while serialize still records no deviation", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    engine.grab(p1.identity.id, "0-0");
    const scatter = initialScatter(2, 2, "test-seed");
    expect(engine.snapshot().groups).toEqual([
      {
        id: "0-0",
        pieces: [{ row: 0, col: 0 }],
        position: scatter[0]!,
        lockedToFrame: false,
        heldBy: p1.identity.id,
      },
    ]);
    expect(engine.serialize().groups).toEqual([]);
  });
});

describe("persistence (§8, NFR-5)", () => {
  it("an untouched room serializes to an empty deviation set", () => {
    const { engine } = makeEngine();
    expect(engine.serialize()).toEqual({
      settings: makeSettings(),
      groups: [],
      creditedPieces: [],
      identities: [],
      activeSolvingTimeMs: 0,
    });
  });

  it("accumulates active solving time only while someone is connected", () => {
    const { engine, clock } = makeEngine();
    const p1 = joinOk(engine);
    clock.advance(10_000);
    engine.leave(p1.identity.id);
    clock.advance(100_000); // dormant: not counted
    joinOk(engine, p1.resumeToken);
    clock.advance(5_000);
    expect(engine.serialize().activeSolvingTimeMs).toBe(15_000);
  });

  it("serialize -> construct round-trips to an identical snapshot, serialization, and resumable identities", () => {
    const { engine, clock } = makeEngine();
    const p1 = joinOk(engine);
    engine.rename(p1.identity.id, "Alice");
    const p2 = joinOk(engine);
    clock.advance(30_000);
    dropOk(engine, p1.identity.id, "0-0", -160, -60);
    dropOk(engine, p1.identity.id, "0-1", -56, -57); // merged chunk
    dropOk(engine, p2.identity.id, "1-0", -120, 250); // plain move deviation
    engine.leave(p1.identity.id);
    engine.leave(p2.identity.id);

    const persisted = engine.serialize();
    const revived = new RoomEngine({ settings: persisted.settings, now: clock.now, persisted });

    expect(revived.snapshot()).toEqual(engine.snapshot());
    expect(revived.serialize()).toEqual(persisted);

    const back = revived.join(p1.resumeToken);
    expect(back).toMatchObject({
      ok: true,
      resumed: true,
      identity: { id: p1.identity.id, name: "Alice", placedCount: 2 },
    });
  });

  it("persists merged and locked groups as deviations and skips untouched pieces", () => {
    const { engine } = makeEngine();
    const p1 = joinOk(engine);
    dropOk(engine, p1.identity.id, "0-0", -160, -60);
    dropOk(engine, p1.identity.id, "0-1", -56, -57);
    dropOk(engine, p1.identity.id, "0-1", 2, 1); // lock the chunk
    const persisted = engine.serialize();
    expect(persisted.groups).toEqual([
      { id: "0-1", pieces: [0, 1], position: { x: 0, y: 0 }, lockedToFrame: true },
    ]);
    expect(persisted.creditedPieces).toEqual([0, 1]);
    expect(persisted.identities).toHaveLength(1);
  });

  it("a revived completed room stays read-only", () => {
    const { engine, clock } = makeEngine();
    const p1 = joinOk(engine);
    dropOk(engine, p1.identity.id, "0-0", 2, 1);
    dropOk(engine, p1.identity.id, "0-1", 101, 1);
    dropOk(engine, p1.identity.id, "1-0", 1, 102);
    dropOk(engine, p1.identity.id, "1-1", 101, 101);
    engine.leave(p1.identity.id);

    const persisted = engine.serialize();
    expect(persisted.settings.status).toBe("completed");
    const revived = new RoomEngine({ settings: persisted.settings, now: clock.now, persisted });
    const viewer = joinOk(revived);
    expect(revived.grab(viewer.identity.id, "0-0")).toMatchObject({
      outcome: "rejected",
      reason: "room_completed",
    });
  });
});
