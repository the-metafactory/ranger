import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
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

/**
 * Set to "1" by the test preload (test/preload.ts) and by `testCliEnv`: the
 * test-mode marker. NODE_ENV alone is not enough, since `bun test` keeps a
 * NODE_ENV the caller already set (NODE_ENV=production bun test).
 */
export const UNDER_TEST_ENV = "RANGER_UNDER_TEST";

/**
 * Test mode: the preload's marker, or NODE_ENV=test (what `bun test` sets
 * when NODE_ENV is unset). Spawned CLIs inherit either from the test's env.
 */
export function underTest(env: NodeJS.ProcessEnv = process.env): boolean {
 return env[UNDER_TEST_ENV] === "1" || env.NODE_ENV === "test";
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
 * Where `path` lands on disk once every symlink is followed, including a
 * symlinked ancestor or a dangling link SQLite would create through. When the
 * whole path does not resolve, it is walked one component at a time the way
 * the kernel walks it: a link's target is spliced in before the rest, so a
 * `..` in a target (or after a link) climbs from the link's real target, never
 * lexically from the link's own name. The part of the path that does not exist
 * yet is kept as written.
 */
export function canonicalPath(path: string): string {
 const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
 try {
  return realpathSync(absolute);
 } catch {
  // Missing, or through a dangling symlink: resolve by hand.
 }
 const pending = absolute.split(sep);
 let resolved: string = sep;
 let links = 0;
 while (pending.length > 0) {
  const part = pending.shift() as string;
  if (part === "" || part === ".") continue;
  if (part === "..") {
   resolved = dirname(resolved);
   continue;
  }
  const next = join(resolved, part);
  let link: string | undefined;
  try {
   if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
   else resolved = realpathSync(next);
  } catch {
   resolved = next;
  }
  if (link === undefined) continue;
  if (++links > 40) throw new Error(`too many symlinks resolving ${path}`);
  if (isAbsolute(link)) resolved = sep;
  pending.unshift(...link.split(sep));
 }
 return resolved;
}

/**
 * Under test, refuse a journal under the live directory unless the test opted
 * in with RANGER_TEST_ALLOW_LIVE_JOURNAL=1. `path` is already home-expanded.
 * Both sides are compared by real path, so a symlink into the live directory
 * (or a symlinked live directory) is refused too.
 */
export function assertNotLiveJournalUnderTest(
 path: string,
 opts: { env?: NodeJS.ProcessEnv; liveDir?: string } = {},
): void {
 const env = opts.env ?? process.env;
 if (path === ":memory:" || !underTest(env) || env[ALLOW_LIVE_JOURNAL_ENV] === "1") return;
 const liveDir = canonicalPath(opts.liveDir ?? liveJournalDir());
 const target = canonicalPath(path);
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

const knownHashesByFolder = new Map<string, ReadonlySet<string>>();

/**
 * Hashes of the migrations the running code ships. Read once per folder: the
 * folder is fixed for the process, and serve opens the journal on every poll.
 * The journal's own rows are still checked on every open.
 */
export function knownMigrationHashes(migrationsFolder: string): ReadonlySet<string> {
 let known = knownHashesByFolder.get(migrationsFolder);
 if (known === undefined) {
  known = new Set(readMigrationFiles({ migrationsFolder }).map((m) => m.hash));
  knownHashesByFolder.set(migrationsFolder, known);
 }
 return known;
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
