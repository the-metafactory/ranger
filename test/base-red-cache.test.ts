import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { runCmd, type RunResult } from "../src/exec.ts";
import * as gitOps from "../src/git-ops.ts";
import { baseRedNote, probeMarker, probeMergeBase, recordedProbes, type ImplementContext } from "../src/implement.ts";
import { Journal } from "../src/journal.ts";
import { openDb } from "../src/store/db.ts";
import { seedLegacyRoots } from "../src/store/legacy-roots.ts";
import { baseConfigLines, createCanonicalRepo, GIT_ENV } from "./support.ts";

const HUD = "probe-hud.mjs";
const WEAPON = "probe-weapon.mjs";
const realSafeGit = gitOps.safeGit;
const failed = (checks = ["draws"], kind = "assert", probe = HUD): RunResult => ({
 code: 1,
 stdout: [`FAIL ${probe} (0.1s) exit=1 ${kind}`, ...checks.map((c) => `     │  FAIL  ${c} — detail`), `FAILED: ${probe}`].join("\n"),
 stderr: "",
});
const pass: RunResult = { code: 0, stdout: `ok   ${HUD} (0.1s)\n`, stderr: "" };

describe("twice-confirmed base-red cache (node #151)", () => {
 let dir: string;
 let ctx: ImplementContext;
 let sha: string;
 let calls: { command: string; cwd: string }[];
 let answers: RunResult[];
 let hostReads: number;
 let gitSpy: ReturnType<typeof spyOn<typeof gitOps, "safeGit">>;
 const key = (probe = HUD, repo = "acme/widgets", base = sha) => `base-red-checks.${repo}.${base}.${probe}`;
 const compare = (head = failed()) => probeMergeBase(ctx, [HUD], head.stdout);

 beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ranger-base-cache-test-"));
  const { canonical } = await createCanonicalRepo(dir);
  mkdirSync(join(canonical, "scripts"));
  for (const probe of [HUD, WEAPON]) writeFileSync(join(canonical, "scripts", probe), `// ${probe}\n`);
  const git = (args: string[]) => runCmd("git", args, { cwd: canonical, env: { ...process.env, ...GIT_ENV } });
  expect((await git(["add", "-A"])).code).toBe(0);
  expect((await git(["commit", "-m", "seed probes"])).code).toBe(0);
  expect((await git(["push", "origin", "main"])).code).toBe(0);
  sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const configPath = join(dir, "ranger.yaml");
  writeFileSync(configPath, baseConfigLines(dir).join("\n"));
  const { config } = loadConfig(configPath);
  const map = config.maps[0];
  map.commands.probeRetry = "fake-probe {node} {failed}";
  const node = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/data/acme__widgets-node-1.json"), "utf8"));
  calls = [];
  answers = [failed(), failed()];
  hostReads = 0;
  ctx = {
   config, map, node, rootNode: node, canonical, worktree: canonical,
   journal: new Journal(join(dir, "journal.sqlite"), openDb(":memory:", (db) => seedLegacyRoots(db, [], {}))),
   token: "test", readOnlyToken: "test-read", botIdentity: "ivy-agent",
   branch: "main", generation: 0, ratify: "auto", sessionJournal: join(dir, "session.sqlite"),
   workerRun: async () => pass,
   shellRun: async (command, opts) => {
    calls.push({ command, cwd: opts.cwd! });
    const result = answers.shift();
    if (result === undefined) throw new Error("unexpected base run");
    return result;
   },
   hostLoad: () => { hostReads++; return { load: 0, cores: 1 }; },
  };
  gitSpy = spyOn(gitOps, "safeGit");
 });
 afterEach(() => {
  gitSpy.mockRestore();
  ctx.journal.close();
  rmSync(dir, { recursive: true, force: true });
 });

 test("two equal base assertion sets are cached; same worktree, no second quiet-host wait", async () => {
  answers = [failed(["draws", "mounts"]), failed(["mounts", "draws"])];
  expect(await compare()).toMatchObject({ sha, red: [HUD], cached: [] });
  expect(JSON.parse(ctx.journal.getHealth(key())!)).toEqual(["draws", "mounts"]);
  expect(calls.map((c) => c.command)).toEqual([`fake-probe 1 ${HUD}`, `fake-probe 1 ${HUD}`]);
  expect(calls[0].cwd).toBe(calls[1].cwd);
  expect(hostReads).toBe(1);
 });

 for (const [name, confirmation] of [
  ["passes", pass], ["different checks", failed(["other"])], ["fewer checks", failed([])],
  ["more checks", failed(["draws", "extra"])], ["crashes", failed(["draws"], "crash")],
  ["times out", { ...failed(), code: -1 }], ["no named failures", { ...failed(), stdout: "" }],
 ] as const) {
  test(`confirmation ${name}: no cache, first comparison still inherits for this PR`, async () => {
   answers = [failed(), confirmation];
   expect(await compare()).toMatchObject({ red: [HUD], cached: [] });
   expect(ctx.journal.getHealth(key())).toBeNull();
   expect(calls).toHaveLength(2);
  });
 }

 test("cached subset reused for a later PR without a base worktree, shell run or host read", async () => {
  answers = [failed(["draws", "mounts"]), failed(["draws", "mounts"])];
  await compare();
  gitSpy.mockClear();
  calls = [];
  hostReads = 0;
  ctx.node = { ...ctx.node, ref: { id: "151" } };
  const result = await compare();
  expect(result).toMatchObject({ sha, red: [HUD], cached: [HUD] });
  expect(calls).toEqual([]);
  expect(hostReads).toBe(0);
  expect(gitSpy.mock.calls.some(([args]) => args[0] === "worktree")).toBe(false);
 });

 test("a cache hit needs no retry template; uncached failures still gate without one", async () => {
  ctx.map.commands.probeRetry = undefined;
  expect(await compare()).toMatchObject({ red: [], cached: [], unresolved: [HUD] });
  ctx.journal.setHealth(key(), JSON.stringify(["draws"]));
  expect(await compare()).toMatchObject({ red: [HUD], cached: [HUD], unresolved: [] });
  expect(calls).toEqual([]);
  expect(hostReads).toBe(0);
 });

 test("failed base worktree creation leaves fresh probes unresolved", async () => {
  gitSpy.mockImplementation((args, opts) => args[0] === "worktree" && args[1] === "add"
   ? Promise.resolve({ code: 1, stdout: "", stderr: "cannot create worktree" })
   : realSafeGit(args, opts));
  expect(await compare()).toMatchObject({ red: [], unresolved: [HUD] });
  expect(calls).toEqual([]);
  expect(hostReads).toBe(0);
  expect(ctx.journal.getHealth(key())).toBeNull();
 });

 test("failed base install leaves fresh probes unresolved", async () => {
  ctx.map.commands.install = "fake-install";
  answers = [{ code: 1, stdout: "", stderr: "install failed" }];
  expect(await compare()).toMatchObject({ red: [], unresolved: [HUD] });
  expect(calls.map((c) => c.command)).toEqual(["fake-install"]);
  expect(hostReads).toBe(0);
  expect(ctx.journal.getHealth(key())).toBeNull();
 });

 for (const [name, answer] of [
  ["unnamed failure", { code: 1, stdout: "runner failed", stderr: "" }],
  ["timeout", { ...failed(), code: -1 }],
 ] as const) {
  test(`base ${name} leaves fresh probes unresolved alongside cached results`, async () => {
   ctx.journal.setHealth(key(), JSON.stringify(["draws"]));
   answers = [answer];
   const head = `${failed().stdout}\n${failed(["fires"], "assert", WEAPON).stdout}`;
   expect(await probeMergeBase(ctx, [HUD, WEAPON], head)).toMatchObject({
    red: [HUD], cached: [HUD], unresolved: [WEAPON], differs: [], passed: [],
   });
   expect(calls).toHaveLength(1);
   expect(ctx.journal.getHealth(key(WEAPON))).toBeNull();
  });
 }

 for (const [name, answer] of [["pass", pass], ["inherited assertion", failed()], ["different assertion", failed(["other"])]] as const) {
  test(`fresh comparison with ${name} clears unresolved probes`, async () => {
   answers = [answer, failed()];
   expect(await compare()).toMatchObject({ unresolved: [] });
  });
 }

 for (const [name, head] of [
  ["uncovered check", failed(["draws", "extra"])], ["no checks", failed([])],
  ["crash", failed(["draws"], "crash")], ["kill", failed(["draws"], "killed")],
  ["timeout", failed(["draws"], "timeout")], ["unknown kind", failed(["draws"], "unknown")],
 ] as const) {
  test(`valid cache with ${name} gates without a fresh base run`, async () => {
   ctx.journal.setHealth(key(), JSON.stringify(["draws"]));
   expect(await compare(head)).toMatchObject({ red: [], cached: [] });
   expect(calls).toEqual([]);
   expect(hostReads).toBe(0);
  });
 }

 for (const [name, entryKey] of [
  ["another SHA", () => key(HUD, "acme/widgets", "a".repeat(40))],
  ["another repo", () => key(HUD, "other/widgets")],
  ["another probe", () => key(WEAPON)],
 ] as const) {
  test(`${name} is a miss`, async () => {
   ctx.journal.setHealth(entryKey(), JSON.stringify(["draws"]));
   expect(await compare()).toMatchObject({ red: [HUD], cached: [] });
   expect(calls).toHaveLength(2);
  });
 }

 for (const value of ["{", "null", "{}", "[]", '[1]', '[""]']) {
  test(`unreadable or invalid cache ${value} is a fresh comparison`, async () => {
   ctx.journal.setHealth(key(), value);
   expect(await compare()).toMatchObject({ red: [HUD], cached: [] });
   expect(calls).toHaveLength(2);
  });
 }

 test("base passes or fails a different check: no confirmation and no entry", async () => {
  for (const answer of [pass, failed(["other"]), failed(["draws"], "crash")]) {
   answers = [answer];
   calls = [];
   expect(await compare()).toMatchObject({ red: [], cached: [] });
   expect(calls).toHaveLength(1);
   expect(ctx.journal.getHealth(key())).toBeNull();
  }
 });

 test("mixed cached and fresh probes confirm only the fresh probe", async () => {
  ctx.journal.setHealth(key(), JSON.stringify(["draws"]));
  const weapon = failed(["fires"], "assert", WEAPON);
  answers = [weapon, weapon];
  const result = await probeMergeBase(ctx, [HUD, WEAPON], `${failed().stdout}\n${weapon.stdout}`);
  expect(result).toMatchObject({ red: [HUD, WEAPON], cached: [HUD] });
  expect(calls.map((c) => c.command)).toEqual([`fake-probe 1 ${WEAPON}`, `fake-probe 1 ${WEAPON}`]);
  expect(ctx.journal.getHealth(key(WEAPON))).toBe('["fires"]');
 });

 test("confirmation covering the head but losing another base check is not cached", async () => {
  answers = [failed(["draws", "mounts"]), failed(["draws"])];
  expect(await compare()).toMatchObject({ red: [HUD] });
  expect(ctx.journal.getHealth(key())).toBeNull();
 });

 test("cache is per probe: only stable assertions from a mixed confirmation are written", async () => {
  const both = {
   ...failed(),
   stdout: `${failed().stdout.replace(/^FAILED:.*$/m, "")}\n${failed(["fires"], "assert", WEAPON).stdout.replace(/^FAILED:.*$/m, "")}\nFAILED: ${HUD} · ${WEAPON}`,
  };
  answers = [both, failed()];
  expect(await probeMergeBase(ctx, [HUD, WEAPON], both.stdout)).toMatchObject({ red: [HUD, WEAPON] });
  expect(ctx.journal.getHealth(key())).toBe('["draws"]');
  expect(ctx.journal.getHealth(key(WEAPON))).toBeNull();
 });

 test("an edited probe cannot inherit a valid cache entry", async () => {
  ctx.journal.setHealth(key(), JSON.stringify(["draws"]));
  writeFileSync(join(ctx.worktree, "scripts", HUD), "// changed\n");
  expect((await runCmd("git", ["add", "-A"], { cwd: ctx.worktree })).code).toBe(0);
  expect((await runCmd("git", ["commit", "-m", "edit probe"], { cwd: ctx.worktree, env: { ...process.env, ...GIT_ENV } })).code).toBe(0);
  expect(await compare()).toMatchObject({ red: [], changed: [HUD] });
  expect(calls).toEqual([]);
 });

 test("cached provenance survives PR marker round trip and is visible in the note", () => {
  const record = { sha, passed: true, selected: "1", mode: "semantic", baseRed: [HUD], baseRedCache: { sha, probes: [HUD] } };
  expect(recordedProbes([{ id: 1, author: "ivy-agent", body: probeMarker(record) }], "ivy-agent")).toEqual([record]);
  expect(baseRedNote(record)).toContain(`Base result from cache at ${sha}: ${HUD}`);
 });
});
