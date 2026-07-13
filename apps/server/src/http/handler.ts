import { randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { MAX_PIECE_COUNT, MIN_PIECE_COUNT } from "@puzzlewithme/geometry";
import { MAX_NAME_LENGTH, type RoomSettings } from "@puzzlewithme/shared";
import { ensureUserDisplayName } from "../engine/names.js";
import { MAX_UPLOAD_BYTES } from "../images/constants.js";
import type { ImageStore } from "../images/image-store.js";
import { processUploadedImage, validatePieceGrid } from "../images/process-image.js";
import type { RoomStore } from "../store/room-store.js";
import { parseBoundary, parseMultipart } from "./multipart.js";

export interface HttpHandlerDeps {
  roomStore: RoomStore;
  imageStore: ImageStore;
}

// Body-size cap: MAX_UPLOAD_BYTES bounds the image itself, but the multipart
// envelope adds headers/boundaries/the pieces field around it. 64 KiB of slack
// is far more than that overhead needs (boundaries and headers are at most a
// few hundred bytes) while still rejecting a body that's lying about size.
const MULTIPART_OVERHEAD_BUDGET_BYTES = 64 * 1024;

// Matches the join schema's MAX_USER_ID_LENGTH: a UUID is 36 chars, 128 caps a
// malicious oversized field on the create form while leaving room to grow.
const MAX_USER_ID_LENGTH = 128;

// Caps a user-chosen session name. 80 chars fits any reasonable title on one
// list row while bounding what a malicious client can store; picked to match
// the room list UI, not measured.
const MAX_ROOM_NAME_LENGTH = 80;

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

/**
 * URL-safe, >=128 bits of entropy: base64url of 16 random bytes, no
 * dashes/padding to worry about in a URL path segment. Used for both room
 * ids (FR-5's unguessability credential) and image ids, which need the same
 * property — an image URL is only as private as the id is unguessable.
 */
function generateId(): string {
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

/** One piece-count rule for both create paths (upload and from-gallery). */
function parsePieceCount(raw: unknown): number | null {
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_PIECE_COUNT || value > MAX_PIECE_COUNT) {
    return null;
  }
  return value;
}

/**
 * POST /api/rooms dispatches on content type: multipart/form-data carries a
 * fresh image upload, application/json references an already-uploaded gallery
 * image by id (no bytes to re-send).
 */
async function handleCreateRoom(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerDeps): Promise<void> {
  const rawContentType = req.headers["content-type"];
  const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
  const boundary = parseBoundary(contentType);
  if (boundary !== null) {
    await handleCreateRoomFromUpload(req, res, deps, boundary);
    return;
  }
  if (contentType !== undefined && contentType.toLowerCase().startsWith("application/json")) {
    await handleCreateRoomFromGallery(req, res, deps);
    return;
  }
  sendJson(res, 400, {
    error: "expected multipart/form-data with a boundary (new upload) or application/json (create from a gallery image)",
  });
}

async function handleCreateRoomFromUpload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  boundary: string,
): Promise<void> {
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
  const piecesPart = parts.find((part) => part.name === "pieces");

  if (imagePart === undefined || imagePart.filename === undefined) {
    sendJson(res, 400, { error: "missing required \"image\" file field" });
    return;
  }
  if (piecesPart === undefined) {
    sendJson(res, 400, { error: "missing required \"pieces\" field" });
    return;
  }

  const piecesValue = parsePieceCount(piecesPart.data.toString("utf8"));
  if (piecesValue === null) {
    sendJson(res, 400, {
      error: `pieces must be an integer between ${MIN_PIECE_COUNT} and ${MAX_PIECE_COUNT}`,
    });
    return;
  }

  const processed = await processUploadedImage(imagePart.data, piecesValue);
  if (!processed.ok) {
    sendJson(res, 400, { error: processed.reason });
    return;
  }

  // Reuse the grid processUploadedImage already validated the ≥50px-per-cell
  // floor against, rather than re-deriving from processed.image's dimensions
  // (see ProcessedImage.grid for why those can disagree by a rounding hair).
  const { rows, cols } = processed.image.grid;
  const roomId = generateId();
  // The image gets its own id (not the room's): gallery reuse means one
  // image can back many rooms, so the two identities must be independent.
  const imageRef = generateId();
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

  // Record the creator's session history and gallery entry. Best-effort and
  // after create succeeds: neither write may fail room creation or orphan the
  // created room, so each is isolated in its own try/catch.
  const userId = parts.find((part) => part.name === "userId")?.data.toString("utf8").trim();
  if (userId !== undefined && userId.length > 0 && userId.length <= MAX_USER_ID_LENGTH) {
    try {
      await deps.roomStore.recordMembership(roomId, userId, true);
    } catch (err) {
      console.error(`recording creator membership failed for room ${roomId}`, err);
    }
    try {
      await deps.roomStore.recordImage(imageRef, userId, processed.image.originalWidth, processed.image.originalHeight);
    } catch (err) {
      console.error(`recording gallery image failed for image ${imageRef}`, err);
    }
  }

  sendJson(res, 201, { roomId, rows, cols });
}

