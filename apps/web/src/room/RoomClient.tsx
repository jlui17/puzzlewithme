"use client";

import type { RoomSettings } from "@puzzlewithme/shared";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  browserClock,
  browserScheduler,
  createBrowserSocketFactory,
  createLocalStorageTokenStorage,
  SyncClient,
  type BoardState,
  type ConnectionStatus,
} from "../sync";
import { getRoom } from "../api";
import { imageUrl, wsUrl } from "../config";
import { Cup } from "../scene/Cup";
import { Scene } from "../scene/Scene";
import { Sill } from "../scene/Sill";
import { ROOM_TILT_DEG, Table } from "../scene/Table";
import type { TableHandle } from "../scene/table-handle";
import { WindowBand } from "../scene/WindowBand";
import { CompletionOverlay, type Contribution } from "./CompletionOverlay";
import { PlayersPanel, type PlayerView } from "./PlayersPanel";
import { RoomHeader } from "./RoomHeader";
import { RoomMenu } from "./RoomMenu";
import { TableCard } from "./TableCard";
import { ZoomControl } from "./ZoomControl";

/** Stores "0" once the players panel was left open, so it opens again next visit; it starts closed. */
const PANEL_COLLAPSED_KEY = "pwm:panelCollapsed";

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
        id: s.guestId,
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
  const contrib = p.contributions.map((c) => `${c.id}:${c.name}:${c.placedCount}`).join("|");
  return `${p.connection}/${p.status}/${p.localGuestId}/${p.placed}/${p.total}/${p.hasCompletionTime}/${p.completionMs}/${players}/${contrib}`;
}

export function RoomClient({ roomId }: { roomId: string }) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    void getRoom(roomId).then((lookup) => {
      if (cancelled) return;
      if (lookup.kind === "not_found") setLoad({ phase: "not_found" });
      else if (lookup.kind === "error") setLoad({ phase: "error", message: lookup.message });
      else setLoad({ phase: "ready", settings: lookup.info.settings });
    });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  if (load.phase === "loading") {
    return (
      <StateScene>
        <Cup color="var(--p4)" />
        <h2>Setting the table…</h2>
        <p>Laying out the pieces and pulling up chairs.</p>
      </StateScene>
    );
  }
  if (load.phase === "not_found") {
    return (
      <StateScene>
        <h2>No table here</h2>
        <p>That link&apos;s gone cold. The room isn&apos;t here any more.</p>
        <a href="/" className="start-btn">
          Start a fresh one
        </a>
      </StateScene>
    );
  }
  if (load.phase === "error") {
    return (
      <StateScene>
        <h2>The table&apos;s out of reach</h2>
        <p>{load.message}</p>
      </StateScene>
    );
  }

  return <RoomLive settings={load.settings} />;
}

/** The window seat with an empty table and a card on it: every room state with no board to play. */
function StateScene({ children }: { children: ReactNode }) {
  return (
    <Scene screen="room">
      <WindowBand />
      <Sill />
      <Table tilt={ROOM_TILT_DEG}>
        <TableCard>{children}</TableCard>
      </Table>
    </Scene>
  );
}

