import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.ts";
import { openJournal } from "../src/journal.ts";
import { claimLockFile, withClaimLock } from "../src/claim-lock.ts";
import { githubCiVerdict } from "../src/github-ci.ts";
import type { ForgePort } from "../src/forge.ts";
import type { FrontierEntry } from "../src/graph.ts";
import { classify, loadProbeRegistry } from "../src/route.ts";
import { assembleState, servedMaps, ServeReader, stateFromJournal, type MapRead, type ServeMap, type StateInputs } from "../src/serve.ts";
import { walk, type WalkMapResult } from "../src/walk.ts";
import { fakeDiscord, fixturesBin, runCli } from "./support.ts";

/**
 * Node #165 — the visual lane drains as one machine-wide switch; a headless
 * map drains on its own. Only fresh claims stop: sweeps, the merge desk
 * (and its send-backs) and queued resumes keep running.
 */

const GAME = "acme/seelite";
const TOOL = "acme/ranger";
const SECOND_GAME = "acme/other-game";
const REPOS = [GAME, TOOL, SECOND_GAME];

/** GAME and SECOND_GAME carry a probe (the visual lane); TOOL is headless. Nodes 10/11, 20/21, 30/31. */
function rig(extraMaps: object[] = []) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-drain-"));
 const discord = fakeDiscord();
 const configPath = join(dir, "ranger.yaml");
 const raw = {
  version: 1,
  maps: [...REPOS.map((repo) => ({
   repo, root: 1, walk: "full",
   commands: { test: "bun test", ...(repo === TOOL ? {} : { probe: "npm run probe:gpu" }) },
   discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1234567890" },
  })), ...extraMaps],
  bot: { identity: "ivy-bot" },
  auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST" },
  state: { journalPath: join(dir, "state.sqlite") },
  workers: { spawnCapPerDay: 10 },
 };
 writeFileSync(configPath, stringify(raw));
 const config = loadConfig(configPath).config;
 const journal = openJournal(config);
 const data = join(dir, "data");
 mkdirSync(data);
 const frontierPath = (repo: string) => join(data, repo.replace("/", "__") + "-frontier.json");
 for (const [i, repo] of REPOS.entries()) {
  writeFileSync(frontierPath(repo), JSON.stringify({
   repo, root: "1", frontier: [0, 1].map((offset) => {
    const id = String((i + 1) * 10 + offset);
    return {
     ref: { id }, node: { id, title: `Build ${id}`, kind: "task", autonomy: "auto", probes: [] },
     status: "open", assignees: [], blockedBy: [], author: "alice", typed: true,
     url: `https://github.com/${repo}/issues/${id}`,
    };
   }),
  }));
 }
 /** Make one frontier node a research node. */
 const research = (repo: string, id: string) => {
  const fixture = JSON.parse(readFileSync(frontierPath(repo), "utf8"));
  fixture.frontier.find((e: { ref: { id: string } }) => e.ref.id === id).node.kind = "research";
  writeFileSync(frontierPath(repo), JSON.stringify(fixture));
 };
 const state = join(dir, "state.json");
 writeFileSync(state, JSON.stringify({ nodes: {}, decisions: [] }));
 const env = {
  ...process.env,
  PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
  FAKE_SOMA_DIR: data, FAKE_SOMA_STATE: state,
  RANGER_WRITE_TEST: "ghp_write", RANGER_NO_SPAWN: "1",
  RANGER_DISCORD_TOKEN: "fake-bot-token",
  RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
  RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1", RANGER_DISCORD_MIN_INTERVAL_MS: "5",
 };
 const cli = (args: string[]) => runCli([...args, "-c", configPath], env);
 return { config, configPath, journal, env, data, research, cli, close() {
  journal.close(); discord.stop(); rmSync(dir, { recursive: true, force: true });
 } };
}

/** Run `fn` on a fresh rig with its env installed in-process (walk() reads it). */
async function withRigEnv(fn: (r: ReturnType<typeof rig>) => Promise<void>): Promise<void> {
 const r = rig();
 const saved = { ...process.env };
 try {
  Object.assign(process.env, r.env);
  await fn(r);
 } finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  r.close();
 }
}

