import { randomUUID } from "node:crypto";
import {
  DEFAULT_SNAP_TOLERANCE,
  clampGroupToBoard,
  evaluateSnap,
  initialScatter,
  pieceIdToCoord,
  type GroupState,
  type Vec2,
} from "@puzzlewithme/geometry";
import {
  singletonGroupId,
  type CompletionMessage,
  type Group,
  type GuestIdentity,
  type RoomSettings,
  type Scoreboard,
  type SnapResultMessage,
  type SnapshotMessage,
} from "@puzzlewithme/shared";
import { HOLD_TIMEOUT_MS, ROOM_CAP } from "./constants.js";
import { assignCursorColor, createNameGenerator } from "./names.js";
import type {
  DropResult,
  GrabResult,
  JoinResult,
  LeaveResult,
  MoveResult,
  MutationRejected,
  ReleasedHold,
  RenameResult,
  RoomDeviations,
  SerializedGroup,
  SerializedRoomState,
} from "./types.js";

interface Hold {
  holderId: string;
  /** Refreshed by grab and move; expireIdleHolds compares against it (§9). */
  lastActivityAt: number;
}

interface IdentityRecord extends GuestIdentity {
  resumeToken: string;
}

export interface RoomEngineOptions {
  settings: RoomSettings;
  /**
   * Injected clock. The engine never reads Date.now() itself, so tests and
   * the AFK sweep fully control time.
   */
  now: () => number;
  /** Persisted deviation record from the room store; omit for a fresh room (§8). */
  persisted?: RoomDeviations;
  /** Snap tolerance override (FR-13 requires server-side tunability without redeploying clients). */
  snapTolerance?: number;
}

/**
 * One room's authoritative state: the referee (§2, §6.1.2). Transport-free —
 * inputs are method calls, outputs are plain result objects (see types.ts)
 * the network layer turns into broadcasts. No timers, no sockets, no
 * Date.now(); the only non-determinism is crypto randomness for guest ids and
 * resume tokens, which must be unguessable (the token is the resume
 * credential, FR-24).
 */
export class RoomEngine {
  private readonly settings: RoomSettings;
  private readonly now: () => number;
  private readonly snapTolerance: number;
  private readonly totalPieces: number;
  /** Seeded scatter positions by piece id — the baseline deviations are measured against (§8). */
  private readonly scatter: Vec2[];
  private readonly groups = new Map<string, GroupState>();
  private readonly holds = new Map<string, Hold>();
  /** Insertion order is join order; snapshot/serialize iterate it, keeping output stable across a persistence round-trip (NFR-5). */
  private readonly identities = new Map<string, IdentityRecord>();
  private readonly tokenToGuest = new Map<string, string>();
  private readonly connected = new Set<string>();
  private readonly credited = new Set<number>();
  private activeMs: number;
  /** Wall-clock start of the current active stretch, or null while the room is empty or completed. */
  private activeSince: number | null = null;
  private readonly nextName: (taken: ReadonlySet<string>) => string;

  constructor(options: RoomEngineOptions) {
    this.settings = { ...options.settings };
    this.now = options.now;
    this.snapTolerance = options.snapTolerance ?? DEFAULT_SNAP_TOLERANCE;
    const { rows, cols, seed } = this.settings;
    this.totalPieces = rows * cols;
    this.scatter = initialScatter(rows, cols, seed);
    this.nextName = createNameGenerator(seed);

    // Untouched baseline: every piece is its own group at its seeded scatter
    // position (§8: pieces are implied by the seed, not stored).
    for (let id = 0; id < this.totalPieces; id++) {
      const { row, col } = pieceIdToCoord(id, cols);
      const groupId = singletonGroupId(row, col);
      this.groups.set(groupId, {
        id: groupId,
        pieces: [id],
        position: { ...this.scatter[id]! },
        locked: false,
      });
    }

    const persisted = options.persisted;
    this.activeMs = persisted?.activeSolvingTimeMs ?? 0;
    if (persisted !== undefined) {
      for (const g of persisted.groups) {
        for (const piece of g.pieces) {
          const { row, col } = pieceIdToCoord(piece, cols);
          this.groups.delete(singletonGroupId(row, col));
        }
        this.groups.set(g.id, {
          id: g.id,
          pieces: [...g.pieces].sort((a, b) => a - b),
          position: { ...g.position },
          locked: g.lockedToFrame,
        });
      }
      for (const piece of persisted.creditedPieces) this.credited.add(piece);
      for (const identity of persisted.identities) {
        this.identities.set(identity.id, { ...identity });
        this.tokenToGuest.set(identity.resumeToken, identity.id);
      }
    }
  }

