import type { Vec2 } from "../sync";
import type { ShadowFrom } from "../theme";
import { MOCK_UNIT } from "./constants";

/**
 * Where a loose piece's shadow falls, in world units from the piece, given the
 * piece's centre and the lamp in screen pixels. Under the lamp the shadow
 * points away from it and grows with the distance, 3 units plus 1 per 200 px,
 * as in the mock; under the overcast sky it drops 3 units straight down.
 * `lift` stretches it for a piece held up off the table.
 */
export function shadowOffset(from: ShadowFrom, piece: Vec2, lamp: Vec2, lift: number): Vec2 {
  if (from === "overhead") return { x: 0, y: 3 * lift * MOCK_UNIT };
  const dx = piece.x - lamp.x;
  const dy = piece.y - lamp.y;
  const distance = Math.hypot(dx, dy) || 1;
  const length = (3 + distance / 200) * lift * MOCK_UNIT;
  return { x: (dx / distance) * length, y: (dy / distance) * length };
}
