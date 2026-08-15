/**
 * Local-vs-authoritative arbitration: the one place that decides what a server
 * message means while an optimistic drag is (or isn't) in flight. Pure — takes
 * the message and the current drag, returns a plan; SyncClient executes it.
 *
 * The rule in one line: the local drag leads its own group optimistically, so
 * echoes of our own actions for that group are dropped (`group_moved`, `held`,
 * `released`), a rejection rolls it back, and `snap_result` for its drop ends
 * it — everything else applies verbatim.
 */
import type {
  CompletionMessage,
  CursorBroadcastMessage,
  GroupHeldMessage,
  GroupMovedMessage,
  GroupReleasedMessage,
  PresenceMessage,
  ServerMessage,
  SnapResultMessage,
  SnapshotMessage,
} from "@puzzlewithme/shared";
import type { BoardState, SyncEvent, Vec2 } from "./state";

export interface DragState {
  groupId: string;
  originalPosition: Vec2;
  /** pending: grab not yet granted; granted: hold confirmed. */
  phase: "pending" | "granted";
}

/** One BoardStore mutation, named after the mutator it drives. */
export type StoreOp =
  | { op: "setLocalIdentity"; guestId: string }
  | { op: "setConnection"; status: BoardState["connection"] }
  | { op: "applySnapshot"; msg: SnapshotMessage }
  | { op: "rollbackGrab"; groupId: string; originalPosition: Vec2 }
  | { op: "applyGroupMoved"; msg: GroupMovedMessage }
  | { op: "applyGroupHeld"; msg: GroupHeldMessage }
  | { op: "applyGroupReleased"; msg: GroupReleasedMessage }
  | { op: "applySnapResult"; msg: SnapResultMessage }
  | { op: "applyCursor"; msg: CursorBroadcastMessage }
  | { op: "applyPresence"; msg: PresenceMessage }
  | { op: "applyCompletion"; msg: CompletionMessage };

export interface Reconciliation {
  store: StoreOp[];
  drag: DragState | null;
  emit: SyncEvent[];
}

export function reconcile(
  msg: ServerMessage,
  drag: DragState | null,
  localGuestId: string | null,
): Reconciliation {
  switch (msg.type) {
    case "joined":
      return { store: [{ op: "setLocalIdentity", guestId: msg.identity.id }], drag, emit: [] };

    case "snapshot":
      // A snapshot is a full resync: it is now the truth, so any in-flight
      // drag fails gracefully into it.
      return {
        store: [
          { op: "applySnapshot", msg },
          { op: "setConnection", status: "connected" },
        ],
        drag: null,
        emit: [],
      };

    case "pong":
      return { store: [], drag, emit: [] };

    case "grab_result":
      if (msg.outcome === "granted") {
        return {
          store: [],
          drag:
            drag?.groupId === msg.groupId && drag.phase === "pending"
              ? { ...drag, phase: "granted" }
              : drag,
          emit: [],
        };
      }
      // held_by: roll back the optimistic hold and surface who holds it
      // (FR-9). We only get holderName, not a guest id (see report).
      if (drag?.groupId === msg.groupId) {
        return {
          store: [{ op: "rollbackGrab", groupId: drag.groupId, originalPosition: drag.originalPosition }],
          drag: null,
          emit: [{ type: "grab_rejected", groupId: msg.groupId, holderName: msg.holderName }],
        };
      }
      return {
        store: [],
        drag,
        emit: [{ type: "grab_rejected", groupId: msg.groupId, holderName: msg.holderName }],
      };

    case "group_moved":
      // Our own optimistic drag leads locally; ignore the echo for it.
      if (drag?.groupId === msg.groupId) return { store: [], drag, emit: [] };
      return { store: [{ op: "applyGroupMoved", msg }], drag, emit: [] };

    case "held":
      // Room-wide attribution of a grab. Our own grab already led locally
      // (beginDrag set heldBy optimistically); applying our own echo again
      // can't change the value, but skip it anyway so it never races a
      // concurrent local mutation of the same drag.
      if (drag?.groupId === msg.groupId && msg.playerId === localGuestId) {
        return { store: [], drag, emit: [] };
      }
      return { store: [{ op: "applyGroupHeld", msg }], drag, emit: [] };

    case "released":
      // A release-without-drop for our own active drag would jump the group
      // to the server's rest position mid-drag; our own drag lifecycle
      // (endDrag/rollbackGrab/reconnect) already owns that case.
      if (drag?.groupId === msg.groupId) return { store: [], drag, emit: [] };
      return { store: [{ op: "applyGroupReleased", msg }], drag, emit: [] };

    case "snap_result":
      return {
        store: [{ op: "applySnapResult", msg }],
        drag: drag?.groupId === msg.droppedGroupId ? null : drag,
        emit: [],
      };

    case "cursor":
      return { store: [{ op: "applyCursor", msg }], drag, emit: [] };

    case "presence":
      return { store: [{ op: "applyPresence", msg }], drag, emit: [] };

    case "completion":
      return {
        store: [{ op: "applyCompletion", msg }],
        drag,
        emit: [{ type: "completion", totalActiveSolvingTimeMs: msg.totalActiveSolvingTimeMs }],
      };

    case "room_full":
      return {
        store: [{ op: "setConnection", status: "room_full" }],
        drag,
        emit: [{ type: "room_full" }],
      };

    case "error":
      // Includes room_completed (FR-25: mutations rejected once a room is
      // done); the UI reads code off this same channel to flip read-only.
      return { store: [], drag, emit: [{ type: "error", code: msg.code, message: msg.message }] };
  }
}
