/**
 * Board state store (deliverable 1): builds the full board from RoomSettings
 * (seed → geometry scatter for untouched groups) overlaid with a snapshot's
 * deviations, then applies the live event stream. Renderer-agnostic plain data
 * behind subscribe/notify. It never runs snap or scatter *rules* on events: a
 * snap_result is applied verbatim (§6.1.5 keeps snap logic server-only), and
 * the only geometry it calls is the deterministic seed→scatter derivation both
 * sides agree on.
 */
import { initialScatter, pieceIdToCoord } from "@puzzlewithme/geometry";
import {
  singletonGroupId,
  type Group,
  type GroupHeldMessage,
  type GroupMovedMessage,
  type GroupReleasedMessage,
  type CompletionMessage,
  type CursorBroadcastMessage,
  type PresenceMessage,
  type RoomSettings,
  type ScoreCredit,
  type SnapResultMessage,
  type SnapshotMessage,
} from "@puzzlewithme/shared";
import type { Clock } from "./interfaces";
import type { BoardState, RenderGroup } from "./state";

type Listener = (state: BoardState) => void;

function initialState(): BoardState {
  return {
    connection: "idle",
    status: "active",
    settings: null,
    localGuestId: null,
    groups: new Map(),
    players: new Map(),
    scoreboard: { players: [], progress: { placedPieces: 0, totalPieces: 0 } },
    cursors: new Map(),
    motion: new Map(),
    cursorMotion: new Map(),
    completion: null,
  };
}

function toRenderGroup(g: Group): RenderGroup {
  return {
    id: g.id,
    pieces: g.pieces.map((p) => ({ row: p.row, col: p.col })),
    position: { x: g.position.x, y: g.position.y },
    locked: g.lockedToFrame,
    heldBy: g.heldBy,
  };
}