  /**
   * Join or resume (§7.2, FR-24). A valid resume token re-associates the
   * prior identity (name and score intact); anything else mints a fresh
   * identity. Completed rooms accept joins — they're viewable forever
   * (FR-25) — but no longer accrue solving time.
   */
  join(resumeToken?: string | null): JoinResult {
    const resumedId = resumeToken != null ? this.tokenToGuest.get(resumeToken) : undefined;
    const existing = resumedId !== undefined ? this.identities.get(resumedId) : undefined;

    // The cap counts connected players (NFR-3); a second tab resuming an
    // already-connected identity doesn't consume a slot.
    const needsSlot = existing === undefined || !this.connected.has(existing.id);
    if (needsSlot && this.connected.size >= ROOM_CAP) {
      return { ok: false, reason: "room_full" };
    }

    let record: IdentityRecord;
    if (existing !== undefined) {
      record = existing;
    } else {
      const takenNames = new Set<string>();
      const usedColors = new Set<string>();
      for (const identity of this.identities.values()) {
        takenNames.add(identity.name);
        usedColors.add(identity.color);
      }
      record = {
        id: randomUUID(),
        name: this.nextName(takenNames),
        color: assignCursorColor(usedColors, this.identities.size),
        placedCount: 0,
        resumeToken: randomUUID(),
      };
      this.identities.set(record.id, record);
      this.tokenToGuest.set(record.resumeToken, record.id);
    }

    this.connected.add(record.id);
    if (this.connected.size === 1 && this.settings.status === "active" && this.activeSince === null) {
      this.activeSince = this.now();
    }

    return {
      ok: true,
      identity: this.publicIdentity(record),
      resumeToken: record.resumeToken,
      resumed: existing !== undefined,
      snapshot: this.snapshot(),
    };
  }

  rename(playerId: string, name: string): RenameResult {
    if (this.settings.status === "completed") return { ok: false, reason: "room_completed" };
    const record = this.identities.get(playerId);
    if (record === undefined) return { ok: false, reason: "unknown_player" };
    record.name = name;
    return { ok: true, guestId: playerId, name };
  }

  /**
   * Disconnect (§7.4): releases the player's holds at the groups' last moved
   * positions (FR-14) and removes them from presence. Identity and score stay
   * in the room record for their return (FR-24).
   */
  leave(playerId: string): LeaveResult {
    if (!this.connected.has(playerId)) return { left: false, releasedHolds: [] };
    this.connected.delete(playerId);
    const releasedHolds = this.releaseHoldsWhere((hold) => hold.holderId === playerId);
    if (this.connected.size === 0) this.flushActiveTime();
    return { left: true, releasedHolds };
  }

  /** First grab wins (FR-9); locked groups are ungrabbable (FR-12). */
  grab(playerId: string, groupId: string): GrabResult {
    if (this.settings.status === "completed") {
      return { outcome: "rejected", groupId, reason: "room_completed" };
    }
    if (!this.connected.has(playerId)) {
      return { outcome: "rejected", groupId, reason: "unknown_player" };
    }
    const group = this.groups.get(groupId);
    if (group === undefined) return { outcome: "rejected", groupId, reason: "unknown_group" };
    if (group.locked) return { outcome: "rejected", groupId, reason: "group_locked" };
    const hold = this.holds.get(groupId);
    if (hold !== undefined && hold.holderId !== playerId) {
      const holder = this.identities.get(hold.holderId);
      return {
        outcome: "held_by",
        groupId,
        holderId: hold.holderId,
        holderName: holder?.name ?? "unknown",
      };
    }
    this.holds.set(groupId, { holderId: playerId, lastActivityAt: this.now() });
    return { outcome: "granted", groupId };
  }

