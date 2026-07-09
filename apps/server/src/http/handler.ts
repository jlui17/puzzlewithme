import { randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { Tier } from "@puzzlewithme/geometry";
import type { RoomSettings } from "@puzzlewithme/shared";
import { MAX_UPLOAD_BYTES } from "../images/constants.js";
import type { ImageStore } from "../images/image-store.js";
import { processUploadedImage } from "../images/process-image.js";
import type { RoomStore } from "../store/room-store.js";
import { parseBoundary, parseMultipart } from "./multipart.js";

export interface HttpHandlerDeps {
  roomStore: RoomStore;
  imageStore: ImageStore;
}

// Body-size cap: MAX_UPLOAD_BYTES bounds the image itself, but the multipart
// envelope adds headers/boundaries/the tier field around it. 64 KiB of slack
// is far more than that overhead needs (boundaries and headers are at most a
// few hundred bytes) while still rejecting a body that's lying about size.
const MULTIPART_OVERHEAD_BUDGET_BYTES = 64 * 1024;

const VALID_TIERS: readonly Tier[] = [100, 250, 500, 1000];

function isValidTier(value: number): value is Tier {
  return (VALID_TIERS as readonly number[]).includes(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

type ReadBodyResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: "too_large" | "request_error" };

/** Reads the full request body, aborting once `limitBytes` is exceeded so a lying/huge upload can't grow memory unbounded. */
function readBody(req: IncomingMessage, limitBytes: number): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        finish({ ok: false, reason: "too_large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
    // A genuine socket/stream error, distinct from the "too_large" abort
    // above (which also fires "error" via req.destroy(), but has already
    // settled the promise by then so this branch only reaches real errors).
    req.on("error", () => finish({ ok: false, reason: "request_error" }));
  });
}

/** URL-safe, >=128 bits of entropy (FR-5): base64url of 16 random bytes, no dashes/padding to worry about in a URL path segment. */
function generateRoomId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Geometry only needs a 32-bit integer seed (see hashSeed); this isn't a
 * security boundary (FR-5's unguessability comes from roomId), just the
 * puzzle's determinism input, so 32 bits of randomness is plenty. Stored as
 * a decimal string because RoomSettings.seed is typed string.
 */
function generateSeed(): string {
  return String(randomInt(2 ** 32));
}

async function handleCreateRoom(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerDeps): Promise<void> {
  const contentType = req.headers["content-type"];
  const boundary = parseBoundary(Array.isArray(contentType) ? contentType[0] : contentType);
  if (boundary === null) {
    sendJson(res, 400, { error: "expected multipart/form-data with a boundary" });
    return;
  }

  const bodyResult = await readBody(req, MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BUDGET_BYTES);
  if (!bodyResult.ok) {
    if (bodyResult.reason === "too_large") {
      sendJson(res, 413, { error: "upload too large" });
    } else {
      sendJson(res, 400, { error: "request body could not be read" });
    }
    return;
  }

  const parts = parseMultipart(bodyResult.body, boundary);
  const imagePart = parts.find((part) => part.name === "image");
  const tierPart = parts.find((part) => part.name === "tier");

  if (imagePart === undefined || imagePart.filename === undefined) {
    sendJson(res, 400, { error: "missing required \"image\" file field" });
    return;
  }
  if (tierPart === undefined) {
    sendJson(res, 400, { error: "missing required \"tier\" field" });
    return;
  }

  const tierValue = Number(tierPart.data.toString("utf8").trim());
  if (!Number.isInteger(tierValue) || !isValidTier(tierValue)) {
    sendJson(res, 400, { error: `tier must be one of ${VALID_TIERS.join(", ")}` });
    return;
  }

  const processed = await processUploadedImage(imagePart.data, tierValue);
  if (!processed.ok) {
    sendJson(res, 400, { error: processed.reason });
    return;
  }

  // Reuse the grid processUploadedImage already validated the ≥50px-per-cell
  // floor against, rather than re-deriving from processed.image's dimensions
  // (see ProcessedImage.grid for why those can disagree by a rounding hair).
  const { rows, cols } = processed.image.grid;
  const roomId = generateRoomId();
  // One image per room, created together and never separately referenced,
  // so reusing roomId as the image id avoids minting a second identifier.
  const imageRef = roomId;
  const settings: RoomSettings = {
    roomId,
    imageRef,
    rows,
    cols,
    seed: generateSeed(),
    status: "active",
  };

  // Image before room, not the reverse: if create() fails, we've orphaned an
  // unreferenced image (harmless), but the opposite order could leave a room
  // pointing at an image that was never written (§9, "no partial rooms created").
  await deps.imageStore.put(imageRef, processed.image.bytes, processed.image.contentType);
  await deps.roomStore.create(settings);

  sendJson(res, 201, { roomId, rows, cols });
}

async function handleGetRoom(res: ServerResponse, deps: HttpHandlerDeps, roomId: string): Promise<void> {
  const state = await deps.roomStore.load(roomId);
  if (state === null) {
    sendJson(res, 404, { error: "room_not_found" });
    return;
  }
  sendJson(res, 200, { exists: true, status: state.settings.status, settings: state.settings });
}

async function handleGetRoomImage(res: ServerResponse, deps: HttpHandlerDeps, roomId: string): Promise<void> {
  const state = await deps.roomStore.load(roomId);
  if (state === null) {
    sendJson(res, 404, { error: "room_not_found" });
    return;
  }
  const image = await deps.imageStore.get(state.settings.imageRef);
  if (image === null) {
    sendJson(res, 404, { error: "image_not_found" });
    return;
  }
  res.writeHead(200, {
    "content-type": image.contentType,
    // The room's image never changes after creation (FR-4), so a
    // year-long immutable cache is safe and meets NFR-4's join-time budget
    // by letting repeat/CDN-fronted fetches skip revalidation entirely.
    "cache-control": "public, max-age=31536000, immutable",
  });
  res.end(image.bytes);
}

async function route(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerDeps): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://internal.invalid");

  if (method === "POST" && url.pathname === "/api/rooms") {
    await handleCreateRoom(req, res, deps);
    return;
  }

  const imageMatch = /^\/api\/rooms\/([^/]+)\/image$/.exec(url.pathname);
  if (imageMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    await handleGetRoomImage(res, deps, decodeURIComponent(imageMatch[1] ?? ""));
    return;
  }

  const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(url.pathname);
  if (roomMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    await handleGetRoom(res, deps, decodeURIComponent(roomMatch[1] ?? ""));
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

/**
 * Plain node:http request listener, not a full server: the (later) WS task
 * mounts this on the same http.Server it creates and attaches its own
 * `upgrade` handling alongside it.
 */
export function createHttpHandler(deps: HttpHandlerDeps): RequestListener {
  return (req, res) => {
    route(req, res, deps).catch((err: unknown) => {
      // A handler bug must never crash the process (NFR-7-adjacent: the
      // server stays up for every other room/request even if one request's
      // handling throws unexpectedly).
      console.error("unhandled error handling request", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      } else {
        res.end();
      }
    });
  };
}
