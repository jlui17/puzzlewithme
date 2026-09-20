import { setTimeout as delay } from "node:timers/promises";
import type { RoomStore } from "./room-store.js";

/** Retry idempotent membership writes without turning a history outage into a failed join. */
export async function recordMembershipWithRetry(
  store: RoomStore,
  roomId: string,
  userId: string,
  createdByUser: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await store.recordMembership(roomId, userId, createdByUser);
      return;
    } catch (error) {
      if (attempt === 2) {
        console.error(`recording membership failed after 3 attempts for room ${roomId}`, error);
      } else {
        await delay(100 * 2 ** attempt);
      }
    }
  }
}
