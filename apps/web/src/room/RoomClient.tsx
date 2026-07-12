"use client";

import type { RoomSettings } from "@puzzlewithme/shared";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  browserClock,
  browserScheduler,
  createBrowserSocketFactory,
  createLocalStorageTokenStorage,
  loadOrCreateUserId,
  SyncClient,
  type BoardState,
  type ConnectionStatus,
} from "../sync";
import { roomImageUrl, wsUrl } from "../config";
import { CompletionOverlay, type Contribution } from "./CompletionOverlay";
import { PlayersPanel, type PlayerView } from "./PlayersPanel";

const BoardCanvas = dynamic(() => import("./BoardCanvas").then((m) => m.BoardCanvas), {
  ssr: false,
});

type Load =
  | { phase: "loading" }
  | { phase: "not_found" }
  | { phase: "error"; message: string }
  | { phase: "ready"; settings: RoomSettings };

interface Panel {
  connection: ConnectionStatus;
  status: "active" | "completed";
  localGuestId: string | null;
  players: PlayerView[];
  placed: number;
  total: number;
  contributions: Contribution[];
  hasCompletionTime: boolean;
  completionMs: number;
}

function derivePanel(state: BoardState, total: number): Panel {
  const players: PlayerView[] = [...state.players.values()]
    .map((p) => ({ id: p.id, name: p.name, color: p.color, placedCount: p.placedCount }))
    .sort((a, b) => b.placedCount - a.placedCount || a.name.localeCompare(b.name));

  const contributions: Contribution[] = state.scoreboard.players
    .filter((s) => s.placedCount > 0)
    .map((s) => {
      const id = state.players.get(s.guestId);
      return {
        name: id?.name ?? "Guest",
        color: id?.color ?? "#9aa7b4",
        placedCount: s.placedCount,
      };
    })
    .sort((a, b) => b.placedCount - a.placedCount);

  return {
    connection: state.connection,
    status: state.status,
    localGuestId: state.localGuestId,
    players,
    placed: state.scoreboard.progress.placedPieces,
    total: state.scoreboard.progress.totalPieces || total,
    contributions,
    hasCompletionTime: state.completion !== null,
    completionMs: state.completion?.totalActiveSolvingTimeMs ?? 0,
  };
}

/** Cheap change signature so 60 Hz cursor/motion notifies don't re-render panels. */
function signature(p: Panel): string {
  const players = p.players.map((x) => `${x.id}:${x.name}:${x.color}:${x.placedCount}`).join("|");
  const contrib = p.contributions.map((c) => `${c.name}:${c.placedCount}`).join("|");
  return `${p.connection}/${p.status}/${p.localGuestId}/${p.placed}/${p.total}/${p.hasCompletionTime}/${p.completionMs}/${players}/${contrib}`;
}

