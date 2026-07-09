import { describe, expect, it } from "vitest";
import type { ClientMessage } from "./client-messages.js";
import { parseClientMessage } from "./validation.js";

const validMessages: Record<ClientMessage["type"], ClientMessage> = {
  join: { type: "join", roomId: "room-123", resumeToken: null },
  rename: { type: "rename", name: "Alice" },
  grab: { type: "grab", groupId: "grp-1" },
  move: { type: "move", groupId: "grp-1", x: 12.5, y: -3.25 },
  drop: { type: "drop", groupId: "grp-1", x: 0, y: 0 },
  cursor: { type: "cursor", x: 100, y: 200 },
};

describe("parseClientMessage — round trips", () => {
  for (const [type, message] of Object.entries(validMessages)) {
    it(`accepts a well-formed "${type}" message and returns it unchanged`, () => {
      const result = parseClientMessage(message);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message).toEqual(message);
      }
    });
  }

  it("accepts a join with a non-null resumeToken", () => {
    const message: ClientMessage = { type: "join", roomId: "room-123", resumeToken: "tok-abc" };
    const result = parseClientMessage(message);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toEqual(message);
  });
});

describe("parseClientMessage — rejects malformed input", () => {
  it("rejects an unknown type tag", () => {
    const result = parseClientMessage({ type: "teleport", x: 1, y: 2 });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing type tag", () => {
    const result = parseClientMessage({ roomId: "room-123", resumeToken: null });
    expect(result.ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(parseClientMessage(null).ok).toBe(false);
    expect(parseClientMessage("join").ok).toBe(false);
    expect(parseClientMessage(42).ok).toBe(false);
    expect(parseClientMessage(undefined).ok).toBe(false);
  });

  it("rejects NaN coordinates on move", () => {
    const result = parseClientMessage({ type: "move", groupId: "grp-1", x: Number.NaN, y: 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects Infinity coordinates on drop", () => {
    const result = parseClientMessage({ type: "drop", groupId: "grp-1", x: Number.POSITIVE_INFINITY, y: 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects -Infinity coordinates on cursor", () => {
    const result = parseClientMessage({ type: "cursor", x: 1, y: Number.NEGATIVE_INFINITY });
    expect(result.ok).toBe(false);
  });

  it("rejects a name over the length cap", () => {
    const result = parseClientMessage({ type: "rename", name: "x".repeat(41) });
    expect(result.ok).toBe(false);
  });

  it("accepts a name exactly at the length cap", () => {
    const result = parseClientMessage({ type: "rename", name: "x".repeat(40) });
    expect(result.ok).toBe(true);
  });

  it("rejects an empty name", () => {
    const result = parseClientMessage({ type: "rename", name: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing required field (groupId on grab)", () => {
    const result = parseClientMessage({ type: "grab" });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing required field (roomId on join)", () => {
    const result = parseClientMessage({ type: "join", resumeToken: null });
    expect(result.ok).toBe(false);
  });

  it("rejects resumeToken as undefined instead of explicit null", () => {
    // resumeToken is nullable, not optional: clients must send `null` on first join,
    // never omit the field, so the server can distinguish "no token" from a bug.
    const result = parseClientMessage({ type: "join", roomId: "room-123" });
    expect(result.ok).toBe(false);
  });

  it("rejects an oversized roomId", () => {
    const result = parseClientMessage({ type: "join", roomId: "x".repeat(129), resumeToken: null });
    expect(result.ok).toBe(false);
  });

  it("rejects an oversized resumeToken", () => {
    const result = parseClientMessage({ type: "join", roomId: "room-123", resumeToken: "x".repeat(257) });
    expect(result.ok).toBe(false);
  });

  it("rejects extra/wrong-typed fields (x as a string)", () => {
    const result = parseClientMessage({ type: "cursor", x: "1", y: 2 });
    expect(result.ok).toBe(false);
  });
});