function RoomLive({ settings }: { settings: RoomSettings }) {
  const totalPieces = settings.rows * settings.cols;
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const tableRef = useRef<TableHandle>(null);
  const zoomRef = useRef<((factor: number) => void) | null>(null);
  const zoomHintRef = useRef<HTMLSpanElement>(null);
  const [toast, setToast] = useState<{ name: string; x: number; y: number; key: number } | null>(
    null,
  );
  const [statsDismissed, setStatsDismissed] = useState(false);

  // Lazy initializer: RoomLive renders only on the client (after the room
  // GET), but storage can still throw (private mode/disabled).
  const [playersOpen, setPlayersOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_COLLAPSED_KEY) === "0";
    } catch {
      return false;
    }
  });

  const setPlayersOpenSaved = useCallback((open: boolean) => {
    setPlayersOpen(open);
    try {
      localStorage.setItem(PANEL_COLLAPSED_KEY, open ? "0" : "1");
    } catch {
      // Best-effort persistence; a failed write just means the choice resets next visit.
    }
  }, []);
  const togglePlayers = useCallback(() => setPlayersOpenSaved(!playersOpen), [playersOpen, setPlayersOpenSaved]);
  const closePlayers = useCallback(() => setPlayersOpenSaved(false), [setPlayersOpenSaved]);

  const onZoom = useCallback((zoom: number) => {
    if (zoomHintRef.current) zoomHintRef.current.textContent = `${zoom.toFixed(1)}×`;
  }, []);

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
      }),
    [settings.roomId],
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

  // Auto-dismiss the held-by toast (CSS animation lasts 1.8s).
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1900);
    return () => clearTimeout(t);
  }, [toast]);

  const onRename = useCallback((name: string) => sync.rename(name), [sync]);
  const closeStats = useCallback(() => setStatsDismissed(true), []);

  // Read-only from either source: the GET already told us the room is completed,
  // so honor it even before (or without) a WS snapshot flipping sync state.
  const completed = settings.status === "completed" || panel.status === "completed";
  const roomFull = panel.connection === "room_full";
  const me = panel.players.find((p) => p.id === panel.localGuestId) ?? null;
  const others = panel.players.filter((p) => p.id !== panel.localGuestId);

  if (roomFull) {
    return (
      <StateScene>
        <h2>Full house</h2>
        <p>Every seat at this table is taken. Try again in a bit, or put your own puzzle on.</p>
        <a href="/" className="start-btn">
          Start a fresh one
        </a>
      </StateScene>
    );
  }

  return (
    <Scene screen="room">
      <WindowBand rainPaused={completed} />
      <Sill />
      <Table ref={tableRef} tilt={ROOM_TILT_DEG}>
        <BoardCanvas
          sync={sync}
          settings={settings}
          interactive={!completed}
          pointerRef={pointerRef}
          table={tableRef}
          zoomRef={zoomRef}
          onZoom={onZoom}
        />
        {/* After the board, so it paints over it. */}
        <RoomHeader placed={panel.placed} total={panel.total} completed={completed} others={others} me={me} />
        {toast && (
          <div className="held-toast" key={toast.key} style={{ left: toast.x, top: toast.y }} role="status">
            {toast.name}&apos;s got that one
          </div>
        )}
      </Table>

      {/* Flat over the table, never tilted: outside the plane, because fixed positions break inside its transform. */}
      <div className="chrome">
        <ConnectionBadge status={panel.connection} />
        <ZoomControl zoomRef={zoomRef} hintRef={zoomHintRef} />
        <RoomMenu
          imageUrl={imageUrl(settings.imageRef)}
          playerCount={panel.players.length}
          playersOpen={playersOpen}
          onTogglePlayers={togglePlayers}
          completed={completed}
          onShowStats={() => setStatsDismissed(false)}
        />
        {playersOpen && (
          <PlayersPanel
            players={panel.players}
            localGuestId={panel.localGuestId}
            placed={panel.placed}
            onRename={onRename}
            onClose={closePlayers}
          />
        )}
      </div>

      {completed && !statsDismissed && (
        <CompletionOverlay
          elapsedMs={panel.hasCompletionTime ? panel.completionMs : null}
          total={panel.total || totalPieces}
          contributions={panel.contributions}
          localGuestId={panel.localGuestId}
          onClose={closeStats}
        />
      )}

      <DebugOverlay sync={sync} />
    </Scene>
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
  // Ages must use the same clock the stats were stamped with (browserClock,
  // not Date.now(): the two have different epochs).
  const now = browserClock.now();
  const age = (ts: number): string => (ts === 0 ? "never" : `${((now - ts) / 1000).toFixed(0)}s ago`);
  const counts = Object.entries(stats.received)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${type}:${n}`)
    .join(" ");
  // Written by BoardRenderer.publishSceneStats; undefined until the canvas boots.
  const scene = (globalThis as { __pwmScene?: import("../board/renderer").SceneDebugStats }).__pwmScene;
  return (
    <div className="debug-overlay">
      <div>conn={state.connection} me={state.localGuestId ?? "-"}</div>
      <div>rx {counts || "(nothing)"}</div>
      <div>
        last frame {age(stats.lastInboundAt)} · last snap_result {age(stats.lastSnapResultAt)}
      </div>
      <div>
        store groups={state.groups.size} locked={[...state.groups.values()].filter((g) => g.locked).length} players=
        {state.players.size}
      </div>
      <div>
        {scene
          ? `scene nodes=${scene.nodes} locked=${scene.lockedNodes} errs=${scene.syncErrors} rebuilds=${scene.rebuilds} ctxLost=${scene.contextLost}${scene.lastError ? ` last=${scene.lastError}` : ""}`
          : "scene (not booted)"}
      </div>
    </div>
  );
}

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const label: Record<ConnectionStatus, string> = {
    idle: "pulling up a chair…",
    connecting: "pulling up a chair…",
    connected: "at the table",
    reconnecting: "finding the table again…",
    closed: "you slipped offline",
    room_full: "full house",
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
    <div className="conn-badge" role="status">
      <span className={`conn-dot ${dot}`} aria-hidden="true" />
      {label[status]}
    </div>
  );
}
