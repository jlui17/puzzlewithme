"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiBase } from "../src/config";

const TIERS = [100, 250, 500, 1000] as const;
type Tier = (typeof TIERS)[number];

const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

export default function CreatePage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [tier, setTier] = useState<Tier>(100);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
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
    </main>
  );
}
