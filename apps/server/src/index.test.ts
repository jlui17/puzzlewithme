import type { RoomSettings } from "@puzzlewithme/shared";
import { describe, expect, it } from "vitest";
import { InMemoryRoomStore, RoomEngine } from "./index.js";

// End-to-end over the public barrel: the §7.5 dormancy/revival cycle —
// create in the store, play, flush, evict, revive from the store.
describe("engine + store lifecycle", () => {
  it("revives a room from persisted state with identical board state", async () => {
    const settings: RoomSettings = {
      roomId: "room-life",
      imageRef: "img-1",
      rows: 2,
      cols: 2,
      seed: "test-seed",
      status: "active",
    };
    let t = 0;
    const now = (): number => t;

    const store = new InMemoryRoomStore();
    await store.create(settings);

    const initial = await store.load(settings.roomId);
    const engine = new RoomEngine({ settings: initial!.settings, now, persisted: initial! });
    const joined = engine.join();
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error("unreachable");
    const playerId = joined.identity.id;

    engine.grab(playerId, "0-0");
    t += 1_000;
    engine.move(playerId, "0-0", -160, -60);
    const drop = engine.drop(playerId, "0-0", -160, -60);
    expect(drop.ok).toBe(true);
    engine.leave(playerId);

    await store.save(settings.roomId, engine.serialize());

    const persisted = await store.load(settings.roomId);
    const revived = new RoomEngine({ settings: persisted!.settings, now, persisted: persisted! });
    expect(revived.snapshot()).toEqual(engine.snapshot());
    expect(revived.serialize()).toEqual(engine.serialize());
  });
});
