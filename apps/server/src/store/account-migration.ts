import { MAX_NAME_LENGTH, MAX_ROOM_NAME_LENGTH } from "@puzzlewithme/shared";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { normalizeEmail } from "../auth/identity.js";
import type { RoomDeviations } from "../engine/types.js";

export interface AccountMapping {
  email: string;
  userId: string;
  legacyUserIds: string[];
  displayName: string;
  /** Explicit resolutions when merged memberships have conflicting room names. */
  roomNames?: Record<string, string | null>;
}
interface Member { room_id: string; user_id: string; created_by_user: number; name: string | null }

/** Run only against an offline DB. Default is a read-only rehearsal, with no inferred ownership. */
export function migrateAccounts(db: Database.Database, input: AccountMapping[], apply = false) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Provide a nonempty reviewed mapping");
  const ids = new Set<string>();
  const emails = new Set<string>();
  const columns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const hasEmail = columns.some((c) => c.name === "email");
  const mappings = input.map((row) => {
    if (!row || typeof row.email !== "string" || typeof row.userId !== "string" || !Array.isArray(row.legacyUserIds)
      || typeof row.displayName !== "string" || !row.displayName.trim() || row.displayName.trim().length > MAX_NAME_LENGTH) throw new Error("Invalid account mapping");
    const email = normalizeEmail(row.email);
    if (emails.has(email)) throw new Error("Email appears in more than one mapping");
    emails.add(email);
    const oldIds = [...new Set([row.userId, ...row.legacyUserIds])];
    for (const id of oldIds) {
      if (typeof id !== "string" || ids.has(id)) throw new Error("User ID appears in more than one mapping");
      ids.add(id);
      const user = db.prepare(`SELECT user_id${hasEmail ? ", email" : ""} FROM users WHERE user_id = ?`).get(id) as { user_id: string; email?: string | null } | undefined;
      if (!user) throw new Error(`Unknown user ID: ${id}`);
      if (user.email && user.email !== email) throw new Error("Cannot merge a different authenticated account");
    }
    if (hasEmail) {
      const owner = db.prepare("SELECT user_id FROM users WHERE email = ?").get(email) as { user_id: string } | undefined;
      if (owner && !oldIds.includes(owner.user_id)) throw new Error("Email already belongs to an unmapped account");
    }
    return { ...row, email, oldIds, displayName: row.displayName.trim() };
  });
  const members = db.prepare("SELECT * FROM room_members").all() as Member[];
  const roomRows = db.prepare("SELECT id, state FROM rooms").all() as { id: string; state: string }[];
  const changedRooms = new Map<string, string>();
  let mergedPlayers = 0;
  const memberUpdates: Member[] = [];
  for (const mapping of mappings) {
    const grouped = new Map<string, Member[]>();
    for (const member of members.filter((m) => mapping.oldIds.includes(m.user_id))) {
      grouped.set(member.room_id, [...grouped.get(member.room_id) ?? [], member]);
    }
    for (const [roomId, rows] of grouped) {
      const names = [...new Set(rows.map((r) => r.name).filter((n) => n !== null))];
      const explicit = mapping.roomNames?.[roomId];
      if (names.length > 1 && explicit === undefined) throw new Error(`Resolve conflicting room names for ${roomId}`);
      if (explicit !== undefined && explicit !== null && (typeof explicit !== "string" || !explicit.trim() || explicit.length > MAX_ROOM_NAME_LENGTH)) throw new Error("Invalid room name resolution");
      memberUpdates.push({ room_id: roomId, user_id: mapping.userId, created_by_user: rows.some((r) => r.created_by_user) ? 1 : 0, name: explicit !== undefined ? explicit : names[0] ?? null });
    }
  }
  for (const room of roomRows) {
    const state = JSON.parse(room.state) as RoomDeviations;
    const beforeScore = state.identities.reduce((sum, i) => sum + i.placedCount, 0);
    let changed = false;
    for (const mapping of mappings) {
      const matching = state.identities.filter((i) => i.userId !== undefined && mapping.oldIds.includes(i.userId));
      if (!matching.length) continue;
      const canonical = matching.find((i) => i.userId === mapping.userId) ?? matching[0]!;
      canonical.userId = mapping.userId;
      canonical.name = mapping.displayName;
      canonical.placedCount = matching.reduce((sum, i) => sum + i.placedCount, 0);
      canonical.resumeToken = randomUUID();
      state.identities = state.identities.filter((i) => !matching.includes(i) || i === canonical);
      mergedPlayers += matching.length - 1;
      changed = true;
    }
    if (state.identities.reduce((sum, i) => sum + i.placedCount, 0) !== beforeScore) throw new Error("Score conservation failed");
    if (changed) changedRooms.set(room.id, JSON.stringify(state));
  }
  const report = { accounts: mappings.length, legacyUsers: mappings.reduce((n, m) => n + m.oldIds.length - 1, 0), rooms: changedRooms.size, mergedPlayers, applied: apply };
  if (!apply) return report;
  db.transaction(() => {
    if (!hasEmail) db.exec("ALTER TABLE users ADD COLUMN email TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email)");
    for (const mapping of mappings) {
      for (const id of mapping.oldIds) {
        db.prepare("UPDATE images SET owner_user_id = ? WHERE owner_user_id = ?").run(mapping.userId, id);
        db.prepare("DELETE FROM room_members WHERE user_id = ?").run(id);
        if (id !== mapping.userId) db.prepare("DELETE FROM users WHERE user_id = ?").run(id);
      }
      db.prepare("UPDATE users SET email = ?, display_name = ? WHERE user_id = ?").run(mapping.email, mapping.displayName, mapping.userId);
    }
    for (const member of memberUpdates) db.prepare("INSERT INTO room_members (room_id, user_id, created_by_user, name) VALUES (?, ?, ?, ?)").run(member.room_id, member.user_id, member.created_by_user, member.name);
    for (const [id, state] of changedRooms) db.prepare("UPDATE rooms SET state = ? WHERE id = ?").run(state, id);
  })();
  return report;
}
