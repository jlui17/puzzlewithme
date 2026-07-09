/**
 * Client→server intent messages (§6.2: clients send intents — "I dropped
 * group G at (x,y)" — never outcomes like "these groups merged"; only the
 * server decides outcomes).
 *
 * These are the one part of the protocol that crosses a trust boundary
 * (NFR-7: "Clients are untrusted"), so each intent gets a zod schema and the
 * TS type is derived from it (`z.infer`) rather than declared separately —
 * that way the validated shape and the type used elsewhere can't drift.
 */
import { z } from "zod";

// Display names render in fixed-width UI slots (player list, cursor labels);
// 40 chars comfortably fits a real name or nickname without wrapping and
// bounds the payload size for a value the server persists per guest (FR-22).
// Not measured against real usage yet — revisit if legitimate names get clipped.
const MAX_NAME_LENGTH = 40;

// Room ids are the unguessable access credential (FR-5); 128 chars is far
// beyond any reasonable id-generator output and just guards against a
// malicious client sending an oversized string before we ever query storage.
const MAX_ROOM_ID_LENGTH = 128;

// Resume tokens are server-issued, opaque, and only ever echoed back by the
// client that received one; 256 chars leaves headroom for a signed/opaque
// token format without allowing arbitrary-size payloads from an attacker
// who never received a real token.
const MAX_RESUME_TOKEN_LENGTH = 256;

// Group ids are derived from grid coordinates (e.g. "3-14") or server-issued
// merge ids; 64 chars is generous for either while still capping input size.
const MAX_GROUP_ID_LENGTH = 64;

/**
 * Rejects NaN and +/-Infinity explicitly (rather than relying on z.number()'s
 * default behavior) so the intent is visible at the call site: every
 * coordinate in this protocol must be a finite number, since NaN/Infinity
 * can't be rendered or compared against geometry.
 */
const finiteNumber = z.number().finite();

const nonEmptyCappedString = (maxLength: number) => z.string().min(1).max(maxLength);

export const joinMessageSchema = z.object({
  type: z.literal("join"),
  roomId: nonEmptyCappedString(MAX_ROOM_ID_LENGTH),
  // null on first visit; a browser resuming a prior identity sends back the
  // token it was issued (FR-24).
  resumeToken: z.string().max(MAX_RESUME_TOKEN_LENGTH).nullable(),
});

export const renameMessageSchema = z.object({
  type: z.literal("rename"),
  name: nonEmptyCappedString(MAX_NAME_LENGTH),
});

export const grabMessageSchema = z.object({
  type: z.literal("grab"),
  groupId: nonEmptyCappedString(MAX_GROUP_ID_LENGTH),
});

export const moveMessageSchema = z.object({
  type: z.literal("move"),
  groupId: nonEmptyCappedString(MAX_GROUP_ID_LENGTH),
  x: finiteNumber,
  y: finiteNumber,
});

export const dropMessageSchema = z.object({
  type: z.literal("drop"),
  groupId: nonEmptyCappedString(MAX_GROUP_ID_LENGTH),
  x: finiteNumber,
  y: finiteNumber,
});

export const cursorMessageSchema = z.object({
  type: z.literal("cursor"),
  x: finiteNumber,
  y: finiteNumber,
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  joinMessageSchema,
  renameMessageSchema,
  grabMessageSchema,
  moveMessageSchema,
  dropMessageSchema,
  cursorMessageSchema,
]);

export type JoinMessage = z.infer<typeof joinMessageSchema>;
export type RenameMessage = z.infer<typeof renameMessageSchema>;
export type GrabMessage = z.infer<typeof grabMessageSchema>;
export type MoveMessage = z.infer<typeof moveMessageSchema>;
export type DropMessage = z.infer<typeof dropMessageSchema>;
export type CursorMessage = z.infer<typeof cursorMessageSchema>;

export type ClientMessage = z.infer<typeof clientMessageSchema>;
