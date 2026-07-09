import { afterAll, beforeAll, describe } from "vitest";
import { runRoomStoreContractTests } from "./contract.test-suite.js";
import { PostgresRoomStore } from "./postgres-room-store.js";

// Integration-only: needs a real Postgres. CI/local-without-DB coverage of
// the RoomStore interface comes from InMemoryRoomStore's contract run
// (room-store.test.ts); this suite adds confidence that the SQL/JSONB
// mapping actually round-trips against a real server, which the in-memory
// impl can't catch (e.g. JSON serialization edge cases, SQLSTATE codes).
describe.skipIf(!process.env["DATABASE_URL"])("PostgresRoomStore", () => {
  let store: PostgresRoomStore;

  beforeAll(async () => {
    store = new PostgresRoomStore({ connectionString: process.env["DATABASE_URL"]! });
    await store.migrate();
  });

  afterAll(async () => {
    await store.close();
  });

  runRoomStoreContractTests("PostgresRoomStore", () => store);
});
