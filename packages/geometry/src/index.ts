/**
 * @puzzlewithme/geometry — the deterministic seed -> puzzle geometry core
 * (SPEC §6.1.5). Client and server both import this package and must produce
 * bit-identical results, so everything here is pure and seed-driven: no
 * Math.random, no Date.now, no I/O. See constants.ts for the coordinate
 * convention and prng.ts for the engine-identity guarantees.
 */

// apps/server's placeholder imports this to prove workspace resolution works
// (mirrors @puzzlewithme/shared); kept alongside the real geometry API since
// apps/* is out of scope for this change.
export const PACKAGE_NAME = "@puzzlewithme/geometry";

export {
  BOARD_SIZE_MULTIPLIER,
  CELL_SIZE,
  DEFAULT_SNAP_TOLERANCE,
  TAB_ASYMMETRY_JITTER,
  TAB_BULB_HALF_RATIO,
  TAB_HEIGHT_RATIO,
  TAB_MAX_HEIGHT_RATIO,
  TAB_NECK_HALF_RATIO,
  TAB_POS_JITTER,
  TAB_SIZE_JITTER,
  TAB_TILT_JITTER,
} from "./constants.js";

export type {
  EdgeDescriptor,
  EdgeKind,
  EdgeSide,
  Grid,
  GroupState,
  Piece,
  Puzzle,
  SnapDrop,
  SnapEvent,
  SnapOutcome,
  Vec2,
} from "./types.js";

export { createRng, hashSeed, shuffleInPlace, type Rng } from "./prng.js";

export { deriveGrid, type Tier } from "./grid.js";

export {
  coordToPieceId,
  framePosition,
  generatePuzzle,
  neighborsOf,
  pieceIdToCoord,
} from "./puzzle.js";

export {
  buildTabEdge,
  edgeControlPoints,
  flatEdge,
  pieceOutlineControlPoints,
  pieceSvgPath,
  type EdgeJitter,
  type EdgeOrientation,
} from "./path.js";

export { boardBounds, initialScatter } from "./scatter.js";

export { clampGroupToBoard, evaluateSnap } from "./snap.js";
