import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expandHome, loadConfig } from "../src/config.ts";
import { createHandler, ServeReader, servedMaps, stateFromJournal } from "../src/serve.ts";
import { Journal, openJournal } from "../src/journal.ts";
import {
 assertNotLiveJournalUnderTest,
 defaultJournalPath,
 ForeignMigrationError,
 LIVE_JOURNAL_PATH,
 liveJournalDir,
} from "../src/journal-guard.ts";
import { baseConfigLines, runCli } from "./support.ts";

const FOREIGN = ["f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0", "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1"];
const REFUSAL = "this journal was migrated by code this ranger isn't running";

let dirs: string[] = [];
afterEach(() => {
 for (const d of dirs) rmSync(d, { recursive: true, force: true });
 dirs = [];
});

function tempDir(): string {
 const dir = mkdtempSync(join(tmpdir(), "ranger-guard-"));
 dirs.push(dir);
 return dir;
}

/** Stamp migrations this code does not ship onto an existing journal. */
function stampForeign(path: string): void {
 const sqlite = new Database(path);
 FOREIGN.forEach((hash, i) => sqlite.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [hash, 9_000_000_000_000 + i]));
 sqlite.close();
}

/** A journal built by this code, then stamped with migrations it does not ship. */
function foreignJournal(dir: string): string {
 const path = join(dir, "state.sqlite");
 new Journal(path).close();
 stampForeign(path);
 return path;
}

