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
export function openDb(
  path: string,
  maps: readonly { repo: string; root: number }[] = [],
  legacyMapRoots: Readonly<Record<string, number>> = {},
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
  // WAL switch needs an exclusive lock — the busy handler must be armed
  // BEFORE it, or a transient WAL-recovery lock (previous process's WAL not
  // yet checkpointed) returns an immediate SQLITE_BUSY "database is locked"
  // on open (observed flaking under test load).
  sqlite.run("PRAGMA journal_mode = WAL;");
  sqlite.run("PRAGMA foreign_keys = ON;");

  const db = drizzle(sqlite, { schema });
  try {
    // This connection-local input exists only while applying the root migration.
    sqlite.run("CREATE TEMP TABLE ranger_legacy_roots (repo text PRIMARY KEY, root integer NOT NULL)");
    const roots = new Map<string, number>();
    for (const repo of new Set(maps.map(m => m.repo))) {
      const candidates = maps.filter(m => m.repo === repo);
      const explicit = legacyMapRoots[repo];
      if (explicit !== undefined && !candidates.some(m => m.root === explicit)) {
        throw new Error(`state.legacyMapRoots.${repo} must name a registered root`);
      }
      if (explicit !== undefined || candidates.length === 1) roots.set(repo, explicit ?? candidates[0].root);
    }
    for (const [repo, root] of roots) sqlite.run("INSERT INTO ranger_legacy_roots VALUES (?, ?)", [repo, root]);
    const needsRoot = (table: string) => {
      const columns = sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      return columns.length > 0 && !columns.some(c => c.name === "root");
    };
    const unresolved = new Set<string>();
    for (const table of ["workers", "escalations"]) {
      if (!needsRoot(table)) continue;
      const rows = sqlite.query(`SELECT DISTINCT repo FROM ${table}`).all() as { repo: string }[];
      for (const { repo } of rows) if (!roots.has(repo)) unresolved.add(repo);
    }
    if (unresolved.size > 0) {
      throw new Error(`Cannot backfill legacy map roots for: ${[...unresolved].sort().join(", ")}. Register one map per repo or set state.legacyMapRoots to its registered legacy root.`);
    }
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    sqlite.run("DROP TABLE ranger_legacy_roots");
  } catch (error) {
    sqlite.close();
    throw new Error(
      `Ranger journal migration failed (${MIGRATIONS_DIR}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { db, close: () => sqlite.close() };
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
  return { db: drizzle(sqlite, { schema }), close: () => sqlite.close() };
}