// Create-from-gallery body cap: a small JSON object of ids and a piece
// count; 4 KiB rejects anything that isn't plausibly that shape.
const MAX_CREATE_FROM_GALLERY_BODY_BYTES = 4 * 1024;

/**
 * POST /api/rooms with a JSON body {imageId, pieces, userId}: a new room
 * from an image the user already uploaded. Ownership-checked via
 * getUserImage, so someone else's image id (even leaked) can't be reused.
 * The piece count is re-validated against the upload's original dimensions —
 * the same validatePieceGrid check the first upload passed — since it can
 * differ from the original room's.
 */
async function handleCreateRoomFromGallery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
): Promise<void> {
  const bodyResult = await readBody(req, MAX_CREATE_FROM_GALLERY_BODY_BYTES);
  if (!bodyResult.ok) {
    sendJson(res, bodyResult.reason === "too_large" ? 413 : 400, { error: "invalid request body" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyResult.body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "body must be JSON" });
    return;
  }
  const shapeError = "body must be {\"imageId\": string, \"pieces\": number, \"userId\": string}";
  if (typeof parsed !== "object" || parsed === null) {
    sendJson(res, 400, { error: shapeError });
    return;
  }
  const { imageId, pieces, userId } = parsed as { imageId?: unknown; pieces?: unknown; userId?: unknown };
  if (
    typeof imageId !== "string" || imageId.length === 0 || imageId.length > MAX_USER_ID_LENGTH ||
    typeof userId !== "string" || userId.length === 0 || userId.length > MAX_USER_ID_LENGTH
  ) {
    sendJson(res, 400, { error: shapeError });
    return;
  }
  const piecesValue = parsePieceCount(pieces);
  if (piecesValue === null) {
    sendJson(res, 400, {
      error: `pieces must be an integer between ${MIN_PIECE_COUNT} and ${MAX_PIECE_COUNT}`,
    });
    return;
  }

  const image = await deps.roomStore.getUserImage(imageId, userId);
  if (image === null) {
    sendJson(res, 404, { error: "image_not_found" });
    return;
  }
  const gridResult = validatePieceGrid(piecesValue, image.width, image.height);
  if (!gridResult.ok) {
    sendJson(res, 400, { error: gridResult.reason });
    return;
  }

  const { rows, cols } = gridResult.grid;
  const roomId = generateId();
  const settings: RoomSettings = {
    roomId,
    imageRef: imageId,
    rows,
    cols,
    seed: generateSeed(),
    status: "active",
  };
  // No image write here — the bytes already exist under imageId; this room
  // just shares them.
  await deps.roomStore.create(settings);

  // Same best-effort creator record as the upload path.
  try {
    await deps.roomStore.recordMembership(roomId, userId, true);
  } catch (err) {
    console.error(`recording creator membership failed for room ${roomId}`, err);
  }

  sendJson(res, 201, { roomId, rows, cols });
}

async function handleListUserImages(res: ServerResponse, deps: HttpHandlerDeps, userId: string): Promise<void> {
  const images = await deps.roomStore.listUserImages(userId);
  sendJson(res, 200, { images });
}

/** DELETE /api/users/:userId/images/:imageId — remove the gallery entry only; rooms keep rendering the bytes (see RoomStore.deleteUserImage). */
async function handleDeleteUserImage(
  res: ServerResponse,
  deps: HttpHandlerDeps,
  userId: string,
  imageId: string,
): Promise<void> {
  const deleted = await deps.roomStore.deleteUserImage(imageId, userId);
  if (!deleted) {
    sendJson(res, 404, { error: "image_not_found" });
    return;
  }
  sendJson(res, 200, { imageId, deleted: true });
}

/**
 * GET /api/images/:imageId — the stored bytes, for gallery thumbnails and
 * previews. Access control is the id's unguessability, exactly like room
 * ids (FR-5); no ownership check, matching the room-image route (anyone a
 * room link is shared with can already fetch the same bytes there).
 */
async function handleGetImage(res: ServerResponse, deps: HttpHandlerDeps, imageId: string): Promise<void> {
  const image = await deps.imageStore.get(imageId);
  if (image === null) {
    sendJson(res, 404, { error: "image_not_found" });
    return;
  }
  res.writeHead(200, {
    "content-type": image.contentType,
    // Stored bytes under an id never change (ids are minted per upload), so
    // the same immutable policy as the room-image route applies.
    "cache-control": "public, max-age=31536000, immutable",
  });
  res.end(image.bytes);
}

async function handleListUserRooms(res: ServerResponse, deps: HttpHandlerDeps, userId: string): Promise<void> {
  const rooms = await deps.roomStore.listUserRooms(userId);
  sendJson(res, 200, { rooms });
}

// Rename body cap: the payload is one short string; 4 KiB rejects anything
// that isn't a plausible {"name": ...} without buffering junk.
const MAX_RENAME_BODY_BYTES = 4 * 1024;

/**
 * PATCH /api/users/:userId/rooms/:roomId — set or clear (name: null) the
 * user's personal label for a room in their session list. 404 when the user
 * has no membership in the room, so a rename can't create history.
 */
