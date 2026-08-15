/**
 * The web client's REST surface: every fetch to the server goes through here,
 * typed by @puzzlewithme/shared's wire types. Failures come back as values
 * (result unions), never throws — callers decide whether a failure is silent
 * (the gallery is a convenience) or surfaced (room creation).
 */
import type { RoomInfoResponse, UserImageSummary, UserRoomSummary } from "@puzzlewithme/shared";
import { apiBase } from "./config";

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * What the next puzzle is made from: a fresh upload (with its object URL for
 * the preview) or an already-uploaded gallery image. One value, so upload and
 * gallery picks can't both be selected.
 */
export type Source =
  | { kind: "upload"; file: File; url: string }
  | { kind: "gallery"; image: UserImageSummary };

/** Same-origin URL of a stored image, for gallery thumbnails and previews. */
export function imageUrl(imageId: string): string {
  return `${apiBase}/api/images/${encodeURIComponent(imageId)}`;
}

async function getJson<T>(path: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${apiBase}${path}`);
    if (!res.ok) return { ok: false, error: `Server error (${res.status}).` };
    return { ok: true, value: (await res.json()) as T };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

export async function listRooms(userId: string): Promise<ApiResult<UserRoomSummary[]>> {
  const res = await getJson<{ rooms: UserRoomSummary[] }>(
    `/api/users/${encodeURIComponent(userId)}/rooms`,
  );
  return res.ok ? { ok: true, value: res.value.rooms } : res;
}

export async function listImages(userId: string): Promise<ApiResult<UserImageSummary[]>> {
  const res = await getJson<{ images: UserImageSummary[] }>(
    `/api/users/${encodeURIComponent(userId)}/images`,
  );
  return res.ok ? { ok: true, value: res.value.images } : res;
}

export async function deleteImage(userId: string, imageId: string): Promise<ApiResult<null>> {
  try {
    const res = await fetch(
      `${apiBase}/api/users/${encodeURIComponent(userId)}/images/${encodeURIComponent(imageId)}`,
      { method: "DELETE" },
    );
    if (!res.ok) return { ok: false, error: `Server error (${res.status}).` };
    return { ok: true, value: null };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

/**
 * Create a room from either source kind. A gallery source sends a JSON body
 * (no bytes re-sent); an upload sends multipart form data. `userId` lets the
 * server record this browser as the room's creator (session history) and the
 * image's uploader (gallery); null keeps the anonymous flow.
 */
export async function createRoom(
  source: Source,
  pieces: number,
  userId: string | null,
): Promise<ApiResult<{ roomId: string }>> {
  try {
    let res: Response;
    if (source.kind === "gallery") {
      res = await fetch(`${apiBase}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageId: source.image.imageId, pieces, userId }),
      });
    } else {
      const body = new FormData();
      body.append("image", source.file);
      body.append("pieces", String(pieces));
      if (userId !== null) body.append("userId", userId);
      res = await fetch(`${apiBase}/api/rooms`, { method: "POST", body });
    }
    if (res.status === 201) {
      return { ok: true, value: (await res.json()) as { roomId: string } };
    }
    // Surface the server's human-readable reason inline (FR-1).
    let message = `Room creation failed (${res.status}).`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Non-JSON error body; keep the status-based fallback.
    }
    return { ok: false, error: message };
  } catch {
    return { ok: false, error: "Could not reach the server. Is it running?" };
  }
}

export async function renameRoom(
  userId: string,
  roomId: string,
  name: string | null,
): Promise<ApiResult<null>> {
  try {
    const res = await fetch(
      `${apiBase}/api/users/${encodeURIComponent(userId)}/rooms/${encodeURIComponent(roomId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    if (!res.ok) return { ok: false, error: `Server error (${res.status}).` };
    return { ok: true, value: null };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

/** Distinguishes not_found from other failures: the room page shows different screens for each. */
export type RoomLookup =
  | { kind: "ready"; info: RoomInfoResponse }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

export async function getRoom(roomId: string): Promise<RoomLookup> {
  try {
    const res = await fetch(`${apiBase}/api/rooms/${encodeURIComponent(roomId)}`);
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok) return { kind: "error", message: `Server error (${res.status}).` };
    return { kind: "ready", info: (await res.json()) as RoomInfoResponse };
  } catch {
    return { kind: "error", message: "Could not reach the server." };
  }
}

export async function getProfile(userId: string): Promise<ApiResult<{ displayName: string | null }>> {
  return getJson(`/api/users/${encodeURIComponent(userId)}/profile`);
}

export async function setDisplayName(
  userId: string,
  displayName: string,
): Promise<ApiResult<{ displayName: string }>> {
  try {
    const res = await fetch(`${apiBase}/api/users/${encodeURIComponent(userId)}/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (!res.ok) return { ok: false, error: `Server error (${res.status}).` };
    return { ok: true, value: (await res.json()) as { displayName: string } };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}
