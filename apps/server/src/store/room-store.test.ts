import type { RoomSettings } from "@puzzlewithme/shared";
import { describe, expect, it } from "vitest";
import { runRoomStoreContractTests } from "./contract.test-suite.js";
import { InMemoryRoomStore, emptyRoomState } from "./room-store.js";

runRoomStoreContractTests("InMemoryRoomStore", () => new InMemoryRoomStore());

const settings: RoomSettings = {
  roomId: "room-1",
  imageRef: "img-1",
  rows: 2,
  cols: 2,
  seed: "store-seed",
  status: "active",
};

describe("InMemoryRoomStore", () => {
  it("create yields the empty deviation record and load returns it", async () => {
    const store = new InMemoryRoomStore();
    const created = await store.create(settings);
    expect(created).toEqual(emptyRoomState(settings));
    expect(await store.load("room-1")).toEqual(created);
  });

  it("load returns null for an unknown room", async () => {
    const store = new InMemoryRoomStore();
    expect(await store.load("nope")).toBeNull();
  });

  it("save overwrites and round-trips state", async () => {
    const store = new InMemoryRoomStore();
    await store.create(settings);
    const state = emptyRoomState(settings);
    state.creditedPieces = [0, 1];
    state.groups = [{ id: "0-1", pieces: [0, 1], position: { x: 0, y: 0 }, lockedToFrame: true }];
    await store.save("room-1", state);
    expect(await store.load("room-1")).toEqual(state);
  });

  it("isolates stored state from caller mutations", async () => {
    const store = new InMemoryRoomStore();
    const created = await store.create(settings);
    created.creditedPieces.push(99);
    const loaded = await store.load("room-1");
    expect(loaded?.creditedPieces).toEqual([]);
    loaded!.creditedPieces.push(42);
    expect((await store.load("room-1"))?.creditedPieces).toEqual([]);
  });

  it("rejects duplicate create and save of an unknown room", async () => {
    const store = new InMemoryRoomStore();
    await store.create(settings);
    await expect(store.create(settings)).rejects.toThrow(/already exists/);
    await expect(store.save("nope", emptyRoomState(settings))).rejects.toThrow(/does not exist/);
  });
});
