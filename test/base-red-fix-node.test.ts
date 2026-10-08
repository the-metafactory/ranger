import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import * as exec from "../src/exec.ts";
import { runCmd, type RunResult } from "../src/exec.ts";
import { FixNodeLockBusy, withFixNodeLock } from "../src/fix-node-lock.ts";
import { GraphAddUnattached, graphAdd, graphLink, GraphWriteError, type AddSpec } from "../src/graph-write.ts";
import { baseRedFixKey, fileBaseRedFixNodes, probeMergeBase, type FixNodeGraph, type ImplementContext } from "../src/implement.ts";
import { Journal } from "../src/journal.ts";
import { openDb } from "../src/store/db.ts";
import { seedLegacyRoots } from "../src/store/legacy-roots.ts";
import { baseConfigLines, createCanonicalRepo, GIT_ENV } from "./support.ts";

const HUD = "probe-hud.mjs";
const failed = (checks = ["draws"], kind = "assert"): RunResult => ({
 code: 1,
 stdout: [`FAIL ${HUD} (0.1s) exit=1 ${kind}`, ...checks.map((c) => `     │  FAIL  ${c} — detail`), `FAILED: ${HUD}`].join("\n"),
 stderr: "",
});
const pass: RunResult = { code: 0, stdout: `ok   ${HUD} (0.1s)\n`, stderr: "" };
const PR = { number: 42, url: "https://github.com/acme/widgets/pull/42" };
const LATER = "b".repeat(40);

