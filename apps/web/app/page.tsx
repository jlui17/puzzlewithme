"use client";

import { deriveGrid, MAX_PIECE_COUNT, MIN_PIECE_COUNT } from "@puzzlewithme/geometry";
import { MAX_NAME_LENGTH } from "@puzzlewithme/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiBase } from "../src/config";
import { loadOrCreateUserId } from "../src/sync";

const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

// Matches the server's MAX_ROOM_NAME_LENGTH (http/handler.ts) so the input
// can't produce a value the PATCH would reject.
const MAX_SESSION_NAME_LENGTH = 80;

/**
 * Mirrors the server's UserImageSummary (apps/server/src/store/room-store.ts).
 * width/height are the original upload's dimensions, so running deriveGrid on
 * them previews exactly the grid the server will validate against.
 */
interface GalleryImage {
  imageId: string;
  createdAt: string;
  width: number;
  height: number;
}

/** Mirrors the server's UserRoomSummary (apps/server/src/store/room-store.ts). */
interface SessionRoom {
  roomId: string;
  status: "active" | "completed";
  createdByUser: boolean;
  createdAt: string;
  lastActiveAt: string;
  placedPieces: number;
  totalPieces: number;
  name: string | null;
}

export default function CreatePage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageDims, setImageDims] = useState<{ width: number; height: number } | null>(null);
  const [target, setTarget] = useState(250);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const objectUrlRef = useRef<string | null>(null);
  // The native file input keeps showing its chosen filename even after React
  // state moves to a gallery pick; clearing needs a direct .value reset.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Resolved on the client only (localStorage is unavailable during SSR).
  const [userId, setUserId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRoom[]>([]);
  const [gallery, setGallery] = useState<GalleryImage[]>([]);
  // A gallery image chosen as the next puzzle's source; mutually exclusive
  // with `file` (picking either clears the other).
  const [galleryPick, setGalleryPick] = useState<GalleryImage | null>(null);

  useEffect(() => {
    setUserId(loadOrCreateUserId());
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  // Runs once the client-only userId resolves (null during SSR/first paint).
  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/users/${encodeURIComponent(userId)}/rooms`);
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { rooms: SessionRoom[] };
        if (!cancelled) setSessions(data.rooms);
      } catch {
        // Session history is a convenience; a fetch failure just hides the list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/users/${encodeURIComponent(userId)}/images`);
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { images: GalleryImage[] };
        if (!cancelled) setGallery(data.images);
      } catch {
        // The gallery is a convenience; a fetch failure just hides it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // The same deriveGrid the server runs on the original upload's dimensions,
  // so the count shown here is exactly the count the room will have.
  const grid = useMemo(
    () => (imageDims === null ? null : deriveGrid(target, imageDims.width, imageDims.height)),
    [imageDims, target],
  );

  function onPick(picked: File | null): void {
    // A canceled file dialog reports no file; keep the current selection —
    // with the hidden-input picker there's nothing to "clear" to.
    if (!picked) return;
    setError(null);
    setGalleryPick(null);
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setImageDims(null);
    if (!ACCEPTED.includes(picked.type)) {
      setFile(null);
      setPreviewUrl(null);
      // Reset the input so re-picking the same (rejected) file still fires
      // a change event on the retry.
      if (fileInputRef.current) fileInputRef.current.value = "";
      setError("Please choose a JPEG, PNG, or WebP image.");
      return;
    }
    const url = URL.createObjectURL(picked);
    objectUrlRef.current = url;
    setFile(picked);
    setPreviewUrl(url);
    const probe = new Image();
    probe.onload = () => {
      // Ignore a slow decode of an image the user already replaced.
      if (objectUrlRef.current === url) {
        setImageDims({ width: probe.naturalWidth, height: probe.naturalHeight });
      }
    };
    probe.src = url;
  }

  function onPickFromGallery(img: GalleryImage): void {
    setError(null);
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setGalleryPick(img);
    setPreviewUrl(`${apiBase}/api/images/${encodeURIComponent(img.imageId)}`);
    // Original-upload dimensions from the gallery record, so the piece-count
    // preview matches what the server will validate — no probe needed.
    setImageDims({ width: img.width, height: img.height });
  }

  async function onDeleteImage(img: GalleryImage): Promise<void> {
    if (userId === null) return;
    if (!window.confirm("Remove this image from your gallery? Puzzles already made from it keep working.")) return;
    try {
      const res = await fetch(
        `${apiBase}/api/users/${encodeURIComponent(userId)}/images/${encodeURIComponent(img.imageId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) return;
      setGallery((prev) => prev.filter((g) => g.imageId !== img.imageId));
      if (galleryPick?.imageId === img.imageId) {
        setGalleryPick(null);
        setPreviewUrl(null);
        setImageDims(null);
      }
    } catch {
      // Leave the gallery as is; the entry reappears correct on next load.
    }
  }

  async function onCreate(): Promise<void> {
    if ((file === null && galleryPick === null) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let res: Response;
      if (galleryPick !== null && userId !== null) {
        // Reuse an already-uploaded image: JSON body, no bytes re-sent.
        res = await fetch(`${apiBase}/api/rooms`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ imageId: galleryPick.imageId, pieces: target, userId }),
        });
      } else if (file !== null) {
        const body = new FormData();
        body.append("image", file);
        body.append("pieces", String(target));
        // Lets the server record this browser as the room's creator (session
        // history) and the image's uploader (gallery).
        if (userId !== null) body.append("userId", userId);
        res = await fetch(`${apiBase}/api/rooms`, { method: "POST", body });
      } else {
        setSubmitting(false);
        return;
      }
      if (res.status === 201) {
        const { roomId } = (await res.json()) as { roomId: string };
        router.push(`/room/${encodeURIComponent(roomId)}`);
        return;
      }
      // Surface the server's human-readable reason inline (FR-1).
      let message = `Room creation failed (${res.status}).`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // Non-JSON error body; keep the status-based fallback.
      }
      setError(message);
      setSubmitting(false);
    } catch {
      setError("Could not reach the server. Is it running?");
      setSubmitting(false);
    }
  }

  async function onRenameSession(roomId: string, name: string | null): Promise<boolean> {
    if (userId === null) return false;
    try {
      const res = await fetch(
        `${apiBase}/api/users/${encodeURIComponent(userId)}/rooms/${encodeURIComponent(roomId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      if (!res.ok) return false;
      setSessions((prev) => prev.map((s) => (s.roomId === roomId ? { ...s, name } : s)));
      return true;
    } catch {
      return false;
    }
  }

  return (
    <main className="create-shell">
      <header className="menu-header">
        <h1>PuzzleWithMe</h1>
        <p className="tagline">Turn any image into a jigsaw and solve it together.</p>
      </header>

      <div className="create-card">
        <div className="field">
          <span className="field-label" id="image-picker-label">
            Image
          </span>
          {/* The real input stays hidden; the upload tile below triggers it so
              new-upload and reuse-from-gallery are peers in one picker. */}
          <input
            type="file"
            ref={fileInputRef}
            accept={ACCEPTED.join(",")}
            style={{ display: "none" }}
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />
          <div className="picker-grid" role="group" aria-labelledby="image-picker-label">
            <button
              type="button"
              className={file !== null ? "picker-tile picker-upload picker-tile--selected" : "picker-tile picker-upload"}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                onPick(e.dataTransfer.files?.[0] ?? null);
              }}
            >
              <span className="picker-upload-plus" aria-hidden="true">
                +
              </span>
              <span className="picker-upload-text">{file !== null ? file.name : "Upload"}</span>
            </button>
            {gallery.map((img) => {
              const selected = galleryPick?.imageId === img.imageId;
              return (
                <div key={img.imageId} className={selected ? "picker-item picker-item--selected" : "picker-item"}>
                  <button
                    type="button"
                    className="picker-tile picker-photo"
                    aria-pressed={selected}
                    aria-label="Use this image for a new puzzle"
                    onClick={() => onPickFromGallery(img)}
                  >
                    {/* Same-origin API thumbnail; next/image adds no value here. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`${apiBase}/api/images/${encodeURIComponent(img.imageId)}`} alt="" loading="lazy" />
                  </button>
                  <button
                    type="button"
                    className="picker-delete"
                    aria-label="Delete this image from your gallery"
                    title="Delete from gallery"
                    onClick={() => onDeleteImage(img)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          {previewUrl ? (
            <div className="preview">
              {/* Local object URL or same-origin API route; next/image adds no value for either. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="Selected puzzle preview" />
            </div>
          ) : (
            <p className="picker-hint">
              {gallery.length > 0
                ? "Upload a JPEG, PNG, or WebP — or tap one of your previous images to reuse it."
                : "Upload a JPEG, PNG, or WebP. Images you upload stay in your gallery for reuse."}
            </p>
          )}
        </div>

        <div className="field">
          <div className="slider-head">
            <label htmlFor="pieces">Pieces</label>
            <span className="slider-value">{target}</span>
          </div>
          <input
            id="pieces"
            type="range"
            className="pieces-slider"
            min={MIN_PIECE_COUNT}
            max={MAX_PIECE_COUNT}
            step={10}
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
          />
          <div className="slider-note">
            {grid !== null ? (
              grid.rows * grid.cols === target ? (
                <>
                  Exactly <strong>{target}</strong> pieces ({grid.cols} × {grid.rows})
                </>
              ) : (
                <>
                  You&apos;ll get <strong>{grid.rows * grid.cols}</strong> pieces ({grid.cols} ×{" "}
                  {grid.rows}) — the closest clean fit for this image
                </>
              )
            ) : (
              "Pick an image to see the exact piece count for its shape."
            )}
          </div>
        </div>

        <button className="create-btn" disabled={(!file && !galleryPick) || submitting} onClick={onCreate}>
          {submitting ? "Creating…" : "Create puzzle"}
        </button>

        {error && <div className="error-banner">{error}</div>}
      </div>

      {sessions.length > 0 && (
        <div className="sessions-card">
          <h2>Your puzzles</h2>
          <ul className="sessions-list">
            {sessions.map((s) => (
              <SessionRow
                key={s.roomId}
                session={s}
                onOpen={() => router.push(`/room/${encodeURIComponent(s.roomId)}`)}
                onRename={(name) => onRenameSession(s.roomId, name)}
              />
            ))}
          </ul>
        </div>
      )}

      {userId !== null && <IdentityCard userId={userId} />}
    </main>
  );
}

function SessionRow({
  session,
  onOpen,
  onRename,
}: {
  session: SessionRoom;
  onOpen: () => void;
  onRename: (name: string | null) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name ?? "");
  const [saving, setSaving] = useState(false);

  const pct =
    session.totalPieces > 0 ? Math.round((session.placedPieces / session.totalPieces) * 100) : 0;
  const fallbackTitle = `${session.createdByUser ? "Created" : "Joined"} ${new Date(
    session.createdAt,
  ).toLocaleDateString()}`;

  async function commit(): Promise<void> {
    const trimmed = draft.trim().slice(0, MAX_SESSION_NAME_LENGTH);
    const next = trimmed === "" ? null : trimmed;
    if (next === session.name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    await onRename(next);
    setSaving(false);
    setEditing(false);
  }

  return (
    <li className="session-row">
      <div
        className="session-main"
        role="button"
        tabIndex={0}
        onClick={editing ? undefined : onOpen}
        onKeyDown={(e) => {
          if (!editing && (e.key === "Enter" || e.key === " ")) onOpen();
        }}
      >
        <div className="session-head">
          {editing ? (
            <input
              className="session-name-input"
              autoFocus
              value={draft}
              maxLength={MAX_SESSION_NAME_LENGTH}
              placeholder={fallbackTitle}
              disabled={saving}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft(session.name ?? "");
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span className="session-name">
              {session.name ?? fallbackTitle}
              {session.status === "completed" && <span className="session-done"> · done</span>}
            </span>
          )}
          <span className="session-count">
            {session.placedPieces} / {session.totalPieces}
          </span>
        </div>
        <div className="session-bar">
          <div className="session-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="session-when">{new Date(session.lastActiveAt).toLocaleString()}</span>
      </div>
      <button
        type="button"
        className="session-rename"
        aria-label="Rename this puzzle"
        title="Rename"
        onClick={() => {
          setDraft(session.name ?? "");
          setEditing(true);
        }}
      >
        ✏️
      </button>
    </li>
  );
}

function IdentityCard({ userId }: { userId: string }) {
  const [copied, setCopied] = useState(false);

  // Server truth for the display name, keyed by userId. The GET is
  // get-or-create: a first-ever visit comes back with a freshly minted random
  // name, so this is only null before the fetch resolves (or if it fails).
  const [savedName, setSavedName] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [nameStatus, setNameStatus] = useState<"idle" | "saved" | "error">("idle");

  useEffect(() => {
    if (!copied) return;
    // Matches the Copy-button dwell used elsewhere in this file; long enough
    // to register, short enough not to linger.
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    setNameStatus("idle");
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/users/${encodeURIComponent(userId)}/profile`);
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { displayName: string | null };
        if (cancelled) return;
        setSavedName(data.displayName);
        setNameDraft(data.displayName ?? "");
      } catch {
        // Display name is a convenience; a fetch failure just leaves the field blank.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function commitName(): Promise<void> {
    const trimmed = nameDraft.trim();
    if (trimmed === "" || trimmed === (savedName ?? "")) {
      setNameDraft(savedName ?? "");
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/users/${encodeURIComponent(userId)}/profile`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: trimmed }),
      });
      if (!res.ok) {
        setNameStatus("error");
        return;
      }
      const data = (await res.json()) as { displayName: string };
      setSavedName(data.displayName);
      setNameDraft(data.displayName);
      setNameStatus("saved");
    } catch {
      setNameStatus("error");
    }
  }

  return (
    <div className="identity-card">
      <h2>You</h2>

      <div className="identity-section">
        <label className="identity-label" htmlFor="display-name">
          Display name
        </label>
        <input
          id="display-name"
          className="identity-name-input"
          value={nameDraft}
          maxLength={MAX_NAME_LENGTH}
          placeholder="Pick a name"
          onChange={(e) => {
            setNameDraft(e.target.value);
            setNameStatus("idle");
          }}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <p className="identity-hint">
          Shown to other players in every room. Change it any time — rooms you&apos;re already in
          keep your old name until you rejoin, since it&apos;s applied at join time.
        </p>
        {nameStatus === "saved" && <span className="identity-status">Saved</span>}
        {nameStatus === "error" && (
          <span className="identity-status identity-status--error">Couldn&apos;t save</span>
        )}
      </div>

      <div className="identity-section identity-section--secondary">
        <span className="identity-label">Player ID</span>
        <p className="identity-hint">
          The permanent ID your puzzles are tied to — it identifies this browser and can&apos;t be
          changed. Your display name is what everyone sees.
        </p>
        <div className="identity-row">
          <code className="identity-id">{userId}</code>
          <button
            type="button"
            className="identity-btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(userId);
                setCopied(true);
              } catch {
                // Clipboard can be unavailable (insecure context); the id is
                // visible on screen for manual copy.
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
