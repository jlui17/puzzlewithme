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
import { Cup, TableSurface } from "../table";
import { CompletionOverlay, type Contribution } from "./CompletionOverlay";
import { BrewSlip, PlayersPanel, type PlayerView } from "./PlayersPanel";
import { RoomMenu } from "./RoomMenu";

const PANEL_COLLAPSED_KEY = "pwm:panelCollapsed";

/** Below this, the players panel's default width covers too much of a phone-sized board. */
const MOBILE_BREAKPOINT_PX = 640;

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
      <StateCard>
        <Cup className="state-cup" />
        <h2>Brewing your puzzle…</h2>
        <p>Laying out the pieces and pulling up chairs.</p>
      </StateCard>
    );
  }
  if (load.phase === "not_found") {
    return (
      <StateCard>
        <div className="script">sorry —</div>
        <h2>no such table</h2>
        <p>That link&apos;s gone cold. The room isn&apos;t here any more.</p>
        <a href="/" className="state-btn">
          Start a fresh one
        </a>
      </StateCard>
    );
  }
  if (load.phase === "error") {
    return (
      <StateCard>
        <div className="script">hm —</div>
        <h2>the kitchen&apos;s quiet</h2>
        <p>{load.message}</p>
      </StateCard>
    );
  }

  return <RoomLive settings={load.settings} />;
}

/** A slip left on an empty table: every non-playable room state renders here. */
function StateCard({ children }: { children: ReactNode }) {
  return (
    <div className="state-shell">
      <TableSurface />
      <div className="state-card">{children}</div>
    </div>
  );
}

function RoomLive({ settings }: { settings: RoomSettings }) {
  const totalPieces = settings.rows * settings.cols;
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [toast, setToast] = useState<{ name: string; x: number; y: number; key: number } | null>(
    null,
  );
  const [statsDismissed, setStatsDismissed] = useState(false);

  // Lazy initializer: reads the saved choice, falling back to a width-based
  // default. Runs during SSR too (no "use client" boundary exempts the
  // initial render), so window/localStorage must be guarded.
  const [playersCollapsed, setPlayersCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const saved = localStorage.getItem(PANEL_COLLAPSED_KEY);
      if (saved === "1") return true;
      if (saved === "0") return false;
    } catch {
      // Storage can throw (private mode/disabled); fall through to the width default.
    }
    return window.innerWidth < MOBILE_BREAKPOINT_PX;
  });

  const togglePlayersCollapsed = useCallback(() => {
    setPlayersCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PANEL_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // Best-effort persistence; a failed write just means the choice resets next visit.
      }
      return next;
    });
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
      <StateCard>
        <div className="script">oof —</div>
        <h2>full house</h2>
        <p>Every seat at this table is taken. Try again in a bit, or put your own puzzle on.</p>
        <a href="/" className="state-btn">
          Start a fresh one
        </a>
      </StateCard>
    );
  }

  return (
    <div className="room-shell">
      <TableSurface />
      <BoardCanvas sync={sync} settings={settings} interactive={!completed} pointerRef={pointerRef} />

      <ConnectionBadge status={panel.connection} />

      <BrewSlip placed={panel.placed} total={panel.total} />

      {!playersCollapsed && (
        <PlayersPanel
          players={panel.players}
          localGuestId={panel.localGuestId}
          placed={panel.placed}
          onRename={onRename}
        />
      )}

      <RoomMenu
        imageUrl={imageUrl(settings.imageRef)}
        playersCollapsed={playersCollapsed}
        onTogglePlayers={togglePlayersCollapsed}
        completed={completed}
        onShowStats={() => setStatsDismissed(false)}
      />

      {toast && (
        <div className="held-toast" key={toast.key} style={{ left: toast.x, top: toast.y }}>
          {toast.name}&apos;s got that one
        </div>
      )}

      {completed && !statsDismissed && (
        <CompletionOverlay
          imageUrl={imageUrl(settings.imageRef)}
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
    <div className="conn-badge">
      <span className={`conn-dot ${dot}`} />
      {label[status]}
    </div>
  );
}
