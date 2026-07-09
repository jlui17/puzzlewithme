/**
 * Entry point for validating inbound client messages (NFR-7: "the server
 * rejects... malformed events"). Wraps zod's result rather than exposing
 * `SafeParseReturnType` directly, so callers depend on this package's own
 * result shape instead of zod's — swapping validation libraries later
 * wouldn't change the call site.
 */
import { type ClientMessage, clientMessageSchema } from "./client-messages.js";

export type ParseClientMessageResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

export function parseClientMessage(raw: unknown): ParseClientMessageResult {
  const result = clientMessageSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  return { ok: false, error: result.error.message };
}
