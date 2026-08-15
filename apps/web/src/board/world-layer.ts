import type { Container, Texture } from "pixi.js";

/**
 * A themed layer of the camera viewport (the table slab, the props). Uniform
 * shape so a theme change swaps any layer the same way: `textures` lists the
 * GPU textures the layer owns beyond its display tree, which
 * `destroy({children: true})` alone would leak.
 */
export interface WorldLayer {
  container: Container;
  textures: Texture[];
}

/**
 * Replace `current` with `next` at the same z-index in `parent`, destroying
 * everything `current` owns. Returns `next` so callers can reassign their slot.
 */
export function swapWorldLayer(parent: Container, current: WorldLayer, next: WorldLayer): WorldLayer {
  const index = parent.getChildIndex(current.container);
  parent.removeChild(current.container);
  current.container.destroy({ children: true });
  for (const texture of current.textures) texture.destroy(true);
  parent.addChildAt(next.container, index);
  return next;
}
