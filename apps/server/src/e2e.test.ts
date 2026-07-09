import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CELL_SIZE, coordToPieceId, framePosition } from "@puzzlewithme/geometry";
import { singletonGroupId, type ServerMessage } from "@puzzlewithme/shared";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { LocalDiskImageStore } from "./images/local-disk-image-store.js";
import { InMemoryRoomStore } from "./store/room-store.js";
import { createGameServer, type GameServer } from "./net/server.js";

/**
 * Full-stack smoke test (SPEC §6, NFR-6): boots the real HTTP handler + WS
 * layer on one in-process port, creates a room through the actual multipart
 * upload path, then drives two real WebSocket clients through grab/move/drop
 * and checks a third late joiner converges to the same state. Every other
 * test in this repo exercises one component (engine, http handler, ws wiring)
 * against a stub of its neighbors; this is the one test that wires all of
 * them together the way main.ts does, so a bug only visible at the seams
 * (e.g. the HTTP-created room's settings not matching what the WS engine
 * loads) has somewhere to surface.
 */

async function json(res: Response): Promise<any> {
  return res.json();
}

/** A real `ws` client that buffers every ServerMessage it receives, mirroring net/ws-integration.test.ts's harness. */
class TestClient {
  readonly ws: WebSocket;
  private readonly records: { msg: ServerMessage; consumed: boolean }[] = [];
  private readonly waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  private readonly openPromise: Promise<void>;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8")) as ServerMessage;
      this.records.push({ msg, consumed: false });
      this.pump();
    });
  }

  opened(): Promise<void> {
    return this.openPromise;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs = 2000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      this.pump();
    });
  }

  waitForType(type: ServerMessage["type"], timeoutMs = 2000): Promise<ServerMessage> {
    return this.waitFor((m) => m.type === type, timeoutMs);
  }

  close(): void {
    this.ws.close();
  }

  private pump(): void {
    for (let wi = 0; wi < this.waiters.length; ) {
      const waiter = this.waiters[wi]!;
      const record = this.records.find((r) => !r.consumed && waiter.predicate(r.msg));
      if (record !== undefined) {
        record.consumed = true;
        waiter.resolve(record.msg);
        this.waiters.splice(wi, 1);
      } else {
        wi += 1;
      }
    }
  }
}

async function makeSquareJpeg(sizePx: number): Promise<Buffer> {
  return sharp({
    create: { width: sizePx, height: sizePx, channels: 3, background: { r: 60, g: 120, b: 180 } },
  })
    .jpeg()
    .toBuffer();
}

interface JoinedClient {
  client: TestClient;
  playerId: string;
}

async function joinRoom(baseWsPort: number, roomId: string): Promise<JoinedClient> {
  const client = new TestClient(baseWsPort);
  await client.opened();
  client.send({ type: "join", roomId, resumeToken: null });
  const joined = await client.waitForType("joined");
  await client.waitForType("snapshot");
  if (joined.type !== "joined") throw new Error("unreachable");
  return { client, playerId: joined.identity.id };
}

