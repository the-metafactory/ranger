import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";

/**
 * Keeps branch code off ranger's live journal (node #66). On 2026-10-04 the
 * live journal carried two migrations `main` did not have (node #47's
 * re-keyed `workers`, node #25's `0017_research-base`): code from a worktree
 * had opened it, because the migrations folder resolves relative to the
 * running code and the default `state.journalPath` is the live file. `main`'s
 * claim then failed on every node, after the GitHub claim.
 *
 * Three closures: a journal migrated by code ranger isn't running refuses to
 * open; under `bun test` the live directory is refused outright; and worker
 * sessions get `RANGER_JOURNAL_PATH`, a per-session temp journal.
 */

/** The env var that overrides `state.journalPath` (worker sessions only). */
export const JOURNAL_PATH_ENV = "RANGER_JOURNAL_PATH";

/** A test sets this to "1" to open a journal under the live directory anyway. */
export const ALLOW_LIVE_JOURNAL_ENV = "RANGER_TEST_ALLOW_LIVE_JOURNAL";

/** The live default journal, as `state.journalPath` spells it outside tests. */
export const LIVE_JOURNAL_PATH = "~/.config/ranger/state.sqlite";

/** The directory the live journal and its siblings (logs, views, locks) live in. */
export function liveJournalDir(): string {
 return join(homedir(), ".config", "ranger");
}

/** `bun test` sets NODE_ENV=test; spawned CLIs inherit it from the test's env. */
export function underTest(env: NodeJS.ProcessEnv = process.env): boolean {
 return env.NODE_ENV === "test";
}

/**
 * Under test, a fresh temp journal per config: a config without
 * `state.journalPath` must never resolve to the live file. Outside tests,
 * the live default.
 */
export function defaultJournalPath(env: NodeJS.ProcessEnv = process.env): string {
 if (!underTest(env)) return LIVE_JOURNAL_PATH;
 return join(tmpdir(), `ranger-test-journal-${process.pid}-${randomUUID()}`, "state.sqlite");
}

/** The `RANGER_JOURNAL_PATH` override, when set and non-empty. */
export function journalPathOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
 const value = env[JOURNAL_PATH_ENV]?.trim();
 return value === undefined || value === "" ? undefined : value;
}

/**
 * Under test, refuse a journal under the live directory unless the test opted
 * in with RANGER_TEST_ALLOW_LIVE_JOURNAL=1. `path` is already home-expanded.
 */
export function assertNotLiveJournalUnderTest(
 path: string,
 opts: { env?: NodeJS.ProcessEnv; liveDir?: string } = {},
): void {
 const env = opts.env ?? process.env;
 if (path === ":memory:" || !underTest(env) || env[ALLOW_LIVE_JOURNAL_ENV] === "1") return;
 const liveDir = resolve(opts.liveDir ?? liveJournalDir());
 const target = resolve(path);
 if (target === liveDir || target.startsWith(liveDir + sep)) {
  throw new Error(
   `refusing to open ${target} under test: it is in ranger's live journal directory (${liveDir}). ` +
    `Give the test config a temp state.journalPath (set ${ALLOW_LIVE_JOURNAL_ENV}=1 only to opt in deliberately).`,
  );
 }
}

/** A journal migrated by code this ranger isn't running. */
export class ForeignMigrationError extends Error {
 override readonly name = "ForeignMigrationError";
 constructor(
  readonly path: string,
  readonly hashes: string[],
 ) {
  super(
   `refusing to open the ranger journal at ${path}: this journal was migrated by code this ranger isn't running ` +
    `(${hashes.length} migration${hashes.length === 1 ? "" : "s"} not in its migrations folder: ${hashes.join(", ")}). ` +
    `Repair it before ranger runs again (docs/journal-repair.md).`,
  );
 }
}

/** Hashes of the migrations the running code ships. */
export function knownMigrationHashes(migrationsFolder: string): Set<string> {
 return new Set(readMigrationFiles({ migrationsFolder }).map((m) => m.hash));
}

/**
 * Refuse a journal whose `__drizzle_migrations` holds a hash the running
 * code's migrations folder does not. Runs before anything writes the file.
 * A journal without the table (new, or never migrated) passes.
 */
export function assertKnownMigrations(sqlite: Database, path: string, migrationsFolder: string): void {
 const table = sqlite
  .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
  .get();
 if (table === null) return;
 const known = knownMigrationHashes(migrationsFolder);
 const rows = sqlite.query("SELECT hash FROM __drizzle_migrations ORDER BY id").all() as { hash: string }[];
 const foreign = rows.map((r) => r.hash).filter((hash) => !known.has(hash));
 if (foreign.length > 0) throw new ForeignMigrationError(path, foreign);
}

/**
 * A per-session temp journal for a worker session and the commands that run
 * its code: anything in there that opens a journal opens this one.
 */
export function sessionJournalPath(): string {
 return join(mkdtempSync(join(tmpdir(), "ranger-session-journal-")), "state.sqlite");
}
