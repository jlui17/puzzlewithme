import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it("uses the local API by default", async () => {
  vi.stubEnv("NEXT_PUBLIC_IMAGE_DELIVERY", "");
  const { imageUrl } = await import("./config");
  expect(imageUrl("some/key")).toBe("/api/images/some%2Fkey");
});
it("uses the same-origin Worker for all image keys when enabled", async () => {
  vi.stubEnv("NEXT_PUBLIC_IMAGE_DELIVERY", "worker");
  const { imageUrl } = await import("./config");
  expect(imageUrl("abcdefghijklmnopqrstuv")).toBe("/photos/abcdefghijklmnopqrstuv");
});
