// The game server's library surface: room engine (the referee, §6.1.2), room
// store (§6.1.3), image store (§6.1.4), the room-creation HTTP API (§7.1), and
// the live-play network layer (registry + WebSocket server). The runnable
// entrypoint is main.ts; this barrel stays side-effect-free for tests.
export * from "./engine/index.js";
export * from "./store/index.js";
export * from "./images/index.js";
export * from "./http/index.js";
export * from "./net/index.js";