function migrationRows(path: string): number {
 const sqlite = new Database(path, { readonly: true });
 const { n } = sqlite.query("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number };
 sqlite.close();
 return n;
}

describe("foreign migrations (node #66)", () => {
 test("a journal migrated by code this ranger isn't running is refused, naming the hashes", () => {
  const path = foreignJournal(tempDir());
  const rows = migrationRows(path);
  let error: unknown;
  try {
   new Journal(path);
  } catch (e) {
   error = e;
  }
  expect(error).toBeInstanceOf(ForeignMigrationError);
  expect((error as ForeignMigrationError).hashes).toEqual(FOREIGN);
  const message = (error as Error).message;
  expect(message).toContain(REFUSAL);
  for (const hash of FOREIGN) expect(message).toContain(hash);
  // It never ran against them: no migration was applied on top.
  expect(migrationRows(path)).toBe(rows);
 });

 test("the read-only open (serve) refuses it too", () => {
  const path = foreignJournal(tempDir());
  expect(() => Journal.openReadOnly(path)).toThrow(REFUSAL);
 });

 test("serve answers every state read with the refusal once its journal turns foreign mid-run", async () => {
  const dir = tempDir();
  const path = join(dir, "state.sqlite");
  new Journal(path).close();
  writeFileSync(join(dir, "ranger.yaml"), baseConfigLines(dir).join("\n"));
  const { config } = loadConfig(join(dir, "ranger.yaml"), {});
  const maps = servedMaps(config);
  const reader = new ServeReader(config, maps, path);
  const handler = createHandler({
   port: 47366,
   token: "page-key",
   getState: () => stateFromJournal(config, maps, reader),
   refresh: () => {},
   launch: () => {},
   verifyGrilling: async () => null,
  });
  const read = () => handler(new Request("http://127.0.0.1:47366/api/state"));
  expect((await read()).status).toBe(200);
  stampForeign(path);
  const refused = await read();
  expect(refused.status).toBe(503);
  const body = (await refused.json()) as { error: string };
  expect(body.error).toContain(REFUSAL);
  expect(body.error).toContain(FOREIGN[1]);
 });

 test("a journal this code migrated opens, and reopens", () => {
  const path = join(tempDir(), "state.sqlite");
  new Journal(path).close();
  const journal = new Journal(path);
  expect(journal.isPaused()).toBe(false);
  journal.close();
 });

 test("tick, run-node and serve exit 1 with the refusal, before any other work", async () => {
  const dir = tempDir();
  foreignJournal(dir);
  const config = join(dir, "ranger.yaml");
  writeFileSync(config, baseConfigLines(dir).join("\n"));
  for (const args of [["tick"], ["run-node", "5"], ["serve", "--port", "47366"]]) {
   const result = await runCli([...args, "--config", config], { PATH: process.env.PATH, HOME: process.env.HOME });
   expect({ args, code: result.code }).toEqual({ args, code: 1 });
   expect(result.stderr).toContain(REFUSAL);
   expect(result.stderr).toContain(FOREIGN[0]);
  }
 });
});

describe("the live journal under test (node #66)", () => {
 const stray = join(liveJournalDir(), `node66-guard-${randomUUID()}`);
 afterAll(() => rmSync(stray, { recursive: true, force: true }));

 test("a path under the live directory is refused under test", () => {
  const liveDir = tempDir();
  expect(() => assertNotLiveJournalUnderTest(join(liveDir, "state.sqlite"), { liveDir })).toThrow("under test");
  expect(() => assertNotLiveJournalUnderTest(join(liveDir, "a", "b.sqlite"), { liveDir })).toThrow("under test");
  expect(() => assertNotLiveJournalUnderTest(join(tempDir(), "state.sqlite"), { liveDir })).not.toThrow();
  expect(() => assertNotLiveJournalUnderTest(":memory:", { liveDir })).not.toThrow();
 });

 test("a symlink into the live directory is refused under test", () => {
  const liveDir = tempDir();
  writeFileSync(join(liveDir, "state.sqlite"), "");
  const elsewhere = tempDir();
  // A directory symlink pointing at the live directory.
  symlinkSync(liveDir, join(elsewhere, "alias"));
  expect(() => assertNotLiveJournalUnderTest(join(elsewhere, "alias", "state.sqlite"), { liveDir })).toThrow("under test");
  expect(() => assertNotLiveJournalUnderTest(join(elsewhere, "alias", "new", "x.sqlite"), { liveDir })).toThrow("under test");
  // A file symlink to the live journal, and a dangling one SQLite would create through.
  symlinkSync(join(liveDir, "state.sqlite"), join(elsewhere, "j.sqlite"));
  expect(() => assertNotLiveJournalUnderTest(join(elsewhere, "j.sqlite"), { liveDir })).toThrow("under test");
  symlinkSync(join(liveDir, "not-yet.sqlite"), join(elsewhere, "dangling.sqlite"));
  expect(() => assertNotLiveJournalUnderTest(join(elsewhere, "dangling.sqlite"), { liveDir })).toThrow("under test");
  // A symlinked live directory: the real path behind it is refused.
  symlinkSync(liveDir, join(elsewhere, "live-link"));
  expect(() => assertNotLiveJournalUnderTest(join(liveDir, "state.sqlite"), { liveDir: join(elsewhere, "live-link") })).toThrow(
   "under test",
  );
  // A sibling directory whose name only starts like the live one is not refused.
  mkdirSync(`${liveDir}-sibling`);
  dirs.push(`${liveDir}-sibling`);
  expect(() => assertNotLiveJournalUnderTest(join(`${liveDir}-sibling`, "state.sqlite"), { liveDir })).not.toThrow();
 });

 test("a test opts in explicitly; outside tests the guard is off", () => {
  const liveDir = tempDir();
  const path = join(liveDir, "state.sqlite");
  expect(() =>
   assertNotLiveJournalUnderTest(path, { liveDir, env: { NODE_ENV: "test", RANGER_TEST_ALLOW_LIVE_JOURNAL: "1" } }),
  ).not.toThrow();
  expect(() => assertNotLiveJournalUnderTest(path, { liveDir, env: {} })).not.toThrow();
 });

 test("new Journal(path) and openJournal refuse the live directory", () => {
  // A fresh subdirectory, never state.sqlite itself: a broken guard would
  // create a stray file here, not migrate the live journal.
  expect(() => new Journal(join(stray, "state.sqlite"))).toThrow("ranger's live journal directory");
  const dir = tempDir();
  const path = join(dir, "ranger.yaml");
  writeFileSync(
   path,
   ["version: 1", "maps:", "  - repo: acme/widgets", "    root: 1", "state:", `  journalPath: ~/.config/ranger/${stray.split(sep).pop()}/state.sqlite`].join("\n"),
  );
  expect(() => openJournal(loadConfig(path, {}).config)).toThrow("ranger's live journal directory");
 });
});

describe("state.journalPath (node #66)", () => {
 function configFile(lines: string[]): string {
  const path = join(tempDir(), "ranger.yaml");
  writeFileSync(path, ["version: 1", "maps:", "  - repo: acme/widgets", "    root: 1", ...lines].join("\n"));
  return path;
 }

 test("a config without state.journalPath under test does not resolve to the live file", () => {
  const path = configFile([]);
  const first = resolve(expandHome(loadConfig(path).config.state.journalPath));
  const second = resolve(expandHome(loadConfig(path).config.state.journalPath));
  expect(first).not.toBe(resolve(expandHome(LIVE_JOURNAL_PATH)));
  expect(first.startsWith(resolve(liveJournalDir()) + sep)).toBe(false);
  expect(first.startsWith(resolve(tmpdir()) + sep)).toBe(true);
  expect(second).not.toBe(first);
 });

 test("outside tests the default stays the live journal", () => {
  expect(defaultJournalPath({})).toBe(LIVE_JOURNAL_PATH);
 });

 test("RANGER_JOURNAL_PATH overrides state.journalPath", () => {
  const path = configFile(["state:", "  journalPath: /srv/ranger/state.sqlite"]);
  expect(loadConfig(path, {}).config.state.journalPath).toBe("/srv/ranger/state.sqlite");
  expect(loadConfig(path, { RANGER_JOURNAL_PATH: "/tmp/session/state.sqlite" }).config.state.journalPath).toBe(
   "/tmp/session/state.sqlite",
  );
  expect(loadConfig(path, { RANGER_JOURNAL_PATH: "" }).config.state.journalPath).toBe("/srv/ranger/state.sqlite");
  // It overrides the default too: a worktree's tracked ranger.yaml sets none.
  const bare = configFile([]);
  expect(loadConfig(bare, { RANGER_JOURNAL_PATH: "/tmp/session/state.sqlite" }).config.state.journalPath).toBe(
   "/tmp/session/state.sqlite",
  );
 });
});