  /**
   * Relayed holder motion (§6.2's relaxed path). Only the holder may move a
   * group (NFR-7); the position is recorded so a disconnect releases the
   * group where it was last seen (FR-14), and the hold's AFK timer refreshes.
   */
  move(playerId: string, groupId: string, x: number, y: number): MoveResult {
    const rejection = this.checkHolderMutation(playerId, groupId);
    if (rejection !== null) return rejection;
    const group = this.groups.get(groupId)!;
    group.position = { x, y };
    this.holds.get(groupId)!.lastActivityAt = this.now();
    return { ok: true, groupId, x, y };
  }

  /**
   * The authoritative drop evaluation (§7.3 step 4): clamp to the board
   * (FR-15), snap against the seed-derived geometry (FR-11), apply
   * merges/locks/credit atomically, release the hold, and detect completion
   * in the same step (§7.6).
   */
  drop(playerId: string, groupId: string, x: number, y: number): DropResult {
    const rejection = this.checkHolderMutation(playerId, groupId);
    if (rejection !== null) return rejection;
    const { rows, cols } = this.settings;
    const dropped = this.groups.get(groupId)!;

    // FR-15 first: a drop beyond the edge lands at the boundary, and snapping
    // is evaluated where the group actually lands.
    const position = clampGroupToBoard({ x, y }, dropped.pieces, rows, cols);

    // Groups in a player's hand are mid-drag, not "on the table": snapping
    // onto one would merge with a position its holder is about to change and
    // yank it out of their drag, so held groups (other than the one being
    // dropped) are invisible to the evaluation.
    const visible: GroupState[] = [];
    for (const group of this.sortedGroups()) {
      if (group.id !== groupId && this.holds.has(group.id)) continue;
      visible.push(group);
    }

    const outcome = evaluateSnap(rows, cols, visible, { groupId, position }, this.snapTolerance);

    for (const mergedId of outcome.mergedGroupIds) this.groups.delete(mergedId);
    this.groups.set(groupId, outcome.group);
    this.holds.delete(groupId);

    // FR-21 credit-once: geometry reports every piece involved in the snap;
    // the dropper is credited only for those never credited before, so
    // per-player counts always sum to the room total.
    let creditedCount = 0;
    if (outcome.events.length > 0) {
      for (const piece of outcome.connectedPieces) {
        if (this.credited.has(piece)) continue;
        this.credited.add(piece);
        creditedCount += 1;
      }
      if (creditedCount > 0) this.identities.get(playerId)!.placedCount += creditedCount;
    }

    // Groups always partition all pieces, so "every group locked" is exactly
    // "every piece placed" (§7.6).
    let completion: CompletionMessage | null = null;
    if (outcome.locked && this.allGroupsLocked()) {
      this.flushActiveTime();
      this.settings.status = "completed";
      completion = {
        type: "completion",
        scoreboard: this.scoreboard(),
        totalActiveSolvingTimeMs: this.activeMs,
      };
    }

    const result: SnapResultMessage = {
      type: "snap_result",
      droppedGroupId: groupId,
      group: {
        id: outcome.group.id,
        pieces: outcome.group.pieces.map((p) => pieceIdToCoord(p, cols)),
        position: { ...outcome.group.position },
        lockedToFrame: outcome.group.locked,
      },
      mergedGroupIds: outcome.mergedGroupIds,
      scoreCredits:
        creditedCount > 0 ? [{ guestId: playerId, piecesCredited: creditedCount }] : [],
      progress: this.progress(),
    };
    return { ok: true, result, completion };
  }

  /** Release holds idle past HOLD_TIMEOUT_MS (§9's AFK case). Run from a periodic sweep by the network layer. */
  expireIdleHolds(nowMs: number = this.now()): ReleasedHold[] {
    return this.releaseHoldsWhere((hold) => nowMs - hold.lastActivityAt >= HOLD_TIMEOUT_MS);
  }