export class BoardStore {
  private state: BoardState = initialState();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly clock: Clock) {}

  getState(): BoardState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  setConnection(status: BoardState["connection"]): void {
    this.state.connection = status;
    this.notify();
  }

  setLocalIdentity(guestId: string): void {
    this.state.localGuestId = guestId;
    this.notify();
  }

  /**
   * Replace (not merge) the whole board from a snapshot (§7.2). Rebuilding the
   * groups map from scratch each time is what makes reconnect safe: a second
   * snapshot can never duplicate groups (NFR-6). Untouched pieces start as
   * singleton groups at their seeded scatter position; each snapshot group
   * removes the singletons for its pieces and takes their place.
   */
  applySnapshot(msg: SnapshotMessage): void {
    const { settings } = msg;
    const groups = this.buildInitialGroups(settings);
    for (const g of msg.groups) {
      for (const p of g.pieces) groups.delete(singletonGroupId(p.row, p.col));
      groups.set(g.id, toRenderGroup(g));
    }

    this.state.settings = settings;
    this.state.status = settings.status;
    this.state.groups = groups;
    this.state.players = new Map(msg.players.map((p) => [p.id, { ...p }]));
    this.state.scoreboard = {
      players: msg.scoreboard.players.map((p) => ({ ...p })),
      progress: { ...msg.scoreboard.progress },
    };
    // Cursors and motion are ephemeral (§6.2) and re-broadcast after resync;
    // dropping them avoids showing stale positions after a reconnect gap.
    this.state.cursors = new Map();
    this.state.motion = new Map();
    this.state.cursorMotion = new Map();
    this.notify();
  }

  private buildInitialGroups(settings: RoomSettings): Map<string, RenderGroup> {
    const { rows, cols, seed } = settings;
    const scatter = initialScatter(rows, cols, seed);
    const groups = new Map<string, RenderGroup>();
    for (let id = 0; id < scatter.length; id++) {
      const { row, col } = pieceIdToCoord(id, cols);
      const pos = scatter[id]!;
      const gid = singletonGroupId(row, col);
      groups.set(gid, {
        id: gid,
        pieces: [{ row, col }],
        position: { x: pos.x, y: pos.y },
        locked: false,
        heldBy: null,
      });
    }
    return groups;
  }

  /** Relayed holder motion for a remotely-held group (§6.2). */
  applyGroupMoved(msg: GroupMovedMessage): void {
    const group = this.state.groups.get(msg.groupId);
    if (!group) return;
    const now = this.clock.now();
    const previous = this.state.motion.get(msg.groupId)?.current ?? null;
    this.state.motion.set(msg.groupId, {
      current: { position: { x: msg.x, y: msg.y }, timestamp: now },
      previous,
    });
    group.position = { x: msg.x, y: msg.y };
    this.notify();
  }

  /**
   * Room-wide attribution of a granted grab (FR-19). Only touches `heldBy`,
   * never position, so applying our own optimistic hold's echo is inherently
   * a no-op for local drag state (SyncClient still guards it to skip the
   * redundant notify while a drag is in flight).
   */
  applyGroupHeld(msg: GroupHeldMessage): void {
    const group = this.state.groups.get(msg.groupId);
    if (!group) return;
    group.heldBy = msg.playerId;
    this.notify();
  }

  /**
   * A hold ended without a drop (disconnect or idle timeout, §7.4/§9). Snaps
   * to the payload's rest position so a client that missed the final
   * group_moved still converges (NFR-6); this is the server's rest position,
   * not a locally-optimistic one, so it always wins here. Also clears any
   * motion sample, same as applySnapResult: the group's active-motion phase
   * is over, and a stale sample would pull the renderer's interpolation
   * toward the old relayed target instead of this rest position.
   */
  applyGroupReleased(msg: GroupReleasedMessage): void {
    const group = this.state.groups.get(msg.groupId);
    if (!group) return;
    group.heldBy = null;
    group.position = { x: msg.x, y: msg.y };
    this.state.motion.delete(msg.groupId);
    this.notify();
  }

  /**
   * Apply an authoritative drop outcome verbatim (§7.3 step 5). Remove every
   * merged id and the pre-drop dropped id, then upsert the resolved group. No
   * snap/neighbor logic runs here — position, pieces, lock and merges come
   * straight from the payload (SnapResultMessage doc).
   */
  applySnapResult(msg: SnapResultMessage): void {
    for (const id of msg.mergedGroupIds) {
      this.state.groups.delete(id);
      this.state.motion.delete(id);
    }
    if (msg.droppedGroupId !== msg.group.id) {
      this.state.groups.delete(msg.droppedGroupId);
      this.state.motion.delete(msg.droppedGroupId);
    }
    this.state.motion.delete(msg.group.id);
    this.state.groups.set(msg.group.id, {
      id: msg.group.id,
      pieces: msg.group.pieces.map((p) => ({ row: p.row, col: p.col })),
      position: { x: msg.group.position.x, y: msg.group.position.y },
      locked: msg.group.lockedToFrame,
      heldBy: null,
    });
    this.applyCredits(msg.scoreCredits);
    this.state.scoreboard.progress = { ...msg.progress };
    this.notify();
  }

  private applyCredits(credits: ScoreCredit[]): void {
    for (const c of credits) {
      const player = this.state.players.get(c.guestId);
      if (player) player.placedCount += c.piecesCredited;
      const entry = this.state.scoreboard.players.find((p) => p.guestId === c.guestId);
      if (entry) entry.placedCount += c.piecesCredited;
      else this.state.scoreboard.players.push({ guestId: c.guestId, placedCount: c.piecesCredited });
    }
  }

  /**
   * A remote player's periodic cursor ping (~10 Hz, see SyncClient's
   * CURSOR_INTERVAL_MS). Records a motion sample alongside the raw position,
   * mirroring applyGroupMoved, so the renderer interpolates between pings
   * instead of snapping the pointer to each one (FR-17 renders cursors live;
   * NFR-2 requires motion look continuous, not teleporting).
   */
  applyCursor(msg: CursorBroadcastMessage): void {
    if (msg.guestId === this.state.localGuestId) return;
    const now = this.clock.now();
    const previous = this.state.cursorMotion.get(msg.guestId)?.current ?? null;
    this.state.cursorMotion.set(msg.guestId, {
      current: { position: { x: msg.x, y: msg.y }, timestamp: now },
      previous,
    });
    this.state.cursors.set(msg.guestId, { guestId: msg.guestId, x: msg.x, y: msg.y });
    this.notify();
  }

  applyPresence(msg: PresenceMessage): void {
    switch (msg.event) {
      case "joined":
        this.state.players.set(msg.player.id, { ...msg.player });
        break;
      case "left":
        // Presence tracks who's *here*; the score entry persists (FR-22/FR-24).
        this.state.players.delete(msg.guestId);
        this.state.cursors.delete(msg.guestId);
        this.state.cursorMotion.delete(msg.guestId);
        break;
      case "renamed": {
        const player = this.state.players.get(msg.guestId);
        if (player) player.name = msg.name;
        break;
      }
    }
    this.notify();
  }

  applyCompletion(msg: CompletionMessage): void {
    this.state.status = "completed";
    this.state.scoreboard = {
      players: msg.scoreboard.players.map((p) => ({ ...p })),
      progress: { ...msg.scoreboard.progress },
    };
    this.state.completion = { totalActiveSolvingTimeMs: msg.totalActiveSolvingTimeMs };
    this.notify();
  }

  // --- Optimistic drag mutators (driven by SyncClient, deliverable 2) ---

  /**
   * Optimistically attach a group to the local player. Refuses locally what the
   * server would refuse anyway (locked, or held by someone else) so we never
   * predict an attach we know will fail (FR-12); the genuine grab race is still
   * resolved by the server's grab_result. Returns whether the attach happened.
   */
  optimisticGrab(groupId: string, guestId: string): boolean {
    const group = this.state.groups.get(groupId);
    if (!group || group.locked) return false;
    if (group.heldBy !== null && group.heldBy !== guestId) return false;
    group.heldBy = guestId;
    this.notify();
    return true;
  }

  optimisticMove(groupId: string, x: number, y: number): void {
    const group = this.state.groups.get(groupId);
    if (!group) return;
    group.position = { x, y };
    this.notify();
  }

  /** Undo an optimistic grab the server rejected (held_by): restore position and release. */
  rollbackGrab(groupId: string, originalPosition: { x: number; y: number }): void {
    const group = this.state.groups.get(groupId);
    if (!group) return;
    group.heldBy = null;
    group.position = { x: originalPosition.x, y: originalPosition.y };
    this.notify();
  }

  /** Release an optimistic hold in place (drag failed by disconnect; keep position). */
  releaseHold(groupId: string): void {
    const group = this.state.groups.get(groupId);
    if (!group) return;
    group.heldBy = null;
    this.notify();
  }

  /** Optimistically reflect a local rename before the presence echo arrives. */
  setLocalName(name: string): void {
    const id = this.state.localGuestId;
    if (id === null) return;
    const player = this.state.players.get(id);
    if (player) player.name = name;
    this.notify();
  }
}
