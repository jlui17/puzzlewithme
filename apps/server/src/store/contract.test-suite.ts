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

  describe(`${storeName} (session history)`, () => {
    it("lists a user's created and joined rooms with progress, status, and creator flag", async () => {
      const store = getStore();
      const userId = `user-${randomUUID()}`;
      const created = settingsFor(randomUUID()); // rows 3 x cols 4 -> 12 pieces
      const joined = settingsFor(randomUUID());
      await store.create(created);
      await store.create(joined);
      await store.recordMembership(created.roomId, userId, true);
      await store.recordMembership(joined.roomId, userId, false);

      // Deviated state on `joined` so placedPieces reflects credited pieces.
      await store.save(joined.roomId, { ...emptyRoomState(joined), creditedPieces: [0, 1, 2] });

      const rooms = await store.listUserRooms(userId);
      expect(rooms).toHaveLength(2);
      const byId = new Map(rooms.map((r) => [r.roomId, r]));

      const c = byId.get(created.roomId);
      expect(c).toMatchObject({ createdByUser: true, status: "active", placedPieces: 0, totalPieces: 12 });
      expect(typeof c?.createdAt).toBe("string");
      expect(typeof c?.lastActiveAt).toBe("string");

      const j = byId.get(joined.roomId);
      expect(j).toMatchObject({ createdByUser: false, placedPieces: 3, totalPieces: 12 });
    });

    it("keeps createdByUser sticky when a creator later rejoins as a participant", async () => {
      const store = getStore();
      const userId = `user-${randomUUID()}`;
      const settings = settingsFor(randomUUID());
      await store.create(settings);
      await store.recordMembership(settings.roomId, userId, true);
      await store.recordMembership(settings.roomId, userId, false); // rejoin
      const rooms = await store.listUserRooms(userId);
      expect(rooms).toHaveLength(1);
      expect(rooms[0]?.createdByUser).toBe(true);
    });

    it("is idempotent per (room, user): a repeated join does not duplicate the listing", async () => {
      const store = getStore();
      const userId = `user-${randomUUID()}`;
      const settings = settingsFor(randomUUID());
      await store.create(settings);
      await store.recordMembership(settings.roomId, userId, false);
      await store.recordMembership(settings.roomId, userId, false);
      expect(await store.listUserRooms(userId)).toHaveLength(1);
    });

    it("returns an empty list for a user with no rooms", async () => {
      const store = getStore();
      expect(await store.listUserRooms(`user-${randomUUID()}`)).toEqual([]);
    });
  });

  describe(`${storeName} (display names)`, () => {
    it("returns null for a user who never set a name", async () => {
      const store = getStore();
      expect(await store.getUserDisplayName(`user-${randomUUID()}`)).toBeNull();
    });

    it("round-trips a set name and overwrites it on a later set", async () => {
      const store = getStore();
      const userId = `user-${randomUUID()}`;
      await store.setUserDisplayName(userId, "Justin");
      expect(await store.getUserDisplayName(userId)).toBe("Justin");
      await store.setUserDisplayName(userId, "J2");
      expect(await store.getUserDisplayName(userId)).toBe("J2");
    });

    it("keeps names independent per user", async () => {
      const store = getStore();
      const a = `user-${randomUUID()}`;
      const b = `user-${randomUUID()}`;
      await store.setUserDisplayName(a, "Alice");
      await store.setUserDisplayName(b, "Bob");
      expect(await store.getUserDisplayName(a)).toBe("Alice");
      expect(await store.getUserDisplayName(b)).toBe("Bob");
    });
  });
}
