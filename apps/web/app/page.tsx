"use client";

import { deriveGrid, MAX_PIECE_COUNT, MIN_PIECE_COUNT } from "@puzzlewithme/geometry";
import {
  MAX_NAME_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  type UserImageSummary,
  type UserRoomSummary,
} from "@puzzlewithme/shared";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import * as api from "../src/api";
import type { Source } from "../src/api";
import { imageUrl, roomImageUrl } from "../src/config";
import { Cup } from "../src/scene/Cup";
import { Scene } from "../src/scene/Scene";
import { Sill } from "../src/scene/Sill";
import { HOME_TILT_DEG, Table } from "../src/scene/Table";
import { WindowBand } from "../src/scene/WindowBand";

const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
// How each print in the gallery lies on the table, by position, so no two neighbours sit alike.
const PRINT_TILTS_DEG = [-2, 1.5, -1, 2, -1.5];

export default function CreatePage() {
  const router = useRouter();
  // What the next puzzle is made from; one value, so upload and gallery picks
  // can't both be selected.
  const [source, setSource] = useState<Source | null>(null);
  const [imageDims, setImageDims] = useState<{ width: number; height: number } | null>(null);
  const [target, setTarget] = useState(250);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The live upload's object URL, for revocation and for ignoring a slow
  // probe of an image the user already replaced.
  const objectUrlRef = useRef<string | null>(null);
  // The native file input keeps showing its chosen filename even after React
  // state moves to a gallery pick; clearing needs a direct .value reset.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Resolved from the authenticated API after mount.
  const [userId, setUserId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<UserRoomSummary[]>([]);
  const [historyStatus, setHistoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [accountAttempt, setAccountAttempt] = useState(0);
  const [gallery, setGallery] = useState<UserImageSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api.getMe().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setUserId(result.value.userId);
        setError((previous) => previous === "Could not load your account. Reload to sign in again." ? null : previous);
      } else {
        setError("Could not load your account. Reload to sign in again.");
        setHistoryStatus("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountAttempt]);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  // Runs once the client-only userId resolves (null during SSR/first paint).
  // Gallery loading is independent of history retries.
  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    void api.listImages(userId).then((res) => {
      if (!cancelled && res.ok) setGallery(res.value);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    setHistoryStatus("loading");
    void api.listRooms(userId).then((res) => {
      if (cancelled) return;
      if (res.ok) setSessions(res.value);
      setHistoryStatus(res.ok ? "ready" : "error");
    });
    return () => { cancelled = true; };
  }, [userId, historyAttempt]);

  const unfinished = sessions.filter((s) => s.status !== "completed");
  const finished = sessions.filter((s) => s.status === "completed");
  const sessionList = (items: UserRoomSummary[]) => (
    <ul className="rows">
      {items.map((s) => (
        <SessionRow key={s.roomId} session={s} onRename={(name) => onRenameSession(s.roomId, name)} />
      ))}
    </ul>
  );

  // The same deriveGrid the server runs on the original upload's dimensions,
  // so the count shown here is exactly the count the room will have.
  const grid = useMemo(
    () => (imageDims === null ? null : deriveGrid(target, imageDims.width, imageDims.height)),
    [imageDims, target],
  );

  /** Swap the source, releasing whatever the old one held (object URL, input value). */
  function applySource(next: Source | null): void {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    // Reset the input so re-picking the same file still fires a change event.
    if (next?.kind !== "upload" && fileInputRef.current) fileInputRef.current.value = "";
    if (next?.kind === "upload") objectUrlRef.current = next.url;
    setSource(next);
    // A gallery record carries its original-upload dimensions, so the
    // piece-count preview matches what the server will validate — no probe
    // needed. An upload's dims arrive from the probe below.
    setImageDims(next?.kind === "gallery" ? { width: next.image.width, height: next.image.height } : null);
  }

  function onPick(picked: File | null): void {
    // A canceled file dialog reports no file; keep the current selection —
    // with the hidden-input picker there's nothing to "clear" to.
    if (!picked) return;
    setError(null);
    if (!ACCEPTED.includes(picked.type)) {
      applySource(null);
      setError("Please choose a JPEG, PNG, or WebP image.");
      return;
    }
    const url = URL.createObjectURL(picked);
    applySource({ kind: "upload", file: picked, url });
    const probe = new Image();
    probe.onload = () => {
      // Ignore a slow decode of an image the user already replaced.
      if (objectUrlRef.current === url) {
        setImageDims({ width: probe.naturalWidth, height: probe.naturalHeight });
      }
    };
    probe.src = url;
  }

  function onPickFromGallery(img: UserImageSummary): void {
    setError(null);
    applySource({ kind: "gallery", image: img });
  }

  async function onDeleteImage(img: UserImageSummary): Promise<void> {
    if (userId === null) return;
    if (!window.confirm("Remove this image from your gallery? Puzzles already made from it keep working.")) return;
    const res = await api.deleteImage(userId, img.imageId);
    // On failure, leave the gallery as is; the entry reappears correct on next load.
    if (!res.ok) return;
    setGallery((prev) => prev.filter((g) => g.imageId !== img.imageId));
    if (source?.kind === "gallery" && source.image.imageId === img.imageId) {
      applySource(null);
    }
  }

  async function onCreate(): Promise<void> {
    if (submitting) return;
    if (source === null) {
      setError("Pick a picture first. Upload one, or choose one from your gallery.");
      return;
    }
    // The gallery only loads for a resolved userId, so a gallery source
    // without one can't happen; guard anyway rather than send an unowned reuse.
    if (source.kind === "gallery" && userId === null) return;
    setSubmitting(true);
    setError(null);
    const res = await api.createRoom(source, target, userId);
    if (res.ok) {
      router.push(`/room/${encodeURIComponent(res.value.roomId)}`);
      return;
    }
    setError(res.error);
    setSubmitting(false);
  }

  async function onRenameSession(roomId: string, name: string | null): Promise<boolean> {
    if (userId === null) return false;
    const res = await api.renameRoom(userId, roomId, name);
    if (!res.ok) return false;
    setSessions((prev) => prev.map((s) => (s.roomId === roomId ? { ...s, name } : s)));
    return true;
  }

  const pieces = grid === null ? target : grid.rows * grid.cols;

  return (
    <Scene screen="home">
      <WindowBand />
      <Sill />
      <Table tilt={HOME_TILT_DEG} growWithContent>
        <div className="table-inner">
          <div className="start-col">
            <h2 className="section-title">Start a puzzle</h2>
            <p className="section-sub">
              Pick a picture, choose how many pieces, then send the link to whoever you want at the table.
            </p>

            <div className="field">
              <div className="field-head">
                <span className="field-label" id="prints-label">
                  Pick a picture
                </span>
              </div>
              {/* The real input stays hidden; the upload tile below triggers it so
                  new-upload and reuse-from-gallery are peers in one picker. */}
              <input
                type="file"
                ref={fileInputRef}
                accept={ACCEPTED.join(",")}
                style={{ display: "none" }}
                onChange={(e) => onPick(e.target.files?.[0] ?? null)}
              />
              <div className="prints" role="group" aria-labelledby="prints-label">
                <div className="print">
                  <button
                    type="button"
                    className="print-tile print-upload"
                    aria-pressed={source?.kind === "upload"}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      onPick(e.dataTransfer.files?.[0] ?? null);
                    }}
                  >
                    <span className="print-paper">
                      {source?.kind === "upload" ? (
                        // The picked file's own thumbnail: with no separate preview
                        // pane, the selected tile is the only confirmation of what
                        // you're about to start.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={source.url} alt={`Selected: ${source.file.name}`} />
                      ) : (
                        <>
                          <span className="plus" aria-hidden="true">
                            +
                          </span>
                          Upload a picture
                        </>
                      )}
                      <span className="print-check" aria-hidden="true">
                        ✓
                      </span>
                    </span>
                  </button>
                  <span className="print-caption">{source?.kind === "upload" ? "Chosen" : "JPEG, PNG or WebP"}</span>
                </div>
                {gallery.map((img, index) => {
                  const selected = source?.kind === "gallery" && source.image.imageId === img.imageId;
                  return (
                    <div key={img.imageId} className="print" style={{ "--tilt": `${PRINT_TILTS_DEG[index % PRINT_TILTS_DEG.length]}deg` } as CSSProperties}>
                      <button
                        type="button"
                        className="print-tile"
                        aria-pressed={selected}
                        aria-label="Use this picture for a new puzzle"
                        onClick={() => (selected ? applySource(null) : onPickFromGallery(img))}
                      >
                        <span className="print-paper">
                          {/* Same-origin API thumbnail; next/image adds no value here. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={api.imageUrl(img.imageId)} alt="" loading="lazy" />
                          <span className="print-check" aria-hidden="true">
                            ✓
                          </span>
                        </span>
                      </button>
                      {/* Hidden by CSS while this print is chosen: the check mark takes its corner. */}
                      <button
                        type="button"
                        className="print-delete"
                        aria-label="Remove this picture from your gallery"
                        title="Remove from gallery"
                        onClick={() => onDeleteImage(img)}
                      >
                        ×
                      </button>
                      <span className="print-caption">{selected ? "Chosen" : ""}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="field">
              <div className="field-head">
                <label className="field-label" htmlFor="pieces">
                  How many pieces
                </label>
                <span className="field-count">{pieces}</span>
              </div>
              <input
                id="pieces"
                type="range"
                className="pieces"
                min={MIN_PIECE_COUNT}
                max={MAX_PIECE_COUNT}
                step={10}
                value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
              />
              <p className="field-note">
                {grid !== null
                  ? grid.rows * grid.cols === target
                    ? `Exactly ${target}, laid out ${grid.cols} across and ${grid.rows} down.`
                    : `Closest clean fit for this picture: ${grid.cols} across, ${grid.rows} down.`
                  : source?.kind === "upload"
                    ? "The exact count follows your picture's shape once it has uploaded."
                    : "Pick a picture to see the exact count for its shape."}
              </p>
            </div>

            <div className="start-row">
              <button
                type="button"
                className={source === null ? "start-btn is-quiet" : "start-btn"}
                aria-disabled={source === null}
                disabled={userId === null || submitting}
                onClick={onCreate}
              >
                {submitting ? "Setting the table…" : "Start the puzzle"}
              </button>
              <p className="start-hint">Then send the link to whoever you want at the table.</p>
            </div>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
          </div>

          <aside className="left-col" aria-labelledby="history-heading" aria-busy={historyStatus === "loading"}>
            <h2 id="history-heading" className="section-title">
              Left on the table
            </h2>
            <p className="section-sub">Puzzles you started or joined.</p>
            {historyStatus === "loading" && (
              <p className="empty-note" role="status">
                Loading your puzzles…
              </p>
            )}
            {historyStatus === "error" && (
              <div className="empty-note" role="alert">
                Couldn&apos;t load your puzzles.{" "}
                <button
                  type="button"
                  className="history-retry"
                  onClick={() => {
                    setHistoryStatus("loading");
                    if (userId === null) setAccountAttempt((attempt) => attempt + 1);
                    else setHistoryAttempt((attempt) => attempt + 1);
                  }}
                >
                  Retry
                </button>
              </div>
            )}
            {historyStatus === "ready" && (
              <>
                {sessions.length === 0 ? (
                  <p className="empty-note">
                    No puzzles yet. Start one, or open a friend&apos;s link, and it will be here when you come back.
                  </p>
                ) : unfinished.length === 0 ? (
                  <p className="empty-note">All caught up. Your finished puzzles are below.</p>
                ) : (
                  sessionList(unfinished)
                )}
                {finished.length > 0 && (
                  <details className="finished">
                    <summary>Finished puzzles ({finished.length})</summary>
                    {sessionList(finished)}
                  </details>
                )}
              </>
            )}
          </aside>
        </div>

        <div className="me-row">
          <Cup color="var(--p4)" />
          {userId !== null && <Identity userId={userId} />}
        </div>
      </Table>
    </Scene>
  );
}

function SessionRow({
  session,
  onRename,
}: {
  session: UserRoomSummary;
  onRename: (name: string | null) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name ?? "");
  const [saving, setSaving] = useState(false);

  const pct =
    session.totalPieces > 0 ? Math.round((session.placedPieces / session.totalPieces) * 100) : 0;
  const fallbackTitle = "Untitled puzzle";
  const finished = session.status === "completed";
  const startedAt = new Date(session.createdAt);
  const startedLabel = startedAt.toDateString() === new Date().toDateString()
    ? "today"
    : startedAt.toLocaleDateString(undefined, { day: "numeric", month: "short" });

  async function commit(): Promise<void> {
    const trimmed = draft.trim().slice(0, MAX_ROOM_NAME_LENGTH);
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

  const thumb = (
    <span className="thumb">
      {/* Same-origin room image; next/image adds no value for an API route. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={session.imageRef ? imageUrl(session.imageRef) : roomImageUrl(session.roomId)} alt="" loading="lazy" />
    </span>
  );
  const bar = (
    <span className="row-bar">
      <i style={{ width: `${pct}%` }} />
    </span>
  );
  const meta = (
    <span className="row-meta">
      {session.placedPieces} of {session.totalPieces} pieces · Started{" "}
      <time dateTime={session.createdAt} title={startedAt.toLocaleString()}>
        {startedLabel}
      </time>
    </span>
  );

  return (
    <li className={finished ? "row is-done" : "row"}>
      {editing ? (
        // Not a link while editing: a click in the input must not open the room.
        <div className="row-main">
          {thumb}
          <span className="row-body">
            <input
              className="row-input"
              aria-label="Puzzle name"
              autoFocus
              value={draft}
              maxLength={MAX_ROOM_NAME_LENGTH}
              placeholder={fallbackTitle}
              disabled={saving}
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
            {bar}
            {meta}
          </span>
        </div>
      ) : (
        <Link
          className="row-main"
          href={`/room/${encodeURIComponent(session.roomId)}`}
          aria-label={`${finished ? "View" : "Continue"}: ${session.name ?? fallbackTitle}`}
        >
          {thumb}
          <span className="row-body">
            <span className="row-name">
              {session.name ?? fallbackTitle}
              {finished && <span className="done"> · finished</span>}
            </span>
            {bar}
            {meta}
          </span>
          <span className="row-go" aria-hidden="true">
            {finished ? "View" : "Continue"} →
          </span>
        </Link>
      )}
      <button
        type="button"
        className="row-rename"
        aria-label={`Rename ${session.name ?? fallbackTitle}`}
        title="Rename"
        onClick={() => {
          setDraft(session.name ?? "");
          setEditing(true);
        }}
      >
        ✎
      </button>
    </li>
  );
}

/**
 * Your name at the table: click it to rename, with the permanent player ID
 * tucked behind an "ID" disclosure — it can't be changed and only matters
 * when something needs identifying, so it stays out of the way.
 */
function Identity({ userId }: { userId: string }) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [idOpen, setIdOpen] = useState(false);

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
    // Display name is a convenience; a fetch failure just leaves the field blank.
    void api.getProfile(userId).then((res) => {
      if (cancelled || !res.ok) return;
      setSavedName(res.value.displayName);
      setNameDraft(res.value.displayName ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function commitName(): Promise<void> {
    setEditing(false);
    const trimmed = nameDraft.trim();
    if (trimmed === "" || trimmed === (savedName ?? "")) {
      setNameDraft(savedName ?? "");
      return;
    }
    const res = await api.setDisplayName(userId, trimmed);
    if (!res.ok) {
      setNameStatus("error");
      return;
    }
    setSavedName(res.value.displayName);
    setNameDraft(res.value.displayName);
    setNameStatus("saved");
  }

  return (
    <div className="identity">
      <div className="identity-line">
        <span>You&apos;re here as</span>
        {editing ? (
          <input
            className="name-input"
            aria-label="Your display name"
            autoFocus
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
              if (e.key === "Escape") {
                setNameDraft(savedName ?? "");
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="name-btn"
            title="Click to change your name. Rooms you're already in keep your old name until you rejoin."
            onClick={() => setEditing(true)}
          >
            {savedName ?? "Pick a name"}
          </button>
        )}
        {nameStatus === "saved" && <span className="identity-status">Saved</span>}
        {nameStatus === "error" && (
          <span className="identity-status identity-status--error">Couldn&apos;t save</span>
        )}
        <button
          type="button"
          className="id-btn"
          aria-expanded={idOpen}
          aria-controls="id-row"
          onClick={() => setIdOpen((v) => !v)}
        >
          ID
        </button>
      </div>

      {idOpen && (
        <div className="id-row" id="id-row">
          <span>Your puzzles are tied to this ID:</span>
          <code>{userId}</code>
          <button
            type="button"
            className="copy-btn"
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
      )}
    </div>
  );
}