export function RoomClient({ roomId }: { roomId: string }) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`);
        if (cancelled) return;
        if (res.status === 404) {
          setLoad({ phase: "not_found" });
          return;
        }
        if (!res.ok) {
          setLoad({ phase: "error", message: `Server error (${res.status}).` });
          return;
        }
        const data = (await res.json()) as { exists: boolean; settings: RoomSettings };
        if (cancelled) return;
        if (!data.exists) setLoad({ phase: "not_found" });
        else setLoad({ phase: "ready", settings: data.settings });
      } catch {
        if (!cancelled) setLoad({ phase: "error", message: "Could not reach the server." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  if (load.phase === "loading") {
    return (
      <div className="center-msg">
        <div className="spinner" />
        <p>Loading room…</p>
      </div>
    );
  }
  if (load.phase === "not_found") {
    return (
      <div className="center-msg">
        <h2>Room not found</h2>
        <p>This puzzle link is invalid or the room no longer exists.</p>
        <a href="/">Create a new puzzle</a>
      </div>
    );
  }
  if (load.phase === "error") {
    return (
      <div className="center-msg">
        <h2>Something went wrong</h2>
        <p>{load.message}</p>
      </div>
    );
  }

  return <RoomLive settings={load.settings} />;
}

function RoomLive({ settings }: { settings: RoomSettings }) {
  const totalPieces = settings.rows * settings.cols;
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [toast, setToast] = useState<{ name: string; x: number; y: number; key: number } | null>(
    null,
  );
  const [statsDismissed, setStatsDismissed] = useState(false);

  // Resolved once on the client (localStorage is unavailable during SSR, where
  // loadOrCreateUserId returns null); not rendered into HTML, so no hydration
  // mismatch. This is the same browser's stable id across rooms/sessions.
  const userId = useMemo(() => loadOrCreateUserId(), []);

  // One SyncClient per room mount. Browser adapters only touch globals when
  // called (connect), so constructing here (client component) is safe.
  const sync = useMemo(
    () =>
      new SyncClient({
        roomId: settings.roomId,
        socketFactory: createBrowserSocketFactory(wsUrl()),
        clock: browserClock,
        scheduler: browserScheduler,
        tokenStorage: createLocalStorageTokenStorage(`pwm:resume:${settings.roomId}`),
        userId,
      }),
    [settings.roomId, userId],
  );

  const [panel, setPanel] = useState<Panel>(() => derivePanel(sync.getState(), totalPieces));

  useEffect(() => {
    let lastSig = signature(panel);
    const unsub = sync.subscribe((state) => {
      const next = derivePanel(state, totalPieces);
      const sig = signature(next);
      if (sig !== lastSig) {
        lastSig = sig;
        setPanel(next);
      }
    });
    const unEvent = sync.onEvent((event) => {
      if (event.type === "grab_rejected") {
        setToast({
          name: event.holderName,
          x: pointerRef.current.x,
          y: pointerRef.current.y,
          key: Date.now(),
        });
      }
    });
    sync.connect();
    return () => {
      unsub();
      unEvent();
      sync.close();
    };
    // panel is intentionally read once for the initial signature; sync/total are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync, totalPieces]);

  // Auto-dismiss the held-by toast (CSS animation lasts ~1.8s).
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1900);
    return () => clearTimeout(t);
  }, [toast]);

  const onRename = useCallback((name: string) => sync.rename(name), [sync]);

  // Read-only from either source: the GET already told us the room is completed,
  // so honor it even before (or without) a WS snapshot flipping sync state.
  const completed = settings.status === "completed" || panel.status === "completed";
  const roomFull = panel.connection === "room_full";

  if (roomFull) {
    return (
      <div className="center-msg">
        <h2>Room full</h2>
        <p>This room is at capacity. Try again later, or create your own puzzle.</p>
        <a href="/">Create a new puzzle</a>
      </div>
    );
  }

  return (
    <div className="room-shell">
      <BoardCanvas sync={sync} settings={settings} interactive={!completed} pointerRef={pointerRef} />

      <ConnectionBadge status={panel.connection} />

      <PlayersPanel
        players={panel.players}
        localGuestId={panel.localGuestId}
        placed={panel.placed}
        total={panel.total}
        onRename={onRename}
      />

      {completed && (
        <button className="read-only-badge" onClick={() => setStatsDismissed(false)}>
          Read-only · completed · show stats
        </button>
      )}

      {toast && (
        <div className="held-toast" key={toast.key} style={{ left: toast.x, top: toast.y }}>
          Held by {toast.name}
        </div>
      )}

      {completed && !statsDismissed && (
        <CompletionOverlay
          imageUrl={roomImageUrl(settings.roomId)}
          elapsedMs={panel.hasCompletionTime ? panel.completionMs : null}
          total={panel.total || totalPieces}
          contributions={panel.contributions}
          onClose={() => setStatsDismissed(true)}
        />
      )}

      <DebugOverlay sync={sync} />
    </div>
  );
}

/**
 * Desync diagnostics, rendered only with ?debug=1 in the URL (or
 * localStorage pwm:debug = "1"): live counts of every server message this
 * client received, plus seconds since the last frame / last snap_result.
 * Exists so a player on a device with no dev console (mobile Safari) can
 * screenshot exactly what their client did and didn't receive.
 */
function DebugOverlay({ sync }: { sync: SyncClient }) {
  const [enabled, setEnabled] = useState(false);
  const [, forceRender] = useState(0);

  useEffect(() => {
    const on =
      new URLSearchParams(window.location.search).has("debug") ||
      (() => {
        try {
          return localStorage.getItem("pwm:debug") === "1";
        } catch {
          return false;
        }
      })();
    setEnabled(on);
    if (!on) return;
    // 500 ms poll: cheap enough to be invisible, fast enough that "did a
    // message just arrive" is answerable while watching the screen.
    const t = setInterval(() => forceRender((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  if (!enabled) return null;
  const stats = sync.debugStats;
  const state = sync.getState();
  const now = Date.now();
  const age = (ts: number): string => (ts === 0 ? "never" : `${((now - ts) / 1000).toFixed(0)}s ago`);
  const counts = Object.entries(stats.received)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${type}:${n}`)
    .join(" ");
  return (
    <div className="debug-overlay">
      <div>conn={state.connection} me={state.localGuestId ?? "-"}</div>
      <div>rx {counts || "(nothing)"}</div>
      <div>
        last frame {age(stats.lastInboundAt)} · last snap_result {age(stats.lastSnapResultAt)}
      </div>
      <div>
        groups={state.groups.size} locked={[...state.groups.values()].filter((g) => g.locked).length} players=
        {state.players.size}
      </div>
    </div>
  );
}

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const label: Record<ConnectionStatus, string> = {
    idle: "Connecting…",
    connecting: "Connecting…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
    closed: "Disconnected",
    room_full: "Room full",
  };
  const dot =
    status === "connected"
      ? "connected"
      : status === "reconnecting" || status === "connecting" || status === "idle"
        ? "reconnecting"
        : "closed";
  // Hide the badge entirely once connected to keep the table clean.
  if (status === "connected") return null;
  return (
    <div className="conn-badge">
      <span className={`conn-dot ${dot}`} />
      {label[status]}
    </div>
  );
}
