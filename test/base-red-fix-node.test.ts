import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import * as exec from "../src/exec.ts";
import { runCmd, type RunResult } from "../src/exec.ts";
import { graphAdd, GraphWriteError, type AddSpec } from "../src/graph-write.ts";
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
 let nextNode: number;

 const fakeGraph: FixNodeGraph = {
  add: async (parent, spec) => {
   added.push({ parent, spec });
   if (addFails !== null) throw addFails;
   const node = String(nextNode++);
   statuses.set(node, "open");
   return { node };
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

 test("only a first cache write counts: a cache hit or an unconfirmed comparison files nothing", async () => {
  ctx.journal.setHealth(`base-red-checks.acme/widgets.${sha}.${HUD}`, JSON.stringify(["draws"]));
  expect(await confirmAndFile()).toMatchObject({ cached: [HUD], confirmed: [] });
  ctx.journal.setHealth(`base-red-checks.acme/widgets.${sha}.${HUD}`, "{");
  answers = [failed(), pass];
  expect(await confirmAndFile()).toMatchObject({ unconfirmed: [HUD], confirmed: [] });
  expect(added).toEqual([]);
 });

 test("an open fix node for the same map and probe is not filed again", async () => {
  await confirmAndFile();
  await fileBaseRedFixNodes(ctx, { sha: LATER, confirmed: [HUD] }, PR);
  expect(added).toHaveLength(1);
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!).node).toBe("300");
  expect(events().some((d) => d.includes(`fix-the-base node #300 for ${HUD} is open — not filing another`))).toBe(true);
 });

 test("the record is per map: another map on the same repo files its own node", async () => {
  await confirmAndFile();
  ctx.map = { ...ctx.map, root: 460 };
  await fileBaseRedFixNodes(ctx, { sha: LATER, confirmed: [HUD] }, PR);
  expect(added).toHaveLength(2);
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

 test("a failed add leaves the verdict, journals the failure and is retried at the next confirmation", async () => {
  addFails = new GraphWriteError("soma graph add below 1 (acme/widgets) failed (exit 1): boom");
  const base = await confirmAndFile();
  expect(base).toMatchObject({ red: [HUD], confirmed: [HUD], unconfirmed: [] });
  expect(ctx.journal.getHealth(`base-red-checks.acme/widgets.${sha}.${HUD}`)).toBe('["draws","mounts"]');
  expect(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))).toBeNull();
  expect(events().some((d) => d.includes(`fix-the-base filing for ${HUD} at ${sha.slice(0, 8)} failed (retried at its next confirmation)`) && d.includes("boom"))).toBe(true);
  addFails = null;
  await fileBaseRedFixNodes(ctx, { sha: LATER, confirmed: [HUD] }, PR);
  expect(added).toHaveLength(2);
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!).node).toBe("300");
 });

 test("an unreadable earlier fix node files nothing and keeps the record for the next confirmation", async () => {
  await confirmAndFile();
  statusFails = new Error("rate limited");
  await fileBaseRedFixNodes(ctx, { sha: LATER, confirmed: [HUD] }, PR);
  expect(added).toHaveLength(1);
  expect(JSON.parse(ctx.journal.getHealth(baseRedFixKey(ctx.map, HUD))!).node).toBe("300");
  expect(events().some((d) => d.includes("failed (retried at its next confirmation): rate limited"))).toBe(true);
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
   await expect(add).rejects.toThrow(GraphWriteError);
   await expect(add).rejects.toThrow("created 88 but left it unattached");
  } finally {
   spy.mockRestore();
  }
 });
});
