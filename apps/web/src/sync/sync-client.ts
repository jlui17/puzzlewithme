/**
 * Intent side + connection lifecycle (deliverables 2 and 4). Owns the socket,
 * the outbound move throttle, the periodic cursor tick, the reconnect backoff,
 * and the optimistic-drag state machine; delegates all board mutation to
 * BoardStore. Sends intents only (§6.2) and reconciles to authoritative
 * results.
 */
import type { ClientMessage, ServerMessage } from "@puzzlewithme/shared";
import { backoffDelay } from "./backoff";
import { BoardStore } from "./board-store";
import type {
  Clock,
  Scheduler,
  SocketFactory,
  SyncSocket,
  TimerHandle,
  TokenStorage,
} from "./interfaces";
import type { BoardState, SyncEvent, Vec2 } from "./state";
import { Throttle } from "./throttle";

/**
 * 30 Hz move relay (~33 ms). Above ~30 Hz costs bandwidth with no visible gain
 * because remote clients interpolate the samples (NFR-2 requires motion "look
 * continuous"); below ~20 Hz interpolation starts to look steppy on a fast
 * drag. 30 Hz is the smoothness/bandwidth knee common to realtime cursor
 * relays; chosen by that convention, not measured against this game's traffic.
 */
const MOVE_INTERVAL_MS = 1000 / 30;

/**
 * 10 Hz cursor ping (100 ms), fired on its own fixed timer rather than derived
 * from mousemove events: a bursty or idle pointer never distorts the send
 * cadence, so the receiver sees an evenly-spaced sample stream it can
 * interpolate cleanly (NFR-2's "must look continuous, not teleporting").
 * 10 Hz sits in the usual presence-cursor range (collaborative editors relay
 * around 10-20 Hz) and keeps fan-out cheap at the 20-player cap (NFR-3):
 * 20 senders * 19 receivers * 10/s ≈ 3800 msg/s room-wide worst case, a third
 * of what the 30 Hz move relay can generate. Lower rates save little more and
 * push the receiver's interp delay (CURSOR_INTERP_DELAY_MS scales with this
 * interval) past NFR-2's 200 ms budget. Convention-based like the move rate
 * above, not measured against this game's live traffic.
 */
const CURSOR_INTERVAL_MS = 1000 / 10;

/**
 * Reconnect backoff (§7.4). 500 ms base recovers a transient blip almost
 * immediately; doubling caps out at 15 s so a long outage keeps retrying at a
 * reasonable cadence without hammering a recovering server (NFR-5). Guessed
 * from typical reconnect UX; the cap is the one value worth revisiting under
 * real restart load.
 */
const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 2;
const BACKOFF_CAP_MS = 15_000;

interface DragState {
  groupId: string;
  originalPosition: Vec2;
  /** pending: grab not yet granted; granted: hold confirmed; dropping: drop sent, awaiting snap_result. */
  phase: "pending" | "granted" | "dropping";
}

export interface SyncClientConfig {
  roomId: string;
  socketFactory: SocketFactory;
  clock: Clock;
  scheduler: Scheduler;
  tokenStorage: TokenStorage;
  /** Persistent anonymous user id sent on join, or null when unavailable (old flow: resume-token-only identity). */
  userId?: string | null;
  /** Optional jitter source for reconnect backoff; see BackoffConfig.random. */
  random?: () => number;
}

export class SyncClient {
  readonly store: BoardStore;
  private readonly moveThrottle = new Throttle(MOVE_INTERVAL_MS);
  private readonly eventListeners = new Set<(event: SyncEvent) => void>();

  private socket: SyncSocket | null = null;
  private drag: DragState | null = null;
  private localGuestId: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: TimerHandle | null = null;
  private closedByUser = false;

  /** Latest known local cursor position; relayed by cursorTick, not on arrival. */
  private pendingCursor: Vec2 | null = null;
  /** The position last actually sent, to skip a tick when nothing changed. */
  private lastSentCursor: Vec2 | null = null;
  private cursorTickTimer: TimerHandle | null = null;

  constructor(private readonly config: SyncClientConfig) {
    this.store = new BoardStore(config.clock);
  }

  getState(): BoardState {
    return this.store.getState();
  }

  subscribe(listener: (state: BoardState) => void): () => void {
    return this.store.subscribe(listener);
  }

