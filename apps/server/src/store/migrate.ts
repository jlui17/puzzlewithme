import pg from "pg";

const { Pool } = pg;

/**
 * Creates the `rooms` table if absent. CREATE TABLE IF NOT EXISTS is the
 * entire migration story: one table, no columns ever added/renamed yet, so a
 * real migration framework (versioned files, up/down) would be pure
 * overhead at this scale. Revisit once the schema needs to evolve under
 * existing data.
 */
export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      settings JSONB NOT NULL,
      state JSONB NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// Runnable directly (`tsx src/store/migrate.ts`) for deploy-time migration
// without booting the whole server; also safe to run redundantly since the
// migration itself is idempotent.
async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run the migration");
  }
  const pool = new Pool({ connectionString });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

// import.meta.url check keeps `main` from firing when this module is
// imported by PostgresRoomStore/tests rather than executed as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error("migration failed", err);
    process.exitCode = 1;
  });
}
