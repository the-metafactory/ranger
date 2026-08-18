import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";

export type RangerDb = BunSQLiteDatabase<typeof schema>;

/** Source-tree migrations dir — the monorepo convention (reflex/cue). */
const MIGRATIONS_DIR = join(import.meta.dir, "../../drizzle");

/**
 * Open (creating if needed) the ranger journal: WAL mode, busy timeout, then
 * run committed migrations before returning. The journal holds operator-private
 * state (spend ledger, vetoes) — 0700 dir, 0600 files (reflex R-103 convention).
 */
export function openDb(path: string): { db: RangerDb; close: () => void } {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  let sqlite: Database;
  try {
    sqlite = new Database(path, { create: true });
  } catch (error) {
    throw new Error(
      `Cannot open ranger journal at ${path}: ${(error as Error).message} — another ranger instance running?`,
    );
  }
  if (path !== ":memory:") {
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = `${path}${suffix}`;
      if (suffix === "" || existsSync(f)) chmodSync(f, 0o600);
    }
  }
  sqlite.run("PRAGMA busy_timeout = 5000;");
  // WAL switch needs an exclusive lock — the busy handler must be armed
  // BEFORE it, or a transient WAL-recovery lock (previous process's WAL not
  // yet checkpointed) returns an immediate SQLITE_BUSY "database is locked"
  // on open (observed flaking under test load).
  sqlite.run("PRAGMA journal_mode = WAL;");
  sqlite.run("PRAGMA foreign_keys = ON;");

  const db = drizzle(sqlite, { schema });
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } catch (error) {
    sqlite.close();
    throw new Error(
      `Ranger journal migration failed (${MIGRATIONS_DIR}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { db, close: () => sqlite.close() };
}