  onEvent(listener: (event: SyncEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private emit(event: SyncEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  // --- Connection lifecycle (deliverable 4) ---

  connect(): void {
    this.closedByUser = false;
    this.openSocket();
  }

  /** Stop for good: cancel any pending reconnect and close the socket. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      this.config.scheduler.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Stop here, not just in handleClose: the real WebSocket's onclose fires
    // asynchronously, and the self-rescheduling cursor tick must not outlive
    // this call while that callback is still in flight.
    this.stopCursorTick();
    this.socket?.close();
    this.socket = null;
    this.store.setConnection("closed");
  }

  /**
   * Fixed 10 Hz relay of the latest local cursor position: a periodic ping,
   * not a per-mousemove send. Reschedules itself via the injected Scheduler
   * (no bare setInterval, matching the reconnect backoff's seam) so tests can
   * drive it with fake time. Skips the send when disconnected or when the
   * position hasn't changed since the last one actually sent.
   */
  private readonly cursorTick = (): void => {
    if (
      this.isConnected() &&
      this.pendingCursor &&
      (!this.lastSentCursor ||
        this.pendingCursor.x !== this.lastSentCursor.x ||
        this.pendingCursor.y !== this.lastSentCursor.y)
    ) {
      this.send({ type: "cursor", x: this.pendingCursor.x, y: this.pendingCursor.y });
      this.lastSentCursor = this.pendingCursor;
    }
    this.cursorTickTimer = this.config.scheduler.setTimer(this.cursorTick, CURSOR_INTERVAL_MS);
  };

  private startCursorTick(): void {
    if (this.cursorTickTimer !== null) return;
    this.cursorTickTimer = this.config.scheduler.setTimer(this.cursorTick, CURSOR_INTERVAL_MS);
  }

  private stopCursorTick(): void {
    if (this.cursorTickTimer === null) return;
    this.config.scheduler.clearTimer(this.cursorTickTimer);
    this.cursorTickTimer = null;
  }

  private openSocket(): void {
    this.reconnectTimer = null;
    this.store.setConnection(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const socket = this.config.socketFactory();
    this.socket = socket;
    socket.onopen = () => this.handleOpen();
    socket.onmessage = (data) => this.handleMessage(data);
    socket.onclose = () => this.handleClose();
    // Errors surface as a close; the socket still fires onclose after onerror.
    socket.onerror = () => {};
  }

  private handleOpen(): void {
    // Join carries the stored resume token so the same browser resumes its
    // identity (FR-24); null on first ever visit. userId is the persistent
    // cross-session id (undefined omits it, keeping old-client behavior). Sent
    // directly (not gated by isConnected) because we're not "connected" until
    // the snapshot lands.
    this.send({
      type: "join",
      roomId: this.config.roomId,
      resumeToken: this.config.tokenStorage.load(),
      userId: this.config.userId ?? null,
    });
  }

  private handleClose(): void {
    // Any disconnect (ours or the transport's) ends the tick; a fresh
    // "connected" snapshot restarts it (see the "snapshot" case below).
    this.stopCursorTick();
    this.socket = null;
    if (this.closedByUser) {
      // room_full is terminal too, but keep that status so the UI can show why.
      if (this.store.getState().connection !== "room_full") this.store.setConnection("closed");
      return;
    }
    // Unexpected drop: an in-flight drag is left visually in place; it's
    // released when the reconnect snapshot replaces the board (deliverable 4).
    this.store.setConnection("reconnecting");
    const delay = backoffDelay(this.reconnectAttempt, {
      baseMs: BACKOFF_BASE_MS,
      factor: BACKOFF_FACTOR,
      capMs: BACKOFF_CAP_MS,
      random: this.config.random,
    });
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.config.scheduler.setTimer(() => this.openSocket(), delay);
  }

  private handleMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "joined":
        this.localGuestId = msg.identity.id;
        this.store.setLocalIdentity(msg.identity.id);
        this.config.tokenStorage.save(msg.resumeToken);
        break;

      case "snapshot":
        // A received snapshot means a full resync succeeded: reset backoff and
        // fail any in-flight drag gracefully (the snapshot is now the truth).
        this.reconnectAttempt = 0;
        this.drag = null;
        this.moveThrottle.reset();
        // Force the next tick to resend regardless of the pre-disconnect
        // position: this is a new connection, so any prior send is stale to
        // other clients even if our pointer never moved across the gap.
        this.lastSentCursor = null;
        this.startCursorTick();
        this.store.applySnapshot(msg);
        this.store.setConnection("connected");
        break;

      case "grab_result":
        if (msg.outcome === "granted") {
          if (this.drag?.groupId === msg.groupId && this.drag.phase === "pending") {
            this.drag.phase = "granted";
          }
        } else {
          // held_by: roll back the optimistic hold and surface who holds it
          // (FR-9). We only get holderName, not a guest id (see report).
          if (this.drag?.groupId === msg.groupId) {
            this.store.rollbackGrab(this.drag.groupId, this.drag.originalPosition);
            this.drag = null;
          }
          this.emit({ type: "grab_rejected", groupId: msg.groupId, holderName: msg.holderName });
        }
        break;

      case "group_moved":
        // Our own optimistic drag leads locally; ignore the echo for it.
        if (this.drag?.groupId === msg.groupId) break;
        this.store.applyGroupMoved(msg);
        break;

      case "held":
        // Room-wide attribution of a grab. Our own grab already led locally
        // (beginDrag set heldBy optimistically); applying our own echo again
        // can't change the value, but skip it anyway so it never races a
        // concurrent local mutation of the same drag.
        if (this.drag?.groupId === msg.groupId && msg.playerId === this.localGuestId) break;
        this.store.applyGroupHeld(msg);
        break;

      case "released":
        // A release-without-drop for our own active drag would jump the
        // group to the server's rest position mid-drag; our own drag
        // lifecycle (endDrag/rollbackGrab/reconnect) already owns that case.
        if (this.drag?.groupId === msg.groupId) break;
        this.store.applyGroupReleased(msg);
        break;

      case "snap_result":
        this.store.applySnapResult(msg);
        if (this.drag?.groupId === msg.droppedGroupId) this.drag = null;
        break;

      case "cursor":
        this.store.applyCursor(msg);
        break;

      case "presence":
        this.store.applyPresence(msg);
        break;

      case "completion":
        this.store.applyCompletion(msg);
        this.emit({ type: "completion", totalActiveSolvingTimeMs: msg.totalActiveSolvingTimeMs });
        break;

      case "room_full":
        this.store.setConnection("room_full");
        this.emit({ type: "room_full" });
        // No reconnect: capacity won't change by retrying (§9, no queueing).
        this.closedByUser = true;
        this.socket?.close();
        break;

      case "error":
        // Includes room_completed (FR-25: mutations rejected once a room is
        // done); the UI reads code off this same channel to flip read-only.
        this.emit({ type: "error", code: msg.code, message: msg.message });
        break;
    }
  }

  // --- Intents with optimistic drag (deliverable 2) ---

  /**
   * Grab a group: optimistically attach it to local input and send the grab
   * intent (§7.3 step 1). Returns false if the group can't be grabbed locally
   * (unknown, locked, or already held), in which case no intent is sent.
   */
  beginDrag(groupId: string): boolean {
    if (this.localGuestId === null) return false;
    if (!this.store.optimisticGrab(groupId, this.localGuestId)) return false;
    const group = this.store.getState().groups.get(groupId)!;
    this.drag = { groupId, originalPosition: { ...group.position }, phase: "pending" };
    // Fresh bucket so this drag's first move relays immediately.
    this.moveThrottle.reset();
    this.send({ type: "grab", groupId });
    return true;
  }

  /** Update the held group's local position immediately; relay throttled to 30 Hz. */
  dragTo(x: number, y: number): void {
    if (!this.drag) return;
    this.store.optimisticMove(this.drag.groupId, x, y);
    if (this.isConnected() && this.moveThrottle.tryEmit(this.config.clock.now())) {
      this.send({ type: "move", groupId: this.drag.groupId, x, y });
    }
  }

  /**
   * Release: keep the optimistic position and send the drop intent (§7.3
   * step 4). The optimistic position stands until snap_result reconciles it
   * (position correction, merges, locks, scores). If we're disconnected, the
   * drop can't be sent: release the hold in place and let the reconnect
   * snapshot restore authoritative state.
   */
  endDrag(x: number, y: number): void {
    if (!this.drag) return;
    this.store.optimisticMove(this.drag.groupId, x, y);
    if (this.isConnected()) {
      this.drag.phase = "dropping";
      this.send({ type: "drop", groupId: this.drag.groupId, x, y });
    } else {
      this.store.releaseHold(this.drag.groupId);
      this.drag = null;
    }
  }

  /**
   * Record the latest local cursor position for the periodic cursorTick to
   * relay (see CURSOR_INTERVAL_MS); this call itself never sends. Recorded
   * even while disconnected so the first tick after reconnect immediately
   * carries the up-to-date position.
   */
  moveCursor(x: number, y: number): void {
    this.pendingCursor = { x, y };
  }

  rename(name: string): void {
    this.store.setLocalName(name);
    if (this.isConnected()) this.send({ type: "rename", name });
  }

  private isConnected(): boolean {
    return this.socket !== null && this.store.getState().connection === "connected";
  }

  private send(msg: ClientMessage): void {
    this.socket?.send(JSON.stringify(msg));
  }
}
