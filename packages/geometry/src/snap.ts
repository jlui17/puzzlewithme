import { CELL_SIZE, DEFAULT_SNAP_TOLERANCE, TAB_HEIGHT_RATIO } from "./constants.js";
import { framePosition, pieceIdToCoord } from "./puzzle.js";
import { boardBounds } from "./scatter.js";
import type { GroupState, SnapDrop, SnapEvent, SnapOutcome, Vec2 } from "./types.js";

const OVERHANG = TAB_HEIGHT_RATIO * CELL_SIZE;

function anchorOf(pieces: number[]): number {
  let min = pieces[0]!;
  for (const p of pieces) if (p < min) min = p;
  return min;
}

/** World cell-origin of piece `id` in a group at `position` (anchor = min id). */
function worldOrigin(id: number, anchor: number, position: Vec2, cols: number): Vec2 {
  const fp = framePosition(id, cols);
  const fa = framePosition(anchor, cols);
  return { x: position.x + fp.x - fa.x, y: position.y + fp.y - fa.y };
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function areGridAdjacent(a: number, b: number, cols: number): boolean {
  const ca = pieceIdToCoord(a, cols);
  const cb = pieceIdToCoord(b, cols);
  const dr = Math.abs(ca.row - cb.row);
  const dc = Math.abs(ca.col - cb.col);
  return (dr === 0 && dc === 1) || (dr === 1 && dc === 0);
}

/**
 * Clamp a group's anchor position so its whole footprint (cells plus tab
 * overhang) stays within the board bounds (FR-15). A drop beyond an edge lands
 * the group against that edge.
 */
export function clampGroupToBoard(
  position: Vec2,
  pieces: number[],
  rows: number,
  cols: number,
): Vec2 {
  const anchor = anchorOf(pieces);
  const bounds = boardBounds(rows, cols);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pieces) {
    const o = worldOrigin(p, anchor, position, cols);
    minX = Math.min(minX, o.x - OVERHANG);
    minY = Math.min(minY, o.y - OVERHANG);
    maxX = Math.max(maxX, o.x + CELL_SIZE + OVERHANG);
    maxY = Math.max(maxY, o.y + CELL_SIZE + OVERHANG);
  }
  let dx = 0;
  let dy = 0;
  if (minX < bounds.minX) dx = bounds.minX - minX;
  else if (maxX > bounds.maxX) dx = bounds.maxX - maxX;
  if (minY < bounds.minY) dy = bounds.minY - minY;
  else if (maxY > bounds.maxY) dy = bounds.maxY - maxY;
  return { x: position.x + dx, y: position.y + dy };
}

interface Candidate {
  kind: "frame" | "merge";
  translation: Vec2;
  mag: number;
  targetId: string | null;
  tiePair: string;
}

/**
 * Evaluate a drop against the current groups and return the authoritative
 * outcome (FR-11): final aligned position, merges (with cascades), frame locks,
 * and the pieces connected for scoring credit (FR-21). Pure: inputs are never
 * mutated.
 *
 * Model: the dropped group is the only thing that moves. We pick one alignment
 * translation (a frame lock is preferred over a neighbor merge; among ties the
 * smallest offset, then a stable id key), snap the dropped group by it, then
 * take the connected component of all groups now within tolerance — that whole
 * set merges in one event, which is how a drop between two chunks joins all
 * three. If the aligned group sits within tolerance of its correct frame
 * position, or it touched any already-locked group, the result locks to the
 * frame (locked groups never move, since the frame position is exactly where
 * they already are).
 *
 * Server-only: this is the referee (§7.3 step 4). The client applies
 * SnapResultMessage directly and never re-runs snap logic (§6.1.5's
 * bit-identical requirement covers generatePuzzle/initialScatter, NOT this
 * function), which is why the Math.hypot distance checks are safe here. If a
 * future change runs snap on the client for optimistic prediction, the
 * tolerance-boundary comparisons become a cross-engine divergence risk and
 * this note must be revisited.
 */
