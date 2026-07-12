"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiBase } from "../src/config";
import { loadOrCreateUserId } from "../src/sync";

const TIERS = [100, 250, 500, 1000] as const;
type Tier = (typeof TIERS)[number];

const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

/** Mirrors the server's UserRoomSummary (apps/server/src/store/room-store.ts). */
interface SessionRoom {
  roomId: string;
  status: "active" | "completed";
  createdByUser: boolean;
  createdAt: string;
  lastActiveAt: string;
  placedPieces: number;
  totalPieces: number;
}

export default function CreatePage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [tier, setTier] = useState<Tier>(100);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const objectUrlRef = useRef<string | null>(null);
  // Resolved on the client only (localStorage is unavailable during SSR).
  const [userId, setUserId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRoom[]>([]);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  useEffect(() => {
    const id = loadOrCreateUserId();
    setUserId(id);
    if (id === null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/users/${encodeURIComponent(id)}/rooms`);
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
  }, []);

  function onPick(picked: File | null): void {
    setError(null);
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (!picked) {
      setFile(null);
      setPreviewUrl(null);
      return;
    }
    if (!ACCEPTED.includes(picked.type)) {
      setFile(null);
      setPreviewUrl(null);
      setError("Please choose a JPEG, PNG, or WebP image.");
      return;
    }
    const url = URL.createObjectURL(picked);
    objectUrlRef.current = url;
    setFile(picked);
    setPreviewUrl(url);
  }

  async function onCreate(): Promise<void> {
    if (!file || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("image", file);
      body.append("tier", String(tier));
      // Lets the server record this browser as the room's creator (session history).
      if (userId !== null) body.append("userId", userId);
      const res = await fetch(`${apiBase}/api/rooms`, { method: "POST", body });
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

  return (
    <main className="create-shell">
      <div className="create-card">
        <h1>PuzzleWithMe</h1>
        <p className="tagline">Turn any image into a jigsaw and solve it together.</p>

        <div className="field">
          <label htmlFor="image">Image</label>
          <div className="dropzone">
            <input
              id="image"
              type="file"
              accept={ACCEPTED.join(",")}
              onChange={(e) => onPick(e.target.files?.[0] ?? null)}
            />
            {!file && <div style={{ marginTop: 8 }}>JPEG, PNG, or WebP</div>}
          </div>
          {previewUrl && (
            <div className="preview">
              {/* Local object URL preview; next/image adds no value for a blob. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="Selected puzzle preview" />
            </div>
          )}
        </div>

        <div className="field">
          <label>Pieces</label>
          <div className="tiers">
            {TIERS.map((t) => (
              <button
                key={t}
                type="button"
                className={`tier${t === tier ? " selected" : ""}`}
                onClick={() => setTier(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <button className="create-btn" disabled={!file || submitting} onClick={onCreate}>
          {submitting ? "Creating…" : "Create puzzle"}
        </button>

        {error && <div className="error-banner">{error}</div>}
      </div>

      {sessions.length > 0 && (
        <div className="sessions-card">
          <h2>Your puzzles</h2>
          <ul className="sessions-list">
            {sessions.map((s) => {
              const pct = s.totalPieces > 0 ? Math.round((s.placedPieces / s.totalPieces) * 100) : 0;
              return (
                <li key={s.roomId}>
                  <button
                    type="button"
                    className="session-row"
                    onClick={() => router.push(`/room/${encodeURIComponent(s.roomId)}`)}
                  >
                    <div className="session-head">
                      <span className="session-name">
                        {s.createdByUser ? "Created" : "Joined"}
                        {s.status === "completed" && <span className="session-done"> · done</span>}
                      </span>
                      <span className="session-count">
                        {s.placedPieces} / {s.totalPieces}
                      </span>
                    </div>
                    <div className="session-bar">
                      <div className="session-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="session-when">{new Date(s.lastActiveAt).toLocaleString()}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </main>
  );
}