describe("full-stack e2e smoke test", () => {
  let uploadsDir: string;
  let game: GameServer;
  let port: number;
  let baseUrl: string;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), "puzzlewithme-e2e-"));
    game = createGameServer({
      roomStore: new InMemoryRoomStore(),
      imageStore: new LocalDiskImageStore(uploadsDir),
      // Large enough that the debounced checkpoint and idle sweep never fire
      // mid-test; only the immediate broadcast/response paths are under test.
      registry: { checkpointIntervalMs: 3_600_000, sweepIntervalMs: 3_600_000 },
    });
    await new Promise<void>((resolve) => game.server.listen(0, "127.0.0.1", resolve));
    port = (game.server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await game.close();
    await rm(uploadsDir, { recursive: true, force: true });
  });

  it("creates a room over HTTP, plays a real solve sequence over two WS clients, and converges a late joiner", async () => {
    // --- Room creation (FR-1..FR-5): real multipart upload through the HTTP handler. ---
    const imageBytes = await makeSquareJpeg(1000);
    const form = new FormData();
    form.set("image", new Blob([imageBytes], { type: "image/jpeg" }), "photo.jpg");
    form.set("tier", "100");
    const createRes = await fetch(`${baseUrl}/api/rooms`, { method: "POST", body: form });
    expect(createRes.status).toBe(201);
    const created = await json(createRes);
    const roomId: string = created.roomId;
    const rows: number = created.rows;
    const cols: number = created.cols;
    // A 1000x1000 upload at tier 100 always yields a grid with room for a
    // corner piece that isn't adjacent to (0,0)/(0,1) (see the lock step
    // below); deriveGrid's ±3-row search around sqrt(100) never produces
    // anything smaller than that for a square image.
    expect(rows).toBeGreaterThanOrEqual(3);
    expect(cols).toBeGreaterThanOrEqual(3);

    const settingsRes = await fetch(`${baseUrl}/api/rooms/${roomId}`);
    expect(settingsRes.status).toBe(200);
    const settingsBody = await json(settingsRes);
    expect(settingsBody.settings).toMatchObject({ roomId, rows, cols, status: "active" });
    const seed: string = settingsBody.settings.seed;
    expect(typeof seed).toBe("string");

    // GET .../image serves back real webp bytes (FR-2's re-encode).
    const imageRes = await fetch(`${baseUrl}/api/rooms/${roomId}/image`);
    expect(imageRes.status).toBe(200);
    expect(imageRes.headers.get("content-type")).toBe("image/webp");
    const servedBytes = Buffer.from(await imageRes.arrayBuffer());
    const servedMeta = await sharp(servedBytes).metadata();
    expect(servedMeta.format).toBe("webp");

    // --- Two players join over real WebSockets (§7.2). ---
    const a = await joinRoom(port, roomId);
    const b = await joinRoom(port, roomId);
    clients.push(a.client, b.client);

    // Piece ids/positions computed from the grid the server just returned,
    // not a hardcoded seed: the seed is server-generated (handler.ts's
    // generateSeed), so determinism here comes from geometry math on known
    // grid coordinates, never from reading initialScatter output. Scattered
    // pieces are guaranteed to clear the frame interior by a full footprint
    // (packages/geometry/src/scatter.ts), so staging drops inside the frame
    // can never accidentally land on/near a still-scattered piece and can
    // never accidentally lock (frame center is far outside every piece's
    // ~15-unit snap tolerance from its own correct frame position).
    const pieceA = coordToPieceId(0, 0, cols);
    const pieceB = coordToPieceId(0, 1, cols);
    const groupA = singletonGroupId(0, 0);
    const groupB = singletonGroupId(0, 1);
    const frameCenter = { x: (cols * CELL_SIZE) / 2, y: (rows * CELL_SIZE) / 2 };

    // Step 1: grab, move, and drop piece A alone in the empty frame interior.
    // No neighbor is nearby and the center is far from A's own frame position,
    // so this is a clean no-op drop: sets up a known anchor for the merge below.
    a.client.send({ type: "grab", groupId: groupA });
    const grabResult = await a.client.waitForType("grab_result");
    expect(grabResult).toMatchObject({ groupId: groupA, outcome: "granted" });
    const heldA = await b.client.waitForType("held");
    expect(heldA).toMatchObject({ type: "held", groupId: groupA, playerId: a.playerId });

    a.client.send({ type: "move", groupId: groupA, x: frameCenter.x - 20, y: frameCenter.y - 20 });
    const movedA = await b.client.waitForType("group_moved");
    expect(movedA).toMatchObject({ groupId: groupA, x: frameCenter.x - 20, y: frameCenter.y - 20 });

    a.client.send({ type: "drop", groupId: groupA, x: frameCenter.x, y: frameCenter.y });
    const stagedA = await a.client.waitForType("snap_result");
    const stagedB = await b.client.waitForType("snap_result");
    expect(stagedA).toEqual(stagedB);
    expect(stagedA).toMatchObject({
      droppedGroupId: groupA,
      group: { id: groupA, position: frameCenter, lockedToFrame: false },
      mergedGroupIds: [],
      scoreCredits: [],
      progress: { placedPieces: 0, totalPieces: rows * cols },
    });

    // Step 2: grab, move, and drop piece B exactly at A's frame-relative
    // offset (piece B is one cell to the right of A), so it provably merges.
    const mergeTarget = {
      x: frameCenter.x + (framePosition(pieceB, cols).x - framePosition(pieceA, cols).x),
      y: frameCenter.y + (framePosition(pieceB, cols).y - framePosition(pieceA, cols).y),
    };
    a.client.send({ type: "grab", groupId: groupB });
    await a.client.waitForType("grab_result");
    await b.client.waitFor((m) => m.type === "held" && m.groupId === groupB);

    a.client.send({ type: "move", groupId: groupB, x: mergeTarget.x + 30, y: mergeTarget.y + 30 });
    await b.client.waitFor((m) => m.type === "group_moved" && m.groupId === groupB);

    a.client.send({ type: "drop", groupId: groupB, x: mergeTarget.x, y: mergeTarget.y });
    const mergeA = await a.client.waitForType("snap_result");
    const mergeB = await b.client.waitForType("snap_result");
    expect(mergeA).toEqual(mergeB);
    if (mergeA.type !== "snap_result") throw new Error("unreachable");
    // The surviving group id is the DROPPED group's id (groupB here), not the
    // anchor piece's — a merge never mints a new id (packages/shared's
    // singletonGroupId doc comment) and never keeps the absorbed side's.
    expect(mergeA).toMatchObject({
      droppedGroupId: groupB,
      group: {
        id: groupB,
        // unionPieces is sorted by ascending piece id (snap.ts); pieceA=0, pieceB=1.
        pieces: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
        ],
        position: frameCenter,
        lockedToFrame: false,
      },
      mergedGroupIds: [groupA],
      scoreCredits: [{ guestId: a.playerId, piecesCredited: 2 }],
      progress: { placedPieces: 2, totalPieces: rows * cols },
    });
    const mergedGroup = mergeA.group;

    // Step 3: grab, move, and drop the far corner piece exactly at its own
    // frame position, so it locks alone (its neighbors are both still
    // untouched, scattered outside the frame, so nothing else joins the lock).
    const cornerRow = rows - 1;
    const cornerCol = cols - 1;
    const cornerPiece = coordToPieceId(cornerRow, cornerCol, cols);
    const cornerGroupId = singletonGroupId(cornerRow, cornerCol);
    const cornerFramePos = framePosition(cornerPiece, cols);

    b.client.send({ type: "grab", groupId: cornerGroupId });
    const cornerGrab = await b.client.waitForType("grab_result");
    expect(cornerGrab).toMatchObject({ groupId: cornerGroupId, outcome: "granted" });
    await a.client.waitFor((m) => m.type === "held" && m.groupId === cornerGroupId);

    b.client.send({ type: "move", groupId: cornerGroupId, x: cornerFramePos.x - 10, y: cornerFramePos.y - 10 });
    await a.client.waitFor((m) => m.type === "group_moved" && m.groupId === cornerGroupId);

    b.client.send({ type: "drop", groupId: cornerGroupId, x: cornerFramePos.x, y: cornerFramePos.y });
    const lockA = await a.client.waitForType("snap_result");
    const lockB = await b.client.waitForType("snap_result");
    expect(lockA).toEqual(lockB);
    expect(lockA).toMatchObject({
      droppedGroupId: cornerGroupId,
      group: { id: cornerGroupId, pieces: [{ row: cornerRow, col: cornerCol }], position: cornerFramePos, lockedToFrame: true },
      mergedGroupIds: [],
      scoreCredits: [{ guestId: b.playerId, piecesCredited: 1 }],
      progress: { placedPieces: 3, totalPieces: rows * cols },
    });

    // --- A third, late-joining client converges to the same accumulated state (NFR-6). ---
    const c = new TestClient(port);
    clients.push(c);
    await c.opened();
    c.send({ type: "join", roomId, resumeToken: null });
    await c.waitForType("joined");
    const snapshotMsg = await c.waitForType("snapshot");
    if (snapshotMsg.type !== "snapshot") throw new Error("unreachable");

    const groupsById = new Map(snapshotMsg.groups.map((g) => [g.id, g]));
    expect(groupsById.get(groupB)).toMatchObject({
      id: groupB,
      position: mergedGroup.position,
      lockedToFrame: false,
      heldBy: null,
    });
    expect(groupsById.get(cornerGroupId)).toMatchObject({
      id: cornerGroupId,
      pieces: [{ row: cornerRow, col: cornerCol }],
      position: cornerFramePos,
      lockedToFrame: true,
      heldBy: null,
    });
    expect(groupsById.has(groupA)).toBe(false); // absorbed into groupB, never re-appears

    const scoresByGuest = new Map(snapshotMsg.scoreboard.players.map((p) => [p.guestId, p.placedCount]));
    expect(scoresByGuest.get(a.playerId)).toBe(2);
    expect(scoresByGuest.get(b.playerId)).toBe(1);
    expect(snapshotMsg.scoreboard.progress).toEqual({ placedPieces: 3, totalPieces: rows * cols });
  });
});
