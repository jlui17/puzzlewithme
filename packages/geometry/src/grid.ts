import type { Grid } from "./types.js";

/**
 * Product bounds for the requested piece count. 100 keeps the puzzle from
 * being trivial; 1000 is the scale the renderer and scatter layout are
 * validated against (NFR-1). Shared by the server's create validation and the
 * client's slider so the two can't drift.
 */
export const MIN_PIECE_COUNT = 100;
export const MAX_PIECE_COUNT = 1000;

/**
 * Derive the puzzle grid from a requested piece count and image dimensions
 * (FR-3). Pieces should stay as square as possible; the actual count may
 * differ from the request (the UI surfaces rows*cols as the real count before
 * creating). A piece's aspect is (imageWidth/cols) / (imageHeight/rows); it's
 * square when cols/rows == imageWidth/imageHeight.
 *
 * We search integer (rows, cols) near the ideal continuous solution and pick
 * the pair minimizing a cost that combines squareness error with count
 * deviation. Squareness uses |ln(pieceAspect)| so a piece twice as wide as
 * tall costs the same as one twice as tall as wide. Count uses the relative
 * deviation from the request. The two are summed with equal weight:
 * squareness is the FR-3 priority, but an unweighted sum still keeps the
 * count within a few percent of the request for all tested aspect ratios
 * (see grid tests), because `cols ≈ target/rows` bounds count error
 * structurally.
 */
export function deriveGrid(targetPieces: number, imageWidth: number, imageHeight: number): Grid {
  if (!Number.isInteger(targetPieces) || targetPieces < 1) {
    throw new Error("deriveGrid: targetPieces must be a positive integer");
  }
  if (imageWidth <= 0 || imageHeight <= 0) {
    throw new Error("deriveGrid: image dimensions must be positive");
  }
  const aspect = imageWidth / imageHeight;
  const idealRows = Math.sqrt(targetPieces / aspect);

  let best: Grid | null = null;
  let bestCost = Infinity;

  // Window of ±3 rows around the ideal covers the integer grids worth
  // considering; beyond it either squareness or count degrades monotonically.
  const rowLo = Math.max(1, Math.round(idealRows) - 3);
  const rowHi = Math.round(idealRows) + 3;
  for (let rows = rowLo; rows <= rowHi; rows++) {
    const idealCols = targetPieces / rows;
    for (let cols = Math.max(1, Math.round(idealCols) - 1); cols <= Math.round(idealCols) + 1; cols++) {
      const count = rows * cols;
      const pieceAspect = imageWidth / cols / (imageHeight / rows);
      const squarenessErr = Math.abs(Math.log(pieceAspect));
      const countErr = Math.abs(count - targetPieces) / targetPieces;
      const cost = squarenessErr + countErr;
      if (cost < bestCost) {
        bestCost = cost;
        best = { rows, cols };
      }
    }
  }

  // The window always contains at least one candidate (rowLo <= rowHi, and the
  // inner col range is non-empty), so best is never null here.
  return best!;
}