  /**
   * The §7.2 join snapshot: deviated groups plus currently-held ones (a hold
   * is worth showing even before its group moves), connected players, scores.
   */
  snapshot(): SnapshotMessage {
    const groups: Group[] = [];
    for (const group of this.sortedGroups()) {
      const heldBy = this.holds.get(group.id)?.holderId ?? null;
      if (heldBy === null && !this.isDeviated(group)) continue;
      groups.push({
        id: group.id,
        pieces: group.pieces.map((p) => pieceIdToCoord(p, this.settings.cols)),
        position: { ...group.position },
        lockedToFrame: group.locked,
        heldBy,
      });
    }
    const players: GuestIdentity[] = [];
    for (const record of this.identities.values()) {
      if (this.connected.has(record.id)) players.push(this.publicIdentity(record));
    }
    return {
      type: "snapshot",
      settings: { ...this.settings },
      groups,
      scoreboard: this.scoreboard(),
      players,
    };
  }

  /** The persistable deviation record (§8, NFR-5). Holds are transient and omitted; positions include any mid-hold motion so far. */
  serialize(): SerializedRoomState {
    const groups: SerializedGroup[] = [];
    for (const group of this.sortedGroups()) {
      if (!this.isDeviated(group)) continue;
      groups.push({
        id: group.id,
        pieces: [...group.pieces],
        position: { ...group.position },
        lockedToFrame: group.locked,
      });
    }
    return {
      settings: { ...this.settings },
      groups,
      creditedPieces: [...this.credited].sort((a, b) => a - b),
      identities: [...this.identities.values()].map((record) => ({ ...record })),
      activeSolvingTimeMs:
        this.activeMs + (this.activeSince !== null ? this.now() - this.activeSince : 0),
    };
  }

  private checkHolderMutation(playerId: string, groupId: string): MutationRejected | null {
    if (this.settings.status === "completed") return { ok: false, reason: "room_completed" };
    if (!this.connected.has(playerId)) return { ok: false, reason: "unknown_player" };
    const group = this.groups.get(groupId);
    if (group === undefined) return { ok: false, reason: "unknown_group" };
    if (group.locked) return { ok: false, reason: "group_locked" };
    const hold = this.holds.get(groupId);
    if (hold === undefined || hold.holderId !== playerId) return { ok: false, reason: "not_holder" };
    return null;
  }

  private releaseHoldsWhere(predicate: (hold: Hold) => boolean): ReleasedHold[] {
    const released: ReleasedHold[] = [];
    for (const [groupId, hold] of this.holds) {
      if (!predicate(hold)) continue;
      this.holds.delete(groupId);
      const group = this.groups.get(groupId)!;
      released.push({ groupId, holderId: hold.holderId, position: { ...group.position } });
    }
    return released;
  }

  private flushActiveTime(): void {
    if (this.activeSince !== null) {
      this.activeMs += this.now() - this.activeSince;
      this.activeSince = null;
    }
  }

  private allGroupsLocked(): boolean {
    for (const group of this.groups.values()) {
      if (!group.locked) return false;
    }
    return true;
  }

  /**
   * A group deviates from the seeded layout when it merged, locked, or moved
   * off its scatter position; only those are transmitted and persisted (§8).
   */
  private isDeviated(group: GroupState): boolean {
    if (group.pieces.length > 1 || group.locked) return true;
    const seeded = this.scatter[group.pieces[0]!]!;
    return group.position.x !== seeded.x || group.position.y !== seeded.y;
  }

  /** Stable id order so snapshot/serialize output never depends on Map insertion history (NFR-6). */
  private sortedGroups(): GroupState[] {
    return [...this.groups.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private publicIdentity(record: IdentityRecord): GuestIdentity {
    return {
      id: record.id,
      name: record.name,
      color: record.color,
      placedCount: record.placedCount,
    };
  }

  private scoreboard(): Scoreboard {
    return {
      players: [...this.identities.values()].map((record) => ({
        guestId: record.id,
        placedCount: record.placedCount,
      })),
      progress: this.progress(),
    };
  }

  private progress(): Scoreboard["progress"] {
    return { placedPieces: this.credited.size, totalPieces: this.totalPieces };
  }
}
