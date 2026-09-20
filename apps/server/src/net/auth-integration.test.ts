import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import sharp from "sharp";
import { cloudflareAuthenticator } from "../auth/identity.js";
import { InMemoryRoomStore } from "../store/room-store.js";
import { createGameServer, type GameServer } from "./server.js";

let game: GameServer;
let store: InMemoryRoomStore;
let base: string;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
const clients: WebSocket[] = [];
const issuer = "https://test.cloudflareaccess.com";
beforeEach(async () => {
  store = new InMemoryRoomStore();
  keys = await generateKeyPair("RS256");
  const authenticate = cloudflareAuthenticator(store, issuer, "puzzle", createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }));
  game = createGameServer({ roomStore: store, imageStore: { async put() {}, async get() { return null; } }, authenticate });
  await new Promise<void>((resolve) => game.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(game.server.address() as AddressInfo).port}`;
  await store.create({ roomId: "room", imageRef: "image", rows: 2, cols: 2, seed: "s", status: "active" });
});
afterEach(async () => { for (const ws of clients.splice(0)) ws.terminate(); await game.close(); });
async function headers(email = "one@example.test") {
  const assertion = await new SignJWT({ email }).setProtectedHeader({ alg: "RS256" }).setIssuer(issuer)
    .setAudience("puzzle").setSubject(email).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
  return { "cf-access-jwt-assertion": assertion };
}
async function join(email: string, extra = {}) {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: await headers(email) });
  clients.push(ws);
  await once(ws, "open");
  const snapshot = new Promise<any>((resolve) => {
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "snapshot") resolve(message);
    });
  });
  const joined = once(ws, "message");
  ws.send(JSON.stringify({ type: "join", roomId: "room", resumeToken: null, ...extra }));
  const [data] = await joined;
  return { ws, message: JSON.parse(data.toString()), snapshot: await snapshot };
}
it("requires authentication for every API request and rejects foreign ownership paths", async () => {
  expect((await fetch(base + "/api/me")).status).toBe(401);
  const h = await headers();
  const me = await fetch(base + "/api/me", { headers: h });
  expect(me.headers.get("cache-control")).toBe("private, no-store");
  const account = await me.json() as { userId: string };
  const other = await store.findOrCreateAccount("two@example.test");
  for (const path of ["profile", "images", "rooms"]) {
    expect((await fetch(`${base}/api/users/${other.userId}/${path}`, { headers: h })).status).toBe(403);
  }
  expect((await fetch(`${base}/api/users/${other.userId}/profile`, { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ displayName: "Stolen" }) })).status).toBe(403);
  expect((await fetch(`${base}/api/users/${account.userId}/profile`, { headers: h })).status).toBe(200);
});
it("ignores forged owner IDs for gallery reuse and uploads", async () => {
  const other = await store.findOrCreateAccount("two@example.test");
  await store.recordImage("private-image", other.userId, 1000, 1000);
  const h = await headers();
  const forbidden = await fetch(base + "/api/rooms", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ imageId: "private-image", pieces: 100, userId: other.userId }) });
  expect(forbidden.status).toBe(404);
  const jpeg = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: "red" } }).jpeg().toBuffer();
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "image.jpg");
  form.set("pieces", "100"); form.set("userId", other.userId);
  expect((await fetch(base + "/api/rooms", { method: "POST", headers: h, body: form })).status).toBe(201);
  const owner = await store.findOrCreateAccount("one@example.test");
  expect(await store.listUserImages(owner.userId)).toHaveLength(1);
  expect(await store.listUserImages(other.userId)).toHaveLength(1);
});
it("rejects unauthenticated websocket upgrades", async () => {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
  clients.push(ws);
  const error = await new Promise<Error>((resolve) => ws.once("error", resolve));
  expect(error.message).toContain("401");
});
it("reuses a player across devices, keeps the second connected, and never trusts another account's token", async () => {
  const first = await join("one@example.test");
  const second = await join("one@example.test");
  expect(second.message.identity.id).toBe(first.message.identity.id);
  const closed = once(first.ws, "close"); first.ws.close(); await closed;
  const pong = once(second.ws, "message"); second.ws.send(JSON.stringify({ type: "ping" }));
  expect(JSON.parse((await pong)[0].toString()).type).toBe("pong");
  const grab = new Promise<any>((resolve) => {
    second.ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "grab_result" || message.type === "error") resolve(message);
    });
  });
  second.ws.send(JSON.stringify({ type: "grab", groupId: "0-0" }));
  expect(await grab).toMatchObject({ type: "grab_result", outcome: "granted" });
  const firstAccount = await store.findOrCreateAccount("one@example.test");
  const other = await join("two@example.test", { resumeToken: first.message.resumeToken, userId: firstAccount.userId });
  expect(other.message.identity.id).not.toBe(first.message.identity.id);
  const state = await store.listUserRooms((await store.findOrCreateAccount("two@example.test")).userId);
  expect(state).toHaveLength(1);
  // Email is never broadcast in game protocol messages.
  expect(JSON.stringify(other.message)).not.toContain("@example.test");
});
it("denies requests when the server factory receives no authenticator", async () => {
  const denied = createGameServer({ roomStore: store, imageStore: { async put() {}, async get() { return null; } } });
  await new Promise<void>((resolve) => denied.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (denied.server.address() as AddressInfo).port;
    expect((await fetch(`http://127.0.0.1:${port}/api/me`)).status).toBe(401);
  } finally { await denied.close(); }
});
it("closes an authenticated socket when its assertion expires", async () => {
  const expiring = createGameServer({
    roomStore: store, imageStore: { async put() {}, async get() { return null; } },
    authenticate: async () => ({ ...await store.findOrCreateAccount("one@example.test"), expiresAt: Date.now() + 300 }),
  });
  await new Promise<void>((resolve) => expiring.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (expiring.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    clients.push(ws);
    const closed = once(ws, "close");
    await once(ws, "open");
    expect((await closed)[0]).toBe(1008);
  } finally { await expiring.close(); }
});

it("keeps the same session in creator and participant histories after leaving and rejoining", async () => {
  const owner = await store.findOrCreateAccount("one@example.test");
  await store.recordMembership("room", owner.userId, true);
  const creator = await join("one@example.test");
  const participant = await join("two@example.test");
  for (const connection of [creator, participant]) {
    const closed = once(connection.ws, "close");
    connection.ws.close();
    await closed;
  }
  for (const [email, createdByUser] of [["one@example.test", true], ["two@example.test", false]] as const) {
    const account = await store.findOrCreateAccount(email);
    const response = await fetch(`${base}/api/users/${account.userId}/rooms`, { headers: await headers(email) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rooms: [{ roomId: "room", createdByUser }] });
    const rejoined = await join(email);
    expect(rejoined.message.type).toBe("joined");
    expect(await store.listUserRooms(account.userId)).toHaveLength(1);
  }
});