describe("fix-the-base node for a confirmed base-red probe (node #152)", () => {
 let dir: string;
 let ctx: ImplementContext;
 let sha: string;
 let answers: RunResult[];
 let added: { parent: string; spec: AddSpec }[];
 let statuses: Map<string, string>;
 let addFails: Error | null;
 let statusFails: Error | null;
 let linkFails: Error | null;
 let linked: { node: string; parent: string }[];
 let addDelayMs: number;
 let nextNode: number;

 const fakeGraph: FixNodeGraph = {
  add: async (parent, spec) => {
   added.push({ parent, spec });
   if (addDelayMs > 0) await Bun.sleep(addDelayMs);
   if (addFails !== null) throw addFails;
   const node = String(nextNode++);
   statuses.set(node, "open");
   return { node };
  },
  link: async (node, parent) => {
   linked.push({ node, parent });
   if (linkFails !== null) throw linkFails;
  },
  status: async (id) => {
   if (statusFails !== null) throw statusFails;
   return statuses.get(id) ?? "open";
  },
 };
 const events = () => ctx.journal.listEvents(ctx.map.repo, 200).map((e) => e.detail ?? "");
 /** The confirmation path: a fresh base comparison that confirms, then the filer. */
 const confirmAndFile = async (head = failed()) => {
  const base = await probeMergeBase(ctx, [HUD], head.stdout);
  await fileBaseRedFixNodes(ctx, base!, PR);
  return base!;
 };

 beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ranger-base-fix-test-"));
  const { canonical } = await createCanonicalRepo(dir);
  mkdirSync(join(canonical, "scripts"));
  writeFileSync(join(canonical, "scripts", HUD), `// ${HUD}\n`);
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
  answers = [failed(["draws", "mounts"]), failed(["mounts", "draws"])];
  added = [];
  statuses = new Map();
  addFails = null;
  statusFails = null;
  linkFails = null;
  linked = [];
  addDelayMs = 0;
  nextNode = 300;
  ctx = {
   config, map, node, rootNode: node, canonical, worktree: canonical,
   journal: new Journal(join(dir, "journal.sqlite"), openDb(":memory:", (db) => seedLegacyRoots(db, [], {}))),
   token: "ghp_machine", readOnlyToken: "ghp_principal_read", botIdentity: "ivy-agent",
   branch: "main", generation: 0, ratify: "auto", sessionJournal: join(dir, "session.sqlite"),
   workerRun: async () => pass,
   shellRun: async () => {
    const result = answers.shift();
    if (result === undefined) throw new Error("unexpected base run");
    return result;
   },
   hostLoad: () => ({ load: 0, cores: 1 }),
   fixNode: fakeGraph,
  };
 });
 afterEach(() => {
  ctx.journal.close();
  rmSync(dir, { recursive: true, force: true });
 });

 test("the cache's first entry files one propose build node below the detecting node", async () => {
  const base = await confirmAndFile();
  expect(base.confirmed).toEqual([HUD]);
  expect(added).toHaveLength(1);
  const [{ parent, spec }] = added;
  expect(parent).toBe(ctx.node.ref.id);
  expect(spec).toMatchObject({ autonomy: "propose", kind: "build", labels: ["orienteer:build"] });
  expect(spec.checkpoint).toBe(`base-green-probe-hud-${sha.slice(0, 8)}`);
  expect(spec.title).toContain(HUD);
  expect(spec.body).toContain(`\`${HUD}\``);
  expect(spec.body).toContain("draws\nmounts");
  expect(spec.body).toContain(sha);
  expect(spec.body).toContain(`node #${ctx.node.ref.id}`);
  expect(spec.body).toContain(`PR #42 (${PR.url})`);
  expect(spec.body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d/i);
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!)).toMatchObject({ node: "300", sha, pr: 42 });
  expect(events().some((d) => d.includes(`filed fix-the-base node #300 below #${ctx.node.ref.id}`))).toBe(true);
 });

 test("a cache hit without the map's record files the node", async () => {
  ctx.journal.setHealth(`base-red-checks.acme/widgets.${sha}.${HUD}`, JSON.stringify(["draws"]));
  answers = [];
  expect(await confirmAndFile(failed(["draws"]))).toMatchObject({ cached: [HUD], confirmed: [] });
  expect(added).toHaveLength(1);
  expect(added[0].spec.body).toContain("draws");
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!)).toMatchObject({ node: "300", sha });
 });

 test("a cache hit at the merge base the map already filed for files nothing and reads nothing, open or closed", async () => {
  await confirmAndFile();
  statusFails = new Error("no status read expected");
  for (const status of ["open", "closed"]) {
   statuses.set("300", status);
   answers = [];
   expect(await confirmAndFile()).toMatchObject({ cached: [HUD], confirmed: [] });
  }
  expect(added).toHaveLength(1);
  expect(events().some((d) => d.includes("no status read expected"))).toBe(false);
 });

 test("an unconfirmed comparison files nothing", async () => {
  answers = [failed(), pass];
  expect(await confirmAndFile()).toMatchObject({ unconfirmed: [HUD], confirmed: [], cached: [] });
  expect(added).toEqual([]);
 });

 test("an open fix node for the same map and probe is not filed again", async () => {
  await confirmAndFile();
  await fileBaseRedFixNodes(ctx, { sha: LATER, confirmed: [HUD] }, PR);
  expect(added).toHaveLength(1);
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!).node).toBe("300");
  expect(events().some((d) => d.includes(`fix-the-base node #300 for ${HUD} is open — not filing another`))).toBe(true);
 });

 test("the record is per map: another map on the same base files its own node from the cache hit", async () => {
  await confirmAndFile();
  ctx.map = { ...ctx.map, root: 460 };
  answers = [];
  expect(await confirmAndFile()).toMatchObject({ cached: [HUD], confirmed: [] });
  expect(added).toHaveLength(2);
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!)).toMatchObject({ node: "301", sha });
 });

 test("once the earlier fix node is closed, a later base confirmed red files a new node", async () => {
  await confirmAndFile();
  statuses.set("300", "closed");
  await fileBaseRedFixNodes(ctx, { sha: LATER, confirmed: [HUD] }, PR);
  expect(added).toHaveLength(2);
  expect(added[1].spec.checkpoint).toBe(`base-green-probe-hud-${LATER.slice(0, 8)}`);
  expect(added[1].spec.body).toContain(LATER);
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!)).toMatchObject({ node: "301", sha: LATER });
 });

 test("a failed add leaves the verdict, journals the failure and is retried at the next cache hit", async () => {
  addFails = new GraphWriteError("soma graph add below 1 (acme/widgets) failed (exit 1): boom");
  const base = await confirmAndFile();
  expect(base).toMatchObject({ red: [HUD], confirmed: [HUD], unconfirmed: [] });
  expect(ctx.journal.getHealth(`base-red-checks.acme/widgets.${sha}.${HUD}`)).toBe('["draws","mounts"]');
  expect(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))).toBeNull();
  expect(events().some((d) => d.includes(`fix-the-base filing for ${HUD} at ${sha.slice(0, 8)} failed (retried the next time it is found red at a merge base)`) && d.includes("boom"))).toBe(true);
  addFails = null;
  answers = [];
  expect(await confirmAndFile()).toMatchObject({ cached: [HUD], confirmed: [] });
  expect(added).toHaveLength(2);
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!).node).toBe("300");
 });

 test("an unreadable earlier fix node files nothing and keeps the record for the next confirmation", async () => {
  await confirmAndFile();
  statusFails = new Error("rate limited");
  await fileBaseRedFixNodes(ctx, { sha: LATER, confirmed: [HUD] }, PR);
  expect(added).toHaveLength(1);
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!).node).toBe("300");
  expect(events().some((d) => d.includes("failed (retried the next time it is found red at a merge base): rate limited"))).toBe(true);
 });

 test("the default port writes under the machine account's token, never the principal's", async () => {
  ctx.fixNode = undefined;
  const spy = spyOn(exec, "runCmd").mockImplementation(async (cmd, _args, opts) => {
   expect(cmd).toBe("soma");
   expect(opts?.env?.GH_TOKEN).toBe("ghp_machine");
   expect(opts?.env?.GITHUB_TOKEN).toBe("ghp_machine");
   expect(JSON.stringify(opts?.env)).not.toContain("ghp_principal_read");
   expect(opts?.env?.SOMA_GRAPH_READONLY).toBeUndefined();
   return { code: 0, stdout: JSON.stringify({ repo: "acme/widgets", node: "77", parent: "1", blockedBy: [] }), stderr: "" };
  });
  try {
   await fileBaseRedFixNodes(ctx, { sha, confirmed: [HUD] }, PR);
   expect(spy).toHaveBeenCalledTimes(1);
   const args = spy.mock.calls[0][1];
   expect(args.slice(0, 3)).toEqual(["graph", "add", "1"]);
   expect(args).toContain("--json");
   expect(args[args.indexOf("--repo") + 1]).toBe("github:github.com/acme/widgets");
   expect(args[args.indexOf("--autonomy") + 1]).toBe("propose");
   expect(args[args.indexOf("--kind") + 1]).toBe("build");
   expect(args[args.indexOf("--label") + 1]).toBe("orienteer:build");
   expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!).node).toBe("77");
  } finally {
   spy.mockRestore();
  }
 });

 test("graphAdd: a created but unattached node is a failure that names it", async () => {
  const spy = spyOn(exec, "runCmd").mockResolvedValue({
   code: 1, stdout: "", stderr: JSON.stringify({ repo: "acme/widgets", node: "88", parent: "1", attached: false }),
  });
  try {
   const add = graphAdd("acme/widgets", "1", { title: "t", autonomy: "propose", checkpoint: "c" }, "ghp_machine");
   await expect(add).rejects.toThrow(GraphAddUnattached);
   await expect(add).rejects.toThrow("created 88 but left it unattached");
   await expect(add).rejects.toMatchObject({ node: "88", parent: "1" });
  } finally {
   spy.mockRestore();
  }
 });

 test("graphAdd: a failure without a payload is a plain write error", async () => {
  const spy = spyOn(exec, "runCmd").mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });
  try {
   const add = graphAdd("acme/widgets", "1", { title: "t", autonomy: "propose", checkpoint: "c" }, "ghp_machine");
   await expect(add).rejects.toThrow(GraphWriteError);
   await expect(add).rejects.not.toThrow(GraphAddUnattached);
  } finally {
   spy.mockRestore();
  }
 });

 test("an add that leaves its node unattached is recorded, and the next confirmation links it instead of adding", async () => {
  addFails = new GraphAddUnattached("soma graph add below 1 (acme/widgets) failed (exit 1) — created 300 but left it unattached", "300", "1");
  await confirmAndFile();
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!)).toMatchObject({ node: "300", sha, attached: false, parent: "1" });
  expect(events().some((d) => d.includes("node #300 is recorded and is attached below #1 the next time, not filed again"))).toBe(true);
  addFails = null;
  // A later detection by another node links the node below the parent it was filed under.
  ctx.node = { ...ctx.node, ref: { ...ctx.node.ref, id: "7" } };
  linkFails = new Error("link refused");
  answers = [];
  await confirmAndFile();
  expect(linked).toEqual([{ node: "300", parent: "1" }]);
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!)).toMatchObject({ attached: false, parent: "1" });
  linkFails = null;
  await fileBaseRedFixNodes(ctx, { sha: LATER, confirmed: [HUD] }, PR);
  expect(linked).toEqual([{ node: "300", parent: "1" }, { node: "300", parent: "1" }]);
  expect(added).toHaveLength(1);
  const record = JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!);
  expect(record).toEqual({ node: "300", sha, detectedBy: "1", pr: 42 });
  expect(events().some((d) => d.includes(`attached fix-the-base node #300 for ${HUD} below #1`))).toBe(true);
  // Attached now: a cache hit at its base files and links nothing.
  answers = [];
  await confirmAndFile();
  expect(added).toHaveLength(1);
  expect(linked).toHaveLength(2);
 });

 test("two overlapping runs confirming the same probe file one node", async () => {
  addDelayMs = 600;
  await Promise.all([
   fileBaseRedFixNodes(ctx, { sha, confirmed: [HUD] }, PR),
   fileBaseRedFixNodes(ctx, { sha, confirmed: [HUD] }, PR),
  ]);
  expect(added).toHaveLength(1);
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!)).toMatchObject({ node: "300", sha });
 });

 test("the filing lock refuses past its wait while another run holds it", async () => {
  const key = baseRedFixKey(ctx.map, HUD);
  let release!: () => void;
  const held = withFixNodeLock(ctx.journal, key, () => new Promise<void>((resolve) => { release = resolve; }));
  await Bun.sleep(50);
  await expect(withFixNodeLock(ctx.journal, key, async () => "second", 300)).rejects.toThrow(FixNodeLockBusy);
  expect(await withFixNodeLock(ctx.journal, baseRedFixKey(ctx.map, "other.mjs"), async () => "other probe", 300)).toBe("other probe");
  release();
  await held;
  expect(await withFixNodeLock(ctx.journal, key, async () => "after", 300)).toBe("after");
 });

 test("graphLink attaches under the machine account's token and fails on a refused attach", async () => {
  const spy = spyOn(exec, "runCmd").mockImplementation(async (cmd, args, opts) => {
   expect(cmd).toBe("soma");
   expect(opts?.env?.GH_TOKEN).toBe("ghp_machine");
   expect(args.slice(0, 5)).toEqual(["graph", "link", "300", "--parent", "1"]);
   return { code: 0, stdout: JSON.stringify({ repo: "acme/widgets", node: "300", written: [], already: [], failed: [], parent: "1", parentStatus: "attached" }), stderr: "" };
  });
  try {
   await graphLink("acme/widgets", "300", "1", "ghp_machine");
   expect(spy).toHaveBeenCalledTimes(1);
   spy.mockResolvedValue({ code: 1, stdout: "", stderr: JSON.stringify({ node: "300", parent: "1", parentStatus: "failed" }) });
   await expect(graphLink("acme/widgets", "300", "1", "ghp_machine")).rejects.toThrow(GraphWriteError);
  } finally {
   spy.mockRestore();
  }
 });
});