const walked = async (r: ReturnType<typeof rig>): Promise<WalkMapResult[]> => {
 const out = await r.cli(["walk"]);
 expect(out.code).toBe(0);
 return JSON.parse(out.stdout).maps;
};

/** A merge desk's fake forge: PR #7 for node 40, sage-clean at its head, conflicting with main. */
function conflictingPrForge(): ForgePort {
 const head = "a".repeat(40);
 return {
  getPr: async () => ({
   iid: 7, state: "open", draft: false, title: "Node 40", headRef: "node/40-x", headSha: head,
   baseRef: "main", mergeState: "conflict", mergeCommitSha: null, mergedBy: null,
   webUrl: `https://github.com/${GAME}/pull/7`, author: "ivy-bot",
  }),
  listComments: async () => [
   { id: 1, author: "ivy-bot", body: `<!-- ranger:review round=5 sha=${head} blockers=0 majors=0 nits=1 -->\nclean` },
  ],
  ciVerdictFor: async () => githubCiVerdict(GAME, []),
  issueLabels: async () => [],
 } as unknown as ForgePort;
}

describe("node #165 — ranger drain", () => {
 test("a drained visual lane stops implement claims on every visual map; the headless map claims", async () => {
  const r = rig();
  try {
   const out = await r.cli(["drain", "--lane", "visual"]);
   expect(out.code).toBe(0);
   expect(JSON.parse(out.stdout)).toMatchObject({ scope: "lane", lane: "visual", drained: true, was: false });
   const maps = await walked(r);
   expect(maps.map((m) => m.claimed)).toEqual([[], ["20"], []]);
   for (const i of [0, 2]) {
    expect(maps[i].drained).toMatch(/visual lane drained/);
    expect(maps[i].gated).toBe(false);
   }
   expect(maps[1].drained).toBeUndefined();
   expect(r.journal.spawnsToday()).toBe(1);
   expect(r.journal.listEvents().some((e) => e.kind === "drain" && /visual lane drained/.test(e.detail ?? ""))).toBe(true);
  } finally { r.close(); }
 });

 test("research on a visual map claims as usual under the lane drain", async () => {
  const r = rig();
  try {
   r.research(GAME, "11");
   expect((await r.cli(["drain", "--lane", "visual"])).code).toBe(0);
   const maps = await walked(r);
   expect(maps.map((m) => m.claimed)).toEqual([["11"], ["20"], []]);
   expect(r.journal.getWorker("11", GAME)).toMatchObject({ lane: "research", status: "claimed" });
   expect(r.journal.getWorker("10", GAME)).toBeNull();
  } finally { r.close(); }
 });

 test("--off lifts the lane drain: the next tick claims", async () => {
  const r = rig();
  try {
   expect((await r.cli(["drain", "--lane", "visual"])).code).toBe(0);
   const off = await r.cli(["drain", "--lane", "visual", "--off"]);
   expect(off.code).toBe(0);
   expect(JSON.parse(off.stdout)).toMatchObject({ drained: false, was: true });
   expect((await walked(r)).map((m) => m.claimed)).toEqual([["10"], ["20"], []]);
  } finally { r.close(); }
 });

 test("a drained headless map claims nothing in either lane; other maps are unaffected; --off lifts it", async () => {
  const r = rig();
  try {
   r.research(TOOL, "21");
   const out = await r.cli(["drain", "--map", `${TOOL}#1`]);
   expect(out.code).toBe(0);
   expect(JSON.parse(out.stdout)).toMatchObject({ scope: "map", key: `${TOOL}#1`, drained: true });
   const maps = await walked(r);
   expect(maps.map((m) => m.claimed)).toEqual([["10"], [], []]);
   expect(maps[1]).toMatchObject({ gated: true, gateReason: expect.stringMatching(/map drained/) });
   expect(maps[1].drained).toMatch(/ranger drain --map acme\/ranger#1 --off/);
   expect(maps[0].drained).toBeUndefined();
   expect((await r.cli(["drain", "--map", TOOL, "--off"])).code).toBe(0);
   expect((await walked(r)).map((m) => m.claimed)).toEqual([[], ["20", "21"], []]);
  } finally { r.close(); }
 });

 test("refusals exit non-zero, name the problem and write nothing", async () => {
  const r = rig([{ repo: TOOL, root: 460, walk: "full", commands: { test: "bun test" },
   discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1234567890" } }]);
  try {
   const cases: [string[], RegExp][] = [
    [["--map", GAME], /visual lane.*`ranger drain --lane visual`/],
    [["--map", `${SECOND_GAME}#1`, "--off"], /`ranger drain --lane visual --off`/],
    [["--lane", "headless"], /--lane 'headless' cannot be drained/],
    [["--lane", "gpu"], /--lane 'gpu' cannot be drained/],
    [["--map", "acme/nowhere"], /no map registered for 'acme\/nowhere'/],
    [["--map", TOOL], /candidates: acme\/ranger#1, acme\/ranger#460/],
    [[], /exactly one of --lane visual or --map/],
    [["--lane", "visual", "--map", `${TOOL}#1`], /exactly one of --lane visual or --map/],
   ];
   for (const [args, why] of cases) {
    const out = await r.cli(["drain", ...args]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(why);
   }
   expect(r.journal.isVisualLaneDrained()).toBe(false);
   for (const map of r.config.maps) expect(r.journal.getHealth(`drain.map.${map.repo}#${map.root}`)).toBeNull();
   expect(r.journal.getHealth("drain.lane.visual")).toBeNull();
   expect(r.journal.listEvents()).toEqual([]);
  } finally { r.close(); }
 });

 test("the merge desk's send-back still takes the visual lane under the drain", async () => {
  await withRigEnv(async (r) => {
   r.journal.setVisualLaneDrained(true);
   r.journal.upsertWorker({ root: 1, nodeId: "40", repo: GAME, status: "awaiting-merge", lane: "implement" });
   r.journal.updateWorker("40", GAME, { phase: "awaiting-merge", prNumber: 7 });
   const spawned: string[] = [];
   const result = await walk({
    config: r.config, configPath: r.configPath, journal: r.journal, github: conflictingPrForge(),
    spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; },
   });
   expect(spawned).toEqual(["40", "20"]); // the send-back, then the headless claim
   expect(r.journal.getWorker("40", GAME)).toMatchObject({ status: "running", phase: "review" });
   expect(result.maps[0].sweep?.mergeDesk?.resumed).toEqual(["40"]);
   expect(result.maps.map((m) => m.claimed)).toEqual([[], ["20"], []]);
  });
 });

 test("a queued resume on a visual map still starts under the drain", async () => {
  await withRigEnv(async (r) => {
   r.journal.setVisualLaneDrained(true);
   writeFileSync(join(r.data, "acme__other-game-node-31.json"), JSON.stringify({
    repo: SECOND_GAME, ref: { id: "31" }, node: { id: "31", title: "Build 31", kind: "task", autonomy: "auto" },
    status: "open", assignees: ["ivy-bot"], blockedBy: [], author: "alice", typed: true, url: "",
   }));
   r.journal.upsertWorker({ nodeId: "31", repo: SECOND_GAME, root: 1, status: "parked", lane: "implement", phase: "review", finishedAt: "2026-10-06T00:00:00Z" });
   r.journal.enqueueResume({ nodeId: "31", repo: SECOND_GAME, root: 1, lane: "visual" });
   const spawned: string[] = [];
   await walk({
    config: r.config, configPath: r.configPath, journal: r.journal,
    spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; },
   });
   expect(spawned).toEqual(["31", "20"]);
   expect(r.journal.listResumeQueue()).toEqual([]);
  });
 });

 test("a drain set while the walk waits for the claim lock is honoured; it is read under the lock", async () => {
  await withRigEnv(async (r) => {
   const lock = claimLockFile(r.journal);
   const reads: boolean[] = [];
   const read = r.journal.isVisualLaneDrained.bind(r.journal);
   r.journal.isVisualLaneDrained = () => { reads.push(existsSync(lock)); return read(); };
   let release!: () => void;
   const held = withClaimLock(r.journal, () => new Promise<void>((resolve) => (release = resolve)));
   await Bun.sleep(50);
   const spawned: string[] = [];
   const ticking = walk({
    config: r.config, configPath: r.configPath, journal: r.journal,
    spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; },
   });
   await Bun.sleep(300);
   r.journal.setVisualLaneDrained(true);
   release();
   await held;
   const result = await ticking;
   expect(result.maps.map((m) => m.claimed)).toEqual([[], ["20"], []]);
   expect(spawned).toEqual(["20"]);
   expect(reads.length).toBeGreaterThan(0);
   expect(reads.every(Boolean)).toBe(true);
  });
 });

 test("the dashboard reads both drains from the journal", () => {
  const r = rig();
  try {
   r.journal.setVisualLaneDrained(true);
   r.journal.setMapDrained(`${TOOL}#1`, true);
   const reader = new ServeReader(r.config, servedMaps(r.config), r.config.state.journalPath);
   const state = stateFromJournal(r.config, servedMaps(r.config), reader);
   expect(state.gates.visualDrained).toBe(true);
   expect(state.gates.drainedMaps).toEqual([`${TOOL}#1`]);
  } finally { r.close(); }
 });
});

describe("node #165 — the dashboard's next shares the walk's drain gate", () => {
 const registry = loadProbeRegistry();
 const entry = (repo: string, id: string, kind = "task"): FrontierEntry => ({
  ref: { id }, node: { id, title: `node ${id}`, kind, autonomy: "auto" },
  status: "open", assignees: [], blockedBy: [], author: "alice", typed: true,
  url: `https://github.com/${repo}/issues/${id}`,
 });
 const map = (repo: string, lane: "visual" | "headless"): ServeMap => ({
  key: `${repo}#1`, repo, root: 1, walk: "full", lane, servedOnly: false,
 });
 const read = (repo: string, entries: FrontierEntry[]): MapRead => ({
  ok: true, readAt: "2026-10-09T10:00:00Z", source: "ranger",
  frontier: entries.map((e) => classify(e, repo, "full", registry, { botIdentity: "bot", skip: [] })),
 });
 const maps = [map(GAME, "visual"), map(TOOL, "headless"), map(SECOND_GAME, "visual")];
 const inputs = (drains: StateInputs["drains"], gameKinds = ["task", "task"]): StateInputs => ({
  maps,
  reports: new Map([
   [maps[0].key, read(GAME, [entry(GAME, "10", gameKinds[0]), entry(GAME, "11", gameKinds[1])])],
   [maps[1].key, read(TOOL, [entry(TOOL, "20"), entry(TOOL, "21", "research")])],
   [maps[2].key, read(SECOND_GAME, [entry(SECOND_GAME, "30"), entry(SECOND_GAME, "31")])],
  ]),
  titles: new Map(), workers: [], laneHolders: { visual: null, headless: null },
  paused: false, drains, spawnsToday: 0, spawnCap: 10,
  vetoed: () => false, pidAlive: () => true, refreshing: false, refreshError: null,
  now: new Date("2026-10-09T10:00:00Z"),
 });

 test("the visual drain: no visual map offers an implement claim; the headless map does", () => {
  const state = assembleState(inputs({ visual: true, maps: new Set() }));
  const [game, tool, second] = state.maps;
  for (const m of [game, second]) {
   expect(m.next).toMatchObject({ waiting: false, reason: "no implement claim while the visual lane is drained" });
   expect(m.next.nodeId).toBeUndefined();
   expect(m.queued).toEqual([]);
  }
  expect(tool.next).toMatchObject({ nodeId: "20", waiting: false });
  expect(state.gates).toMatchObject({ visualDrained: true, drainedMaps: [] });
 });

 test("the visual drain still offers a visual map's research node", () => {
  const state = assembleState(inputs({ visual: true, maps: new Set() }, ["task", "research"]));
  expect(state.maps[0].next).toMatchObject({ nodeId: "11", lane: "research", waiting: false });
 });

 test("a drained headless map offers nothing and shows its drain; others are unaffected", () => {
  const state = assembleState(inputs({ visual: false, maps: new Set([`${TOOL}#1`]) }));
  expect(state.maps[1].next).toMatchObject({ waiting: false, reason: expect.stringMatching(/map drained/) });
  expect(state.maps[1].next.nodeId).toBeUndefined();
  expect(state.maps[1].queued).toEqual([]);
  expect(state.maps[0].next.nodeId).toBe("10");
  expect(state.gates).toMatchObject({ visualDrained: false, drainedMaps: [`${TOOL}#1`] });
 });
});