export function evaluateSnap(
  rows: number,
  cols: number,
  groups: GroupState[],
  drop: SnapDrop,
  tolerance: number = DEFAULT_SNAP_TOLERANCE,
): SnapOutcome {
  const droppedIndex = groups.findIndex((g) => g.id === drop.groupId);
  if (droppedIndex < 0) {
    throw new Error(`evaluateSnap: no group with id ${drop.groupId}`);
  }
  const dropped = groups[droppedIndex]!;

  // Locked groups are immovable (FR-12): a drop on one is a no-op.
  if (dropped.locked) {
    return noSnapOutcome(dropped, dropped.position, groups);
  }

  const dropAnchor = anchorOf(dropped.pieces);
  const others = groups.filter((g) => g.id !== dropped.id);

  const originAt = (id: number, group: GroupState, positionOverride?: Vec2): Vec2 =>
    worldOrigin(id, anchorOf(group.pieces), positionOverride ?? group.position, cols);

  // --- Collect alignment candidates for the dropped group at drop.position ---
  const candidates: Candidate[] = [];

  // Frame lock: the group is rigid, so if its anchor is within tolerance of its
  // frame position, every piece is — one check suffices.
  const frameTranslation = {
    x: framePosition(dropAnchor, cols).x - drop.position.x,
    y: framePosition(dropAnchor, cols).y - drop.position.y,
  };
  const frameMag = Math.hypot(frameTranslation.x, frameTranslation.y);
  if (frameMag <= tolerance) {
    candidates.push({ kind: "frame", translation: frameTranslation, mag: frameMag, targetId: null, tiePair: "" });
  }

  // Neighbor merges.
  for (const g of others) {
    for (const a of dropped.pieces) {
      for (const b of g.pieces) {
        if (!areGridAdjacent(a, b, cols)) continue;
        const curOff = sub(originAt(a, dropped, drop.position), originAt(b, g));
        const wantOff = sub(framePosition(a, cols), framePosition(b, cols));
        const d = sub(wantOff, curOff);
        const mag = Math.hypot(d.x, d.y);
        if (mag <= tolerance) {
          candidates.push({ kind: "merge", translation: d, mag, targetId: g.id, tiePair: `${a}:${b}` });
        }
      }
    }
  }

  if (candidates.length === 0) {
    const clamped = clampGroupToBoard(drop.position, dropped.pieces, rows, cols);
    return noSnapOutcome(dropped, clamped, groups);
  }

  candidates.sort(compareCandidates);
  const chosen = candidates[0]!;
  const alignedPos = { x: drop.position.x + chosen.translation.x, y: drop.position.y + chosen.translation.y };

  // --- Connected component of all groups within tolerance after alignment ---
  const posOverride = (g: GroupState): Vec2 | undefined => (g.id === dropped.id ? alignedPos : undefined);
  const connects = (x: GroupState, y: GroupState): boolean => {
    for (const a of x.pieces) {
      for (const b of y.pieces) {
        if (!areGridAdjacent(a, b, cols)) continue;
        const curOff = sub(originAt(a, x, posOverride(x)), originAt(b, y, posOverride(y)));
        const wantOff = sub(framePosition(a, cols), framePosition(b, cols));
        if (Math.hypot(wantOff.x - curOff.x, wantOff.y - curOff.y) <= tolerance) return true;
      }
    }
    return false;
  };

  const inComponent = new Set<string>([dropped.id]);
  const queue: GroupState[] = [dropped];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const g of groups) {
      if (inComponent.has(g.id)) continue;
      if (connects(cur, g)) {
        inComponent.add(g.id);
        queue.push(g);
      }
    }
  }

  const component = groups.filter((g) => inComponent.has(g.id));
  const unionPieces = component.flatMap((g) => g.pieces).sort((a, b) => a - b);
  const unionAnchor = unionPieces[0]!;

  let locked = chosen.kind === "frame" || component.some((g) => g.locked);

  // Reference frame for the merged group's coordinates.
  let position: Vec2;
  if (locked) {
    position = framePosition(unionAnchor, cols);
  } else {
    // Adopt the largest existing chunk's frame so big chunks don't visibly move;
    // everyone else snaps onto it (all are within tolerance by construction).
    const ref = pickReference(component, dropped.id);
    const refPos = ref.id === dropped.id ? alignedPos : ref.position;
    const refAnchor = anchorOf(ref.pieces);
    position = {
      x: refPos.x + framePosition(unionAnchor, cols).x - framePosition(refAnchor, cols).x,
      y: refPos.y + framePosition(unionAnchor, cols).y - framePosition(refAnchor, cols).y,
    };
    // Cascade lock: a merge that lands the group on its frame position locks it.
    if (dist(position, framePosition(unionAnchor, cols)) <= tolerance) {
      locked = true;
      position = framePosition(unionAnchor, cols);
    }
  }

  const resultingGroup: GroupState = { id: dropped.id, pieces: unionPieces, position, locked };
  const merged = component.length > 1;
  const mergedGroupIds = component.filter((g) => g.id !== dropped.id).map((g) => g.id).sort();

  const events: SnapEvent[] = [];
  if (merged) {
    events.push({
      type: "merge",
      groupIds: component.map((g) => g.id).sort(),
      connectedPieces: unionPieces,
    });
  }
  if (locked) {
    events.push({ type: "lock", groupIds: [dropped.id], connectedPieces: unionPieces });
  }

  const finalPosition = worldOrigin(dropAnchor, unionAnchor, position, cols);

  const newGroups: GroupState[] = [];
  for (const g of groups) {
    if (g.id === dropped.id) newGroups.push(resultingGroup);
    else if (!inComponent.has(g.id)) newGroups.push(g);
  }

  return {
    finalPosition,
    merged,
    locked,
    mergedGroupIds,
    events,
    connectedPieces: unionPieces,
    group: resultingGroup,
    groups: newGroups,
  };
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function compareCandidates(a: Candidate, b: Candidate): number {
  // Frame locks win over merges; then smallest offset; then a stable key so the
  // referee's output never depends on input array order (NFR-6).
  if (a.kind !== b.kind) return a.kind === "frame" ? -1 : 1;
  if (a.mag !== b.mag) return a.mag - b.mag;
  const at = a.targetId ?? "";
  const bt = b.targetId ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  return a.tiePair < b.tiePair ? -1 : a.tiePair > b.tiePair ? 1 : 0;
}

function pickReference(component: GroupState[], droppedId: string): GroupState {
  let best = component[0]!;
  for (const g of component) {
    if (g.pieces.length > best.pieces.length) best = g;
    else if (g.pieces.length === best.pieces.length) {
      // Tie: prefer a non-dropped group, then the smaller anchor id, for stability.
      const gDropped = g.id === droppedId;
      const bDropped = best.id === droppedId;
      if (bDropped && !gDropped) best = g;
      else if (gDropped === bDropped && anchorOf(g.pieces) < anchorOf(best.pieces)) best = g;
    }
  }
  return best;
}

function noSnapOutcome(dropped: GroupState, position: Vec2, groups: GroupState[]): SnapOutcome {
  const group: GroupState = { ...dropped, position };
  return {
    finalPosition: position,
    merged: false,
    locked: dropped.locked,
    mergedGroupIds: [],
    events: [],
    connectedPieces: [],
    group,
    groups: groups.map((g) => (g.id === dropped.id ? group : g)),
  };
}
