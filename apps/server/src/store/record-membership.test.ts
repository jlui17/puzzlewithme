import { afterEach, expect, it, vi } from "vitest";
import { InMemoryRoomStore } from "./room-store.js";
import { recordMembershipWithRetry } from "./record-membership.js";

// Fake the delay seam, not real time; retries retain their requested backoff.
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));
import { setTimeout as delay } from "node:timers/promises";

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each([false, true])("recovers a transient failure and preserves creator=%s without duplicates", async (createdByUser) => {
  const store = new InMemoryRoomStore();
  await store.create({ roomId: "room", imageRef: "image", rows: 2, cols: 2, seed: "seed", status: "active" });
  const write = vi.spyOn(store, "recordMembership").mockRejectedValueOnce(new Error("busy"));
  await recordMembershipWithRetry(store, "room", "user", createdByUser);
  await recordMembershipWithRetry(store, "room", "user", false);
  expect(write).toHaveBeenCalledTimes(3);
  expect(delay).toHaveBeenCalledExactlyOnceWith(100);
  expect(await store.listUserRooms("user")).toEqual([expect.objectContaining({ roomId: "room", createdByUser })]);
});

it("stops after three failed writes and lets play continue", async () => {
  const store = new InMemoryRoomStore();
  const write = vi.spyOn(store, "recordMembership").mockRejectedValue(new Error("unavailable"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(recordMembershipWithRetry(store, "room", "user", false)).resolves.toBeUndefined();
  expect(write).toHaveBeenCalledTimes(3);
  expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
  expect(log).toHaveBeenCalledTimes(1);
});

it("does not delay or retry a successful write", async () => {
  const store = new InMemoryRoomStore();
  const write = vi.spyOn(store, "recordMembership");
  await recordMembershipWithRetry(store, "room", "user", false);
  expect(write).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
});
