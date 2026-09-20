import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { migrateAccounts, type AccountMapping } from "./account-migration.js";

let db: Database.Database;
const mapping: AccountMapping[] = [{ email: "one@example.test", userId: "one", legacyUserIds: ["old-one"], displayName: "One" }];
const original = {
  groups: [{ id: "group", pieces: [1, 2], position: { x: 2, y: 5 }, lockedToFrame: true }],
  creditedPieces: [1, 2, 3], activeSolvingTimeMs: 4567,
  identities: [
    { id: "p1", userId: "one", name: "First", color: "red", placedCount: 1, resumeToken: "a" },
    { id: "p2", userId: "old-one", name: "Second", color: "blue", placedCount: 2, resumeToken: "b" },
    { id: "p3", userId: "two", name: "Other", color: "green", placedCount: 0, resumeToken: "c" },
  ],
};
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE users(user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
    CREATE TABLE images(id TEXT PRIMARY KEY, owner_user_id TEXT);
    CREATE TABLE room_members(room_id TEXT, user_id TEXT, created_by_user INTEGER, name TEXT, PRIMARY KEY(room_id,user_id));
    CREATE TABLE rooms(id TEXT PRIMARY KEY, settings TEXT, state TEXT, updated_at TEXT);
    INSERT INTO users VALUES ('one','First'),('old-one','Second'),('two','Other');
    INSERT INTO images VALUES ('image','old-one');
    INSERT INTO room_members VALUES ('room','one',0,NULL),('room','old-one',1,'Our room');`);
  db.prepare("INSERT INTO rooms VALUES ('room', ?, ?, 'unchanged')").run('{"imageRef":"image"}', JSON.stringify(original));
});
afterEach(() => db.close());
it("rehearses without writing schema or data, then preserves puzzle state and score totals", () => {
  expect(migrateAccounts(db, mapping)).toEqual({ accounts: 1, legacyUsers: 1, rooms: 1, mergedPlayers: 1, applied: false });
  expect(db.prepare("SELECT * FROM users").all()).toHaveLength(3);
  expect(db.prepare("PRAGMA table_info(users)").all()).toHaveLength(2);
  migrateAccounts(db, mapping, true);
  const room = db.prepare("SELECT * FROM rooms").get() as { settings: string; state: string; updated_at: string };
  const state = JSON.parse(room.state);
  expect(state.groups).toEqual(original.groups);
  expect(state.creditedPieces).toEqual(original.creditedPieces);
  expect(state.activeSolvingTimeMs).toBe(original.activeSolvingTimeMs);
  expect(room.settings).toBe('{"imageRef":"image"}');
  expect(room.updated_at).toBe("unchanged");
  expect(state.identities).toHaveLength(2);
  expect(state.identities[0]).toMatchObject({ id: "p1", userId: "one", name: "One", placedCount: 3 });
  expect(state.identities[0].resumeToken).not.toBe("a");
  expect(db.prepare("SELECT * FROM room_members").all()).toEqual([{ room_id: "room", user_id: "one", created_by_user: 1, name: "Our room" }]);
  expect(db.prepare("SELECT owner_user_id FROM images").get()).toEqual({ owner_user_id: "one" });
  expect(db.prepare("SELECT email FROM users WHERE user_id='one'").get()).toEqual({ email: "one@example.test" });
});
it("refuses ambiguous ownership and conflicting room names without partial changes", () => {
  expect(() => migrateAccounts(db, [...mapping, { ...mapping[0]!, email: "two@example.test" }], true)).toThrow();
  db.exec("UPDATE room_members SET name = 'Different' WHERE user_id = 'one'");
  expect(() => migrateAccounts(db, mapping, true)).toThrow("Resolve conflicting room names");
  expect(db.prepare("SELECT * FROM users").all()).toHaveLength(3);
  migrateAccounts(db, [{ ...mapping[0]!, roomNames: { room: "Chosen" } }], true);
  expect(db.prepare("SELECT name FROM room_members").get()).toEqual({ name: "Chosen" });
});
it("refuses attaching an existing account to a different verified email", () => {
  db.exec("ALTER TABLE users ADD COLUMN email TEXT; UPDATE users SET email='different@example.test' WHERE user_id='old-one'");
  expect(() => migrateAccounts(db, mapping, true)).toThrow("different authenticated account");
});
