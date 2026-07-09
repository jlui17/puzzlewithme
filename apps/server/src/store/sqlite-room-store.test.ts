import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe } from "vitest";
import { runRoomStoreContractTests } from "./contract.test-suite.js";
import { SqliteRoomStore } from "./sqlite-room-store.js";

// A real file (not ":memory:") so the "creates the parent directory" and
// WAL-sidecar-file behavior get exercised too; a fresh temp dir per run
// keeps this parallel-safe against other vitest workers/files.
let dir: string;
let store: SqliteRoomStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pw-sqlite-room-store-"));
  store = new SqliteRoomStore({ path: join(dir, "nested", "rooms.db") });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

runRoomStoreContractTests("SqliteRoomStore", () => store);

describe("SqliteRoomStore (:memory:)", () => {
  let memStore: SqliteRoomStore;

  afterEach(() => {
    memStore.close();
  });

  runRoomStoreContractTests("SqliteRoomStore (:memory:)", () => {
    memStore = new SqliteRoomStore({ path: ":memory:" });
    return memStore;
  });
});