async function handleRenameUserRoom(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  userId: string,
  roomId: string,
): Promise<void> {
  const bodyResult = await readBody(req, MAX_RENAME_BODY_BYTES);
  if (!bodyResult.ok) {
    sendJson(res, bodyResult.reason === "too_large" ? 413 : 400, { error: "invalid request body" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyResult.body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "body must be JSON" });
    return;
  }
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) {
    sendJson(res, 400, { error: "body must be {\"name\": string | null}" });
    return;
  }
  const raw = (parsed as { name: unknown }).name;
  let name: string | null;
  if (raw === null) {
    name = null;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_ROOM_NAME_LENGTH) {
      sendJson(res, 400, { error: `name must be 1-${MAX_ROOM_NAME_LENGTH} characters (or null to clear)` });
      return;
    }
    name = trimmed;
  } else {
    sendJson(res, 400, { error: "body must be {\"name\": string | null}" });
    return;
  }

  const renamed = await deps.roomStore.setRoomName(roomId, userId, name);
  if (!renamed) {
    sendJson(res, 404, { error: "room_not_found" });
    return;
  }
  sendJson(res, 200, { roomId, name });
}

/**
 * GET /api/users/:userId/profile — the display name, minting and persisting a
 * random one for a never-seen uid (a user "exists" from their first profile
 * fetch or room join, and always has a name). The length guard keeps a
 * probing client from writing unbounded junk rows through a read endpoint.
 */
async function handleGetUserProfile(res: ServerResponse, deps: HttpHandlerDeps, userId: string): Promise<void> {
  if (userId.length > MAX_USER_ID_LENGTH) {
    sendJson(res, 400, { error: `userId must be at most ${MAX_USER_ID_LENGTH} characters` });
    return;
  }
  const displayName = await ensureUserDisplayName(deps.roomStore, userId);
  sendJson(res, 200, { displayName });
}

/**
 * PATCH /api/users/:userId/profile — set the app-wide display name (users
 * table), applied to future room joins (an already-open room keeps whatever
 * name it captured at join time; see engine/room.ts's join()). Cheap by
 * design, unlike changing the userId itself: renaming carries no history
 * cost, so there's no confirmation step and no cap on how often it's called.
 */
async function handleSetUserProfile(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpHandlerDeps,
  userId: string,
): Promise<void> {
  const bodyResult = await readBody(req, MAX_RENAME_BODY_BYTES);
  if (!bodyResult.ok) {
    sendJson(res, bodyResult.reason === "too_large" ? 413 : 400, { error: "invalid request body" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyResult.body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "body must be JSON" });
    return;
  }
  const raw = typeof parsed === "object" && parsed !== null ? (parsed as { displayName?: unknown }).displayName : undefined;
  if (typeof raw !== "string") {
    sendJson(res, 400, { error: "body must be {\"displayName\": string}" });
    return;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    sendJson(res, 400, { error: `displayName must be 1-${MAX_NAME_LENGTH} characters` });
    return;
  }
  await deps.roomStore.setUserDisplayName(userId, trimmed);
  sendJson(res, 200, { displayName: trimmed });
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

  const userRoomsMatch = /^\/api\/users\/([^/]+)\/rooms$/.exec(url.pathname);
  if (userRoomsMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    await handleListUserRooms(res, deps, decodeURIComponent(userRoomsMatch[1] ?? ""));
    return;
  }

  const userProfileMatch = /^\/api\/users\/([^/]+)\/profile$/.exec(url.pathname);
  if (userProfileMatch !== null) {
    const userId = decodeURIComponent(userProfileMatch[1] ?? "");
    if (method === "GET") {
      await handleGetUserProfile(res, deps, userId);
      return;
    }
    if (method === "PATCH") {
      await handleSetUserProfile(req, res, deps, userId);
      return;
    }
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  const userImagesMatch = /^\/api\/users\/([^/]+)\/images$/.exec(url.pathname);
  if (userImagesMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    await handleListUserImages(res, deps, decodeURIComponent(userImagesMatch[1] ?? ""));
    return;
  }

  const userImageMatch = /^\/api\/users\/([^/]+)\/images\/([^/]+)$/.exec(url.pathname);
  if (userImageMatch !== null) {
    if (method !== "DELETE") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    await handleDeleteUserImage(
      res,
      deps,
      decodeURIComponent(userImageMatch[1] ?? ""),
      decodeURIComponent(userImageMatch[2] ?? ""),
    );
    return;
  }

  const standaloneImageMatch = /^\/api\/images\/([^/]+)$/.exec(url.pathname);
  if (standaloneImageMatch !== null) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    await handleGetImage(res, deps, decodeURIComponent(standaloneImageMatch[1] ?? ""));
    return;
  }

  const userRoomMatch = /^\/api\/users\/([^/]+)\/rooms\/([^/]+)$/.exec(url.pathname);
  if (userRoomMatch !== null) {
    if (method !== "PATCH") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    await handleRenameUserRoom(
      req,
      res,
      deps,
      decodeURIComponent(userRoomMatch[1] ?? ""),
      decodeURIComponent(userRoomMatch[2] ?? ""),
    );
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
