import type { Container, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import { swapWorldLayer, type WorldLayer } from "./world-layer";

interface FakeContainer {
  destroyed: boolean;
  destroy: (opts?: { children?: boolean }) => void;
  destroyOpts?: { children?: boolean };
}

function fakeContainer(): FakeContainer {
  const node: FakeContainer = {
    destroyed: false,
    destroy(opts) {
      node.destroyed = true;
      node.destroyOpts = opts;
    },
  };
  return node;
}

function fakeTexture(): { destroyed: boolean; destroy: (source?: boolean) => void } {
  const tex = {
    destroyed: false,
    destroy() {
      tex.destroyed = true;
    },
  };
  return tex;
}

function fakeLayer(textureCount: number): WorldLayer {
  return {
    container: fakeContainer() as unknown as Container,
    textures: Array.from({ length: textureCount }, () => fakeTexture() as unknown as Texture),
  };
}

function fakeParent(): Container {
  const children: unknown[] = [];
  return {
    children,
    getChildIndex: (child: unknown) => children.indexOf(child),
    removeChild: (child: unknown) => {
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
    },
    addChildAt: (child: unknown, index: number) => {
      children.splice(index, 0, child);
    },
    addChild: (child: unknown) => {
      children.push(child);
    },
  } as unknown as Container;
}

describe("swapWorldLayer", () => {
  it("replaces the layer at the same z-index and returns the new one", () => {
    const parent = fakeParent();
    const below = fakeLayer(0);
    const current = fakeLayer(1);
    const above = fakeLayer(0);
    parent.addChild(below.container);
    parent.addChild(current.container);
    parent.addChild(above.container);

    const next = fakeLayer(1);
    const result = swapWorldLayer(parent, current, next);

    expect(result).toBe(next);
    expect(parent.children).toEqual([below.container, next.container, above.container]);
  });

  it("destroys the old container (with children) and every texture it owns", () => {
    const parent = fakeParent();
    const current = fakeLayer(2);
    parent.addChild(current.container);

    swapWorldLayer(parent, current, fakeLayer(0));

    const container = current.container as unknown as FakeContainer;
    expect(container.destroyed).toBe(true);
    expect(container.destroyOpts).toEqual({ children: true });
    for (const texture of current.textures) {
      expect((texture as unknown as { destroyed: boolean }).destroyed).toBe(true);
    }
  });

  it("never leaks across repeated swaps: destroys equal builds minus the live layer", () => {
    const parent = fakeParent();
    const layers = [fakeLayer(1)];
    parent.addChild(layers[0]!.container);
    let live = layers[0]!;
    for (let i = 0; i < 5; i++) {
      const next = fakeLayer(1);
      layers.push(next);
      live = swapWorldLayer(parent, live, next);
    }
    const destroyed = layers.filter((l) => (l.container as unknown as FakeContainer).destroyed);
    expect(destroyed.length).toBe(layers.length - 1);
    expect((live.container as unknown as FakeContainer).destroyed).toBe(false);
    expect(parent.children).toEqual([live.container]);
  });
});
