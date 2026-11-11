import { describe, expect, it } from "vitest";
import { EscapeLayers } from "./escape";

describe("EscapeLayers", () => {
  it("closes only the newest open layer on each press", () => {
    const layers = new EscapeLayers();
    const closed: string[] = [];
    const removals = new Map<string, () => void>();
    const open = (name: string) =>
      removals.set(
        name,
        layers.open(() => {
          closed.push(name);
          removals.get(name)!();
        }),
      );
    open("finish card");
    open("who's here");
    open("picture");

    layers.closeTopmost();
    expect(closed).toEqual(["picture"]);
    layers.closeTopmost();
    expect(closed).toEqual(["picture", "who's here"]);
    layers.closeTopmost();
    layers.closeTopmost();
    expect(closed).toEqual(["picture", "who's here", "finish card"]);
  });

  it("skips a layer closed some other way", () => {
    const layers = new EscapeLayers();
    const closed: string[] = [];
    layers.open(() => closed.push("finish card"));
    const removePanel = layers.open(() => closed.push("who's here"));
    removePanel();
    layers.closeTopmost();
    expect(closed).toEqual(["finish card"]);
  });
});
