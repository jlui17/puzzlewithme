import type { RoomSettings } from "@puzzlewithme/shared";
import type { SerializedRoomState } from "../engine/types.js";

/**
 * Durable record of every room (§6.1.3); the game server is its only writer.
 * Signatures are async because the production implementation is Postgres
 * (§6.3); InMemoryRoomStore exists for tests and local dev.
 */
export interface RoomStore {
  /** Create the initial, deviation-free record for a new room (§7.1). Rejects a duplicate roomId. */
  create(settings: RoomSettings): Promise<SerializedRoomState>;
  /** A room's persisted state, or null for an unknown id (room_not_found upstream). */
  load(roomId: string): Promise<SerializedRoomState | null>;
  /** Persist a room's current state: the periodic checkpoint and the dormancy flush (§7.5, NFR-5). */
  save(roomId: string, state: SerializedRoomState): Promise<void>;
}

/** A brand-new room's state: settings and nothing else (§8: an untouched room stores no groups). */
export function emptyRoomState(settings: RoomSettings): SerializedRoomState {
  return {
    settings: { ...settings },
    groups: [],
    creditedPieces: [],
    identities: [],
    activeSolvingTimeMs: 0,
  };
}

export class InMemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, SerializedRoomState>();

  // structuredClone at every boundary so callers and the store never share
  // object graphs — mutating a loaded state must not silently mutate the
  // store, mirroring the isolation a real database gives for free.
  async create(settings: RoomSettings): Promise<SerializedRoomState> {
    if (this.rooms.has(settings.roomId)) {
      throw new Error(`room ${settings.roomId} already exists`);
    }
    const state = emptyRoomState(settings);
    this.rooms.set(settings.roomId, structuredClone(state));
    return state;
  }

  async load(roomId: string): Promise<SerializedRoomState | null> {
    const state = this.rooms.get(roomId);
    return state === undefined ? null : structuredClone(state);
  }

  async save(roomId: string, state: SerializedRoomState): Promise<void> {
    if (!this.rooms.has(roomId)) {
      throw new Error(`room ${roomId} does not exist`);
    }
    this.rooms.set(roomId, structuredClone(state));
  }
}
