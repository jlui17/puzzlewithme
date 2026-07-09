import { randomUUID } from "node:crypto";
import type { RoomSettings } from "@puzzlewithme/shared";
import { describe, expect, it } from "vitest";
import type { SerializedRoomState } from "../engine/types.js";
import { emptyRoomState, type RoomStore } from "./room-store.js";

/**
 * The RoomStore interface contract, exercised identically against every
 * implementation (InMemoryRoomStore always, PostgresRoomStore when
 * DATABASE_URL is set — see room-store.test.ts / postgres-room-store.test.ts).
 * Named *.test-suite.ts, not *.test.ts, so vitest's `src/**\/*.test.ts` glob
 * never collects it directly — it only runs when a real *.test.ts imports
 * and calls it.
 *
 * `getStore` is a thunk rather than an instance because Postgres needs an
 * async beforeAll (connect + migrate) to finish before the store exists;
 * InMemoryRoomStore just closes over an already-built instance.
 *
 * Every test mints its own roomId (randomUUID) so runs against a persistent
 * backend (Postgres) never collide with leftover rows from a prior run,
 * without needing shared setup/teardown to truncate the table.
 */
export function runRoomStoreContractTests(storeName: string, getStore: () => RoomStore): void {
  function settingsFor(roomId: string, overrides: Partial<RoomSettings> = {}): RoomSettings {
    return {
      roomId,
      imageRef: `img-${roomId}`,
      rows: 3,
      cols: 4,
      seed: "contract-seed",
      status: "active",
      ...overrides,
    };
  }

  describe(`${storeName} (RoomStore contract)`, () => {
    it("create returns the empty deviation record and load round-trips it", async () => {
      const store = getStore();
      const settings = settingsFor(randomUUID());
      const created = await store.create(settings);
      expect(created).toEqual(emptyRoomState(settings));
      expect(await store.load(settings.roomId)).toEqual(created);
    });

    it("load returns null for an unknown room", async () => {
      const store = getStore();
      expect(await store.load(`unknown-${randomUUID()}`)).toBeNull();
    });

    it("save overwrites and round-trips deviated state", async () => {
      const store = getStore();
      const settings = settingsFor(randomUUID());
      await store.create(settings);

      const state: SerializedRoomState = {
        settings,
        groups: [{ id: "0-1", pieces: [0, 1], position: { x: 12.5, y: -4 }, lockedToFrame: true }],
        creditedPieces: [0, 1],
        identities: [{ id: "p1", name: "Guest", color: "#ff0000", placedCount: 2, resumeToken: "tok-1" }],
        activeSolvingTimeMs: 42_000,
      };
      await store.save(settings.roomId, state);
      expect(await store.load(settings.roomId)).toEqual(state);
    });

    it("save persists an updated status (e.g. completion)", async () => {
      const store = getStore();
      const settings = settingsFor(randomUUID());
      await store.create(settings);
      const completed: SerializedRoomState = {
        ...emptyRoomState(settings),
        settings: { ...settings, status: "completed" },
      };
      await store.save(settings.roomId, completed);
      expect(await store.load(settings.roomId)).toEqual(completed);
    });

    it("rejects duplicate create and save of an unknown room", async () => {
      const store = getStore();
      const settings = settingsFor(randomUUID());
      await store.create(settings);
      await expect(store.create(settings)).rejects.toThrow(/already exists/);
      await expect(
        store.save(`unknown-${randomUUID()}`, emptyRoomState(settings)),
      ).rejects.toThrow(/does not exist/);
    });
  });
}
