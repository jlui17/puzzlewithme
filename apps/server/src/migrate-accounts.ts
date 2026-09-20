import { readFileSync, existsSync, chmodSync } from "node:fs";
import Database from "better-sqlite3";
import { migrateAccounts, type AccountMapping } from "./store/account-migration.js";

const [databasePath, mappingPath, mode] = process.argv.slice(2);
if (!databasePath || !mappingPath || (mode !== undefined && mode !== "--apply-offline")) {
  throw new Error("Usage: tsx src/migrate-accounts.ts DATABASE MAPPING.json [--apply-offline]. Stop the game server before applying.");
}
const apply = mode === "--apply-offline";
const db = new Database(databasePath, { readonly: !apply, fileMustExist: true });
try {
  const mapping = JSON.parse(readFileSync(mappingPath, "utf8")) as AccountMapping[];
  const rehearsal = migrateAccounts(db, mapping);
  if (apply) {
    const backup = `${databasePath}.before-accounts-${Date.now()}.db`;
    if (existsSync(backup)) throw new Error("Backup path already exists");
    await db.backup(backup);
    chmodSync(backup, 0o600);
    console.log(`Backup: ${backup}`);
    console.log(migrateAccounts(db, mapping, true));
  } else console.log(rehearsal);
} finally { db.close(); }
