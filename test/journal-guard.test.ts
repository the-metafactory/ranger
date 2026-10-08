import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expandHome, loadConfig } from "../src/config.ts";
import { createHandler, ServeReader, servedMaps, stateFromJournal } from "../src/serve.ts";
import { Journal, openJournal } from "../src/journal.ts";
import {
 assertNotLiveJournalUnderTest,
 canonicalPath,
 defaultJournalPath,
 ForeignMigrationError,
 LIVE_JOURNAL_PATH,
 liveJournalDir,
 UNDER_TEST_ENV,
 underTest,
} from "../src/journal-guard.ts";
import { runCmd } from "../src/exec.ts";
import { runNodeArgv } from "../src/spawn.ts";
import { baseConfigLines, bun, runCli } from "./support.ts";

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
  // A relative dangling link whose `..` climbs from a linked directory: the
  // kernel follows `logs` into the live directory first, then climbs to it.
  mkdirSync(join(liveDir, "logs"));
  symlinkSync(join(liveDir, "logs"), join(elsewhere, "logs-alias"));
  symlinkSync("logs-alias/../fresh.sqlite", join(elsewhere, "climb.sqlite"));
  expect(canonicalPath(join(elsewhere, "climb.sqlite"))).toBe(join(canonicalPath(liveDir), "fresh.sqlite"));
  expect(() => assertNotLiveJournalUnderTest(join(elsewhere, "climb.sqlite"), { liveDir })).toThrow("under test");
  // The same climb written straight into the path, not inside a link.
  expect(() => assertNotLiveJournalUnderTest(join(elsewhere, "logs-alias") + "/../other.sqlite", { liveDir })).toThrow(
   "under test",
  );
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

 test("test mode holds whatever NODE_ENV says: the preload's marker wins", async () => {
  expect(underTest({ [UNDER_TEST_ENV]: "1", NODE_ENV: "production" })).toBe(true);
  expect(underTest({ NODE_ENV: "test" })).toBe(true);
  expect(underTest({ NODE_ENV: "production" })).toBe(false);
  const liveDir = tempDir();
  expect(() =>
   assertNotLiveJournalUnderTest(join(liveDir, "state.sqlite"), {
    liveDir,
    env: { [UNDER_TEST_ENV]: "1", NODE_ENV: "production" },
   }),
  ).toThrow("under test");
  // The real case: `bun test` keeps NODE_ENV=production; the child gets no
  // marker from here, so only its own preload can turn test mode on.
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
  delete env[UNDER_TEST_ENV];
  const probe = "./test/fixtures/probes/production-node-env.probe.ts";
  const result = await runCmd(bun, ["test", probe], { env, cwd: join(import.meta.dir, "..") });
  expect(`${result.stdout}${result.stderr}`).toContain("1 pass");
  expect(result.code).toBe(0);
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

describe("the live wrapper (node #66)", () => {
 // The installed copy with its pinned programs swapped for stand-ins: a bun
 // that prints its argv and env, and a keychain that answers "kc-<service>".
 function stubbedWrapper(opts: { realBun?: boolean } = {}): { wrapper: string; home: string; evilBin: string } {
  const root = tempDir();
  const home = join(root, "home");
  const stubs = join(root, "stubs");
  const evilBin = join(root, "evil");
  for (const dir of [home, stubs, evilBin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(stubs, "bun"), '#!/bin/sh\necho "ARGV $*"\nenv\n', { mode: 0o755 });
  writeFileSync(join(stubs, "security"), '#!/bin/sh\necho "kc-$3"\n', { mode: 0o755 });
  for (const name of ["bun", "security", "env", "grep", "cut", "mkdir"]) {
   writeFileSync(join(evilBin, name), "#!/bin/sh\necho HIJACKED\n", { mode: 0o755 });
  }
  const source = readFileSync(join(import.meta.dir, "..", "ops", "bin", "ranger.example"), "utf8");
  for (const pinned of ["/Users/__USER__", "/opt/homebrew/bin/bun", "/usr/bin/security"]) {
   expect(source).toContain(`"${pinned}`);
  }
  const wrapper = join(root, "ranger");
  writeFileSync(
   wrapper,
   source
    .replaceAll("/Users/__USER__", home)
    .replaceAll("/opt/homebrew/bin/bun", opts.realBun ? bun : join(stubs, "bun"))
    .replaceAll("/usr/bin/security", join(stubs, "security")),
   { mode: 0o755 },
  );
  return { wrapper, home, evilBin };
 }

 // Run through the shebang (`#!/bin/bash -p`), the way launchd and a worker would.
 async function run(wrapper: string, env: NodeJS.ProcessEnv, cwd?: string) {
  const result = await runCmd(wrapper, ["tick", "--config", "ranger.yaml"], { env, cwd });
  expect(result.code).toBe(0);
  const lines = result.stdout.split("\n");
  const vars = new Map(lines.slice(1).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { argv: lines[0] ?? "", vars, stderr: result.stderr, stdout: result.stdout };
 }

 test("execs the pinned bun with ranger's own bunfig, whatever the caller sets", async () => {
  const { wrapper, home, evilBin } = stubbedWrapper();
  const cwd = tempDir();
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  const bashEnv = join(cwd, "bash-env.sh");
  writeFileSync(bashEnv, "echo BASH_ENV-RAN >&2\n");
  const out = await run(
   wrapper,
   {
    HOME: join(cwd, "evil-home"),
    PATH: `${evilBin}:/usr/bin:/bin`,
    BUN: join(evilBin, "bun"),
    SECURITY: join(evilBin, "security"),
    BASH_ENV: bashEnv,
    SHELLOPTS: "xtrace",
    "BASH_FUNC_exec%%": "() { echo FUNC-HIJACK; }",
   },
   cwd,
  );
  const ranger = join(home, "work", "mf", "ranger");
  expect(out.argv).toBe(`ARGV --config=${join(ranger, "bunfig.toml")} --no-env-file ${join(ranger, "src", "cli.ts")} tick --config ranger.yaml`);
  expect(out.stdout).not.toContain("HIJACKED");
  expect(out.stdout).not.toContain("FUNC-HIJACK");
  expect(out.stderr).toBe(""); // no BASH_ENV, no xtrace of the token exports
  expect(out.vars.get("HOME")).toBe(home);
  expect(out.vars.get("PATH")?.split(":")).not.toContain(evilBin);
  expect(out.vars.get("GH_CONFIG_DIR")).toBe(join(home, ".config", "ranger", "gh-config"));
  expect(out.vars.get("GH_TOKEN")).toBe("kc-ivy-agent");
  expect(out.vars.get("RANGER_READONLY_GH_TOKEN_PERSONAL")).toBe("kc-ranger-ro-personal");
  expect([...out.vars.keys()].some((k) => k.startsWith("BASH_FUNC_"))).toBe(false);
  expect(out.vars.has("SHELLOPTS")).toBe(false);
 });

 test("real bun loads no .env from the caller's directory", async () => {
  // A caller-controlled .env expands \$GH_TOKEN into a name the worker env
  // forwards (SAGE_*): bun's dotenv loading runs after the wrapper's clean-up.
  const { wrapper, home } = stubbedWrapper({ realBun: true });
  const ranger = join(home, "work", "mf", "ranger");
  mkdirSync(join(ranger, "src"), { recursive: true });
  writeFileSync(join(ranger, "bunfig.toml"), "");
  writeFileSync(join(ranger, "src", "cli.ts"), "console.log(JSON.stringify(process.env));\n");
  const cwd = tempDir();
  for (const name of [".env", ".env.local", ".env.development", ".env.production", ".env.test"]) {
   writeFileSync(join(cwd, name), "SAGE_LEAK=$GH_TOKEN\nFROM_DOTENV=1\n");
  }
  const result = await runCmd(wrapper, ["tick"], { env: { PATH: "/usr/bin:/bin" }, cwd });
  expect(result.code).toBe(0);
  const env = JSON.parse(result.stdout) as Record<string, string>;
  expect(env.GH_TOKEN).toBe("kc-ivy-agent"); // the CLI ran, with the token
  expect(env.SAGE_LEAK).toBeUndefined();
  expect(env.FROM_DOTENV).toBeUndefined();
 });

 test("the CLI starts in a clean environment: no overrides, no worker journal, no test mode", async () => {
  const { wrapper } = stubbedWrapper();
  const out = await run(wrapper, {
   PATH: "/usr/bin:/bin",
   TERM: "xterm",
   BUN_OPTIONS: "--preload=./evil.ts",
   DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
   GIT_SSH_COMMAND: "evil",
   CLAUDE_CONFIG_DIR: "/tmp/evil-claude",
   XDG_CONFIG_HOME: "/tmp/evil-xdg",
   RANGER_WORKER_CMD: "evil",
   RANGER_SAGE_CMD: "evil",
   RANGER_JOURNAL_PATH: "/tmp/session/state.sqlite",
   [UNDER_TEST_ENV]: "1",
   NODE_ENV: "production",
   // The wrapper's own names: a caller-exported one must not survive into the CLI.
   KEEP: " BUN_OPTIONS ",
   PASS_THROUGH: " BUN_OPTIONS ",
   gh_token: "caller",
   GH_TOKEN: "ghp_caller", // a token the caller already holds still wins
  });
  const allowed = new Set([
   "HOME", "PATH", "GH_CONFIG_DIR", "TERM", "PWD", "SHLVL", "_",
   "GH_TOKEN", "RANGER_WRITE_GH_TOKEN_METAFACTORY", "RANGER_WRITE_GH_TOKEN_PERSONAL",
   "RANGER_READONLY_GH_TOKEN_METAFACTORY", "RANGER_READONLY_GH_TOKEN_PERSONAL", "RANGER_DISCORD_TOKEN",
   "RANGER_WRITE_GL_TOKEN_GEANT", "RANGER_READONLY_GL_TOKEN_GEANT",
  ]);
  expect([...out.vars.keys()].filter((k) => !allowed.has(k))).toEqual([]);
  expect(out.vars.get("TERM")).toBe("xterm");
  expect(out.vars.get("GH_TOKEN")).toBe("ghp_caller");
  expect(out.vars.get("RANGER_WRITE_GH_TOKEN_METAFACTORY")).toBe("kc-ivy-agent");
 });
});

describe("the detached run-node spawn (node #66)", () => {
 test("bun reads ranger's bunfig and no .env from the caller's directory", async () => {
  // The child inherits the tokens and the caller's cwd: a .env there must not
  // copy \$GH_TOKEN into a forwarded name, nor a bunfig.toml preload run first.
  const ranger = tempDir();
  mkdirSync(join(ranger, "src"), { recursive: true });
  writeFileSync(join(ranger, "bunfig.toml"), "");
  const cliEntry = join(ranger, "src", "cli.ts");
  writeFileSync(cliEntry, "console.log(JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));\n");
  const cwd = tempDir();
  for (const name of [".env", ".env.local", ".env.development", ".env.production", ".env.test"]) {
   writeFileSync(join(cwd, name), "SAGE_LEAK=$GH_TOKEN\nFROM_DOTENV=1\n");
  }
  writeFileSync(join(cwd, "evil.ts"), 'console.log("PRELOADED");\n');
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  const args = { nodeId: "7", repo: "o/r", root: 1, cliEntry, configPath: "/srv/ranger.yaml" };
  const argv = runNodeArgv(args);
  expect(argv.slice(0, 2)).toEqual([`--config=${join(ranger, "bunfig.toml")}`, "--no-env-file"]);
  const result = await runCmd(bun, argv, { env: { PATH: "/usr/bin:/bin", GH_TOKEN: "ghp_live" }, cwd });
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("PRELOADED");
  const out = JSON.parse(result.stdout) as { env: Record<string, string>; argv: string[] };
  expect(out.env.GH_TOKEN).toBe("ghp_live");
  expect(out.env.SAGE_LEAK).toBeUndefined();
  expect(out.env.FROM_DOTENV).toBeUndefined();
  expect(out.argv).toEqual(["run-node", "7", "--map", "o/r#1", "--config", "/srv/ranger.yaml"]);
 });
});
