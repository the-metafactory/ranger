import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";
import { assertKnownMigrations } from "../journal-guard.ts";

export type RangerDb = BunSQLiteDatabase<typeof schema>;

/** Source-tree migrations dir — the monorepo convention (reflex/cue). */
const MIGRATIONS_DIR = join(import.meta.dir, "../../drizzle");

/**
 * Open (creating if needed) the ranger journal: WAL mode, busy timeout, then
 * run committed migrations before returning. The journal holds operator-private
 * state (spend ledger, vetoes) — 0700 dir, 0600 files (reflex R-103 convention).
 * A journal carrying a migration this code does not ship is refused before
 * anything writes it (node #66).
 */
export function openDb(
  path: string,
  beforeMigrate?: (sqlite: Database) => void,
): { db: RangerDb; close: () => void } {
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
  refuseForeignMigrations(sqlite, path);
  // WAL switch needs an exclusive lock — the busy handler must be armed
  // BEFORE it, or a transient WAL-recovery lock (previous process's WAL not
  // yet checkpointed) returns an immediate SQLITE_BUSY "database is locked"
  // on open (observed flaking under test load).
  // Two processes switching a brand-new file to WAL at once: the loser can
  // get SQLITE_BUSY without the busy handler being consulted. The mode is
  // persistent, so a retry finds it set and is a no-op.
  try {
    retryLostRace(() => sqlite.run("PRAGMA journal_mode = WAL;"));
  } catch (error) {
    sqlite.close();
    throw error;
  }
  sqlite.run("PRAGMA foreign_keys = ON;");

  const db = drizzle(sqlite, { schema });
  try {
    migrateWithRetry(db, () => beforeMigrate?.(sqlite));
  } catch (error) {
    sqlite.close();
    throw new Error(
      `Ranger journal migration failed (${MIGRATIONS_DIR}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { db, close: () => sqlite.close() };
}

/** Close the handle and rethrow when the journal was migrated by foreign code. */
function refuseForeignMigrations(sqlite: Database, path: string): void {
  try {
    assertKnownMigrations(sqlite, path, MIGRATIONS_DIR);
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/** Attempts at a step that can lose an open race before its error stands. */
const RACE_ATTEMPTS = 5;

/**
 * Run the committed migrations, retrying a lost race with another process.
 *
 * drizzle's migrator reads the last applied migration OUTSIDE its
 * transaction, then opens a deferred `BEGIN`. Two processes opening one
 * journal at once (a fresh journal, or the first open after a new migration
 * lands) both read "not applied" and both apply it. The loser fails: with
 * `database is locked` when its stale read snapshot cannot take the write
 * lock (busy_timeout does not wait out a stale WAL snapshot), or with
 * "table already exists" once the winner has committed. Its transaction rolls
 * back whole, so a retry re-reads `__drizzle_migrations`, finds the winner's
 * rows, and applies only what is still missing. A migration that is broken on
 * its own fails every attempt and its error stands.
 *
 * The `beforeMigrate` hook is retried with it: the legacy-roots seed
 * (`legacy-roots.ts`) reads the schema then writes in a deferred transaction,
 * so it loses the same race, and it is idempotent (`IF NOT EXISTS`,
 * `INSERT OR REPLACE`, and nothing once the root column exists).
 */
function migrateWithRetry(db: RangerDb, beforeMigrate: () => void): void {
  retryLostRace(() => {
    beforeMigrate();
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  });
}

/**
 * How long a loser still waiting on the lock keeps retrying, however many
 * attempts that takes. On a starved CPU the winner's migrations can hold the
 * write lock past five quick attempts (2026-10-08: CI running four test files
 * at once failed the open-race test with "database is locked"). Any other
 * error stands after the five.
 */
const RACE_WINDOW_MS = 10_000;
const LOCKED = /database is locked|SQLITE_BUSY/i;

/** Run `fn`, retrying it after a jittered pause; its last error stands. */
function retryLostRace(fn: () => void): void {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      fn();
      return;
    } catch (error) {
      const waiting = LOCKED.test(String(error)) && Date.now() - started < RACE_WINDOW_MS;
      if (attempt >= RACE_ATTEMPTS && !waiting) throw error;
      // Jittered, so two losers do not collide again in lockstep.
      Bun.sleepSync(Math.min(25 * attempt, 250) + Math.floor(Math.random() * 50));
    }
  }
}

/**
 * Open an existing journal for reading only (#37, `ranger serve`): no create,
 * no chmod, no migration and no WAL switch, because the tick and the run-node
 * supervisors own the file and write it while the dashboard reads. Returns
 * `null` when there is no journal yet.
 */
export function openDbReadOnly(
  path: string,
): { db: RangerDb; close: () => void } | null {
  if (!existsSync(path)) return null;
  const sqlite = new Database(path, { readonly: true });
  sqlite.run("PRAGMA busy_timeout = 5000;");
  refuseForeignMigrations(sqlite, path);
  return { db: drizzle(sqlite, { schema }), close: () => sqlite.close() };
}
