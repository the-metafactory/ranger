import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.ts";
import type { FrontierEntry } from "../src/graph.ts";
import { openJournal, type ResumeQueueRow, type WorkerRow } from "../src/journal.ts";
import { classify, loadProbeRegistry } from "../src/route.ts";
import {
 assembleState,
 createHandler,
 renderPage,
 ServeReader,
 servedMaps,
 stateFromJournal,
 type DashboardState,
 type MapRead,
 type ServeMap,
 type StateInputs,
} from "../src/serve.ts";
import { needsYouEntries, type ActionRunner, type NeedsYouInputs } from "../src/serve-parked.ts";
import { fakeDiscord, fixturesBin, runCli } from "./support.ts";

/**
 * Node #166 — `ranger serve` drains the visual lane (one switch) and any
 * headless map, and queues or cancels a resume, each by running the CLI verb
 * (`ranger drain`, `ranger resume-node --when-free` / `--cancel`). The
 * dashboard lists each lane's resume queue FIFO, and its head is next ahead
 * of any frontier claim, as the walk's Pass 1c starts it.
 */

const GAME = "acme/seelite";
const TOOL = "acme/ranger";
const NOW = new Date("2026-10-09T10:00:00Z");
const BIN = "/Users/someone/bin/ranger";
const CONFIG = "/Users/someone/ranger/ranger.yaml";
const PORT = 7312;
const TOKEN = "q".repeat(48);

const registry = loadProbeRegistry();
const entry = (repo: string, id: string, kind = "task"): FrontierEntry => ({
 ref: { id }, node: { id, title: `node ${id}`, kind, autonomy: "auto" },
 status: "open", assignees: [], blockedBy: [], author: "alice", typed: true,
 url: `https://github.com/${repo}/issues/${id}`,
});
const read = (repo: string, entries: FrontierEntry[]): MapRead => ({
 ok: true, readAt: "2026-10-09T09:55:00Z", source: "ranger",
 frontier: entries.map((e) => classify(e, repo, "full", registry, { botIdentity: "bot", skip: [] })),
});
const map = (repo: string, lane: "visual" | "headless", over: Partial<ServeMap> = {}): ServeMap => ({
 key: `${repo}#1`, repo, root: 1, walk: "full", lane, servedOnly: false, ...over,
});
let qid = 0;
const queued = (repo: string, nodeId: string, lane: "visual" | "headless"): ResumeQueueRow => ({
 id: ++qid, repo, nodeId, root: 1, lane, queuedAt: "2026-10-09T09:00:00Z", failedStarts: 0,
});
const worker = (over: Partial<WorkerRow>): WorkerRow => ({
 nodeId: "40", root: 1, repo: GAME, pid: null, status: "parked", attempts: 0, worktree: null,
 startedAt: "2026-10-09T08:00:00Z", finishedAt: "2026-10-09T09:00:00Z", outcome: "parked for the test",
 messageId: null, lane: "implement", generation: 1, workerPgid: null, phase: "review", prNumber: null,
 researchBaseSha: null, reviewRound: 0, verdictSha: null, verdictBlockers: 0, mergeMessageId: null,
 substrate: null, ...over,
});

const MAPS = [map(GAME, "visual"), map(TOOL, "headless")];
const inputs = (over: Partial<StateInputs> = {}): StateInputs => ({
 maps: MAPS,
 reports: new Map([
  [MAPS[0].key, read(GAME, [entry(GAME, "10"), entry(GAME, "11")])],
  [MAPS[1].key, read(TOOL, [entry(TOOL, "20")])],
 ]),
 titles: new Map(), workers: [], laneHolders: { visual: null, headless: null },
 paused: false, spawnsToday: 0, spawnCap: 10,
 vetoed: () => false, pidAlive: () => true, refreshing: false, refreshError: null, now: NOW,
 ...over,
});

describe("node #166 — the resume queue on the dashboard, and its head ahead of any claim", () => {
 test("each lane lists its entries FIFO; a free lane's head is next and the frontier waits behind it", () => {
  const state = assembleState(inputs({
   resumeQueue: [queued(GAME, "40", "visual"), queued(TOOL, "50", "headless"), queued(GAME, "41", "visual")],
  }));
  expect(state.resumeQueue.visual.entries.map((e) => [e.nodeId, e.position, e.key])).toEqual([["40", 1, `${GAME}#1`], ["41", 2, `${GAME}#1`]]);
  expect(state.resumeQueue.headless.entries.map((e) => [e.nodeId, e.position])).toEqual([["50", 1]]);
  expect(state.resumeQueue.visual.head).toEqual({ starts: true, reason: expect.stringMatching(/ahead of any frontier claim/) });
  const [game, tool] = state.maps;
  expect(game.next).toMatchObject({ nodeId: "10", waiting: true, reason: `waits for the visual implement lane: this tick resumes queued #40 (${GAME}#1) first` });
  expect(tool.next).toMatchObject({ nodeId: "20", waiting: true, reason: expect.stringContaining("resumes queued #50") });
 });

 test("an empty queue changes nothing: the frontier claim is next", () => {
  const state = assembleState(inputs());
  expect(state.resumeQueue).toEqual({ visual: { entries: [], head: null }, headless: { entries: [], head: null } });
  expect(state.maps[0].next).toMatchObject({ nodeId: "10", waiting: false });
 });

 test("a held lane holds its head; the other lane's head still starts", () => {
  const holder = worker({ nodeId: "60", status: "running" });
  const state = assembleState(inputs({
   laneHolders: { visual: holder, headless: null },
   resumeQueue: [queued(GAME, "40", "visual"), queued(TOOL, "50", "headless")],
  }));
  expect(state.resumeQueue.visual.head).toEqual({ starts: false, reason: `waits for the visual lane, held by #60 (${GAME}#1)` });
  expect(state.resumeQueue.headless.head?.starts).toBe(true);
  expect(state.maps[0].next.reason).toContain("held by #60");
 });

 test("the dead-man pause holds every head", () => {
  const state = assembleState(inputs({ paused: true, resumeQueue: [queued(GAME, "40", "visual")] }));
  expect(state.resumeQueue.visual.head).toEqual({ starts: false, reason: expect.stringMatching(/dead-man paused/) });
 });

 test("a head takes a spawn: with one left, the earlier-queued head takes it and the rest wait on the cap", () => {
  const state = assembleState(inputs({
   spawnsToday: 9,
   resumeQueue: [queued(TOOL, "50", "headless"), queued(GAME, "40", "visual")],
  }));
  expect(state.resumeQueue.headless.head?.starts).toBe(true);
  expect(state.resumeQueue.visual.head).toEqual({ starts: false, reason: expect.stringMatching(/daily spawn cap \(10\) is spent/) });
  expect(state.maps[0].next).toMatchObject({ reason: expect.stringMatching(/spent by earlier maps this tick/) });
 });

 test("a drained visual lane still starts its queued head: a drain stops only fresh claims", () => {
  const state = assembleState(inputs({
   drains: { visual: true, maps: new Set() },
   resumeQueue: [queued(GAME, "40", "visual")],
  }));
  expect(state.resumeQueue.visual.head?.starts).toBe(true);
 });

 test("a head whose map is no longer registered starts nothing and takes no lane", () => {
  const state = assembleState(inputs({ resumeQueue: [queued("acme/gone", "70", "visual")] }));
  expect(state.resumeQueue.visual.head).toEqual({ starts: false, reason: expect.stringMatching(/no longer registered/) });
  expect(state.maps[0].next).toMatchObject({ nodeId: "10", waiting: false });
 });
});

const entryInputs = (over: Partial<NeedsYouInputs> = {}): NeedsYouInputs => ({
 maps: MAPS,
 workers: [worker({})],
 events: () => [],
 labels: () => null,
 prs: () => null,
 titleOf: () => "a node",
 reviewRounds: 5,
 exists: () => true,
 ...over,
});

describe("node #166 — queue resume and cancel on a Needs-you card", () => {
 test("a parked node whose lane is held offers Queue resume", () => {
  const [e] = needsYouEntries(entryInputs({ laneHolders: { visual: { repo: GAME, nodeId: "60" } } }));
  expect(e.actions.queueResume).toEqual({ offered: true });
  expect(e.actions.cancelResume).toBe(false);
  expect(e.queued).toBeNull();
 });

 test("a waiting queue on the lane offers it too: the verb queues behind it", () => {
  const [e] = needsYouEntries(entryInputs({ resumeQueue: [queued(GAME, "41", "visual")] }));
  expect(e.actions.queueResume).toEqual({ offered: true });
 });

 test("a free lane with no queue does not: the verb would start it now, which Resume does", () => {
  const [e] = needsYouEntries(entryInputs());
  expect(e.actions.queueResume).toEqual({ offered: false, why: "the visual lane is free: Resume starts it now" });
 });

 test("a node that takes no implement lane is not queued", () => {
  const [e] = needsYouEntries(entryInputs({
   workers: [worker({ lane: "research", phase: null })],
   laneHolders: { visual: { repo: GAME, nodeId: "60" } },
  }));
  expect(e.actions.queueResume.offered).toBe(false);
 });

 test("a queued node shows its place in its lane and offers cancel, not a second queue", () => {
  const [e] = needsYouEntries(entryInputs({
   resumeQueue: [queued(GAME, "41", "visual"), queued(TOOL, "50", "headless"), queued(GAME, "40", "visual")],
  }));
  expect(e.queued).toEqual({ lane: "visual", position: 2 });
  expect(e.actions.cancelResume).toBe(true);
  expect(e.actions.queueResume).toEqual({ offered: false, why: "already queued" });
 });
});

describe("node #166 — the action handlers run the CLI verbs, and refuse with nothing run", () => {
 const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1:${PORT}${path}`, {
   method: "POST",
   headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "x-ranger-token": TOKEN, "content-type": "application/json" },
   body: JSON.stringify(body),
  });
 const setup = (opts: { state?: Partial<StateInputs>; entries?: Partial<NeedsYouInputs>; code?: number; configPath?: string | null } = {}) => {
  const runs: { argv: string[]; env: Record<string, string>; detached: boolean }[] = [];
  const run: ActionRunner = async (argv, env, o) => {
   runs.push({ argv, env, detached: o.detached });
   return { code: opts.code ?? 0, stderr: opts.code ? "ranger drain: no map registered for 'x'" : "" };
  };
  const handler = createHandler({
   port: PORT,
   token: TOKEN,
   getState: () => assembleState(inputs({
    ...opts.state,
    needsYou: needsYouEntries(entryInputs({ ...opts.entries, resumeQueue: opts.state?.resumeQueue })),
   })),
   refresh: () => {},
   launch: () => { throw new Error("no launch"); },
   verifyGrilling: async () => null,
   actions: {
    run,
    env: { PATH: "/usr/bin", HOME: "/Users/someone", GH_TOKEN: "ghp_machine" },
    rangerBin: BIN,
    configPath: opts.configPath === null ? undefined : (opts.configPath ?? CONFIG),
    readPr: async () => null,
    exists: () => true,
   },
  });
  return { handler, runs };
 };
 const held = { entries: { laneHolders: { visual: { repo: GAME, nodeId: "60" } } } };
 const queuedState = { state: { resumeQueue: [queued(GAME, "40", "visual")] } };

 test("queue resume runs resume-node --when-free for that map, detached, with no ambient credential and never --force", async () => {
  const { handler, runs } = setup(held);
  const res = await handler(post("/api/queue-resume", { key: `${GAME}#1`, id: "40", force: true }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ action: "queue-resume", nodeId: "40", ok: true, code: 0 });
  expect(runs).toHaveLength(1);
  expect(runs[0].argv).toEqual([BIN, "resume-node", "40", "--map", `${GAME}#1`, "-c", CONFIG, "--when-free"]);
  expect(runs[0].detached).toBe(true);
  expect(Object.keys(runs[0].env).sort()).toEqual(["HOME", "PATH"]);
 });

 test("cancel runs resume-node --cancel for the queued entry", async () => {
  const { handler, runs } = setup(queuedState);
  const res = await handler(post("/api/cancel-resume", { key: `${GAME}#1`, id: "40" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ action: "cancel-resume", nodeId: "40", ok: true });
  expect(runs.map((r) => r.argv)).toEqual([[BIN, "resume-node", "40", "--map", `${GAME}#1`, "-c", CONFIG, "--cancel"]]);
 });

 test("cancel names the queue, not the card: a queued node that is no longer parked can still be cancelled", async () => {
  const { handler, runs } = setup({ ...queuedState, entries: { workers: [worker({ status: "awaiting-merge" })] } });
  expect((await handler(post("/api/cancel-resume", { key: `${GAME}#1`, id: "40" }))).status).toBe(200);
  expect(runs).toHaveLength(1);
 });

 test("drain and undrain of the visual lane run ranger drain --lane visual [--off]", async () => {
  const { handler, runs } = setup();
  expect((await handler(post("/api/drain", { lane: "visual" }))).status).toBe(200);
  expect((await handler(post("/api/drain", { lane: "visual", off: true }))).status).toBe(200);
  await handler(post("/api/drain", { lane: "visual", off: "yes" }));
  expect(runs.map((r) => r.argv)).toEqual([
   [BIN, "drain", "--lane", "visual", "-c", CONFIG],
   [BIN, "drain", "--lane", "visual", "--off", "-c", CONFIG],
   [BIN, "drain", "--lane", "visual", "-c", CONFIG],
  ]);
  expect(runs.every((r) => !r.detached && Object.keys(r.env).sort().join() === "HOME,PATH")).toBe(true);
 });

 test("drain and undrain of a headless map run ranger drain --map <key> [--off]", async () => {
  const { handler, runs } = setup();
  const res = await handler(post("/api/drain", { key: `${TOOL}#1` }));
  expect(await res.json()).toMatchObject({ action: "drain", key: `${TOOL}#1`, off: false, ok: true });
  await handler(post("/api/drain", { key: `${TOOL}#1`, off: true }));
  expect(runs.map((r) => r.argv)).toEqual([
   [BIN, "drain", "--map", `${TOOL}#1`, "-c", CONFIG],
   [BIN, "drain", "--map", `${TOOL}#1`, "--off", "-c", CONFIG],
  ]);
 });

 test("a failed verb is shown with its exit and stderr", async () => {
  const { handler } = setup({ code: 1 });
  const res = await handler(post("/api/drain", { key: `${TOOL}#1` }));
  expect(await res.json()).toMatchObject({ ok: false, code: 1, stderr: expect.stringContaining("no map registered") });
 });

 const refusals: [string, string, unknown, Parameters<typeof setup>[0]?][] = [
  ["queue resume on a free lane (the verb would start it)", "/api/queue-resume", { key: `${GAME}#1`, id: "40" }],
  ["queue resume of a node already queued", "/api/queue-resume", { key: `${GAME}#1`, id: "40" }, { ...queuedState, ...held }],
  ["queue resume of a node not parked or failed", "/api/queue-resume", { key: `${GAME}#1`, id: "40" }, { entries: { ...held.entries, workers: [worker({ status: "running" })] } }],
  ["cancel with no queued entry", "/api/cancel-resume", { key: `${GAME}#1`, id: "40" }],
  ["cancel on another map", "/api/cancel-resume", { key: `${TOOL}#1`, id: "40" }, queuedState],
  ["cancel with a non-numeric id", "/api/cancel-resume", { key: `${GAME}#1`, id: "40 --force" }, queuedState],
  ["cancel without a config path", "/api/cancel-resume", { key: `${GAME}#1`, id: "40" }, { ...queuedState, configPath: null }],
  ["a per-map drain of a visual map", "/api/drain", { key: `${GAME}#1` }],
  ["a drain of an unknown map", "/api/drain", { key: "acme/unknown#1" }],
  ["a drain of a serve-only map", "/api/drain", { key: "acme/extra#1" }, { state: { maps: [...MAPS, map("acme/extra", "headless", { servedOnly: true, walk: "none" })] } }],
  ["a drain of the headless lane as one switch", "/api/drain", { lane: "headless" }],
  ["a drain naming both a lane and a map", "/api/drain", { lane: "visual", key: `${TOOL}#1` }],
  ["a drain naming nothing", "/api/drain", {}],
  ["a drain without a config path", "/api/drain", { lane: "visual" }, { configPath: null }],
  ["a null drain body", "/api/drain", null],
 ];
 for (const [name, path, body, opts] of refusals) {
  test(`refuses: ${name}`, async () => {
   const { handler, runs } = setup(opts);
   const res = await handler(post(path, body));
   expect(res.status).toBeGreaterThanOrEqual(400);
   expect(((await res.json()) as { error?: unknown }).error).toBeString();
   expect(runs).toHaveLength(0);
  });
 }

 test("the page offers the drains and queue controls, and its script parses", () => {
  const page = renderPage(TOKEN);
  for (const s of ["/api/drain", "Queue resume", "cancel-resume", "queue-resume", "resume queue"]) expect(page).toContain(s);
  const script = page.split("<script>")[1].split("</script>")[0];
  expect(() => new Function(script)).not.toThrow();
 });
});

/** A ranger.yaml with GAME on the visual lane (it has a probe) and TOOL headless, a journal, and the CLI's fixtures. */
function rig() {
 const dir = mkdtempSync(join(tmpdir(), "ranger-serve-queue-"));
 const discord = fakeDiscord();
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, stringify({
  version: 1,
  maps: [GAME, TOOL].map((repo) => ({
   repo, root: 1, walk: "full",
   commands: { test: "bun test", ...(repo === GAME ? { probe: "npm run probe:gpu" } : {}) },
   discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1234567890" },
  })),
  auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST" }, bot: { identity: "ivy-bot" },
  state: { journalPath: join(dir, "journal.sqlite") }, workers: { spawnCapPerDay: 10 },
 }));
 const config = loadConfig(configPath).config;
 const journal = openJournal(config);
 const data = join(dir, "data");
 mkdirSync(data);
 const graph = join(dir, "graph.json");
 writeFileSync(graph, JSON.stringify({ nodes: {}, decisions: [] }));
 const env = {
  ...process.env, PATH: `${fixturesBin}:${process.env.PATH ?? ""}`, FAKE_SOMA_DIR: data, FAKE_SOMA_STATE: graph,
  RANGER_WRITE_TEST: "ghp_write", RANGER_NO_SPAWN: "1", RANGER_DISCORD_TOKEN: "test",
  RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`, RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1", RANGER_DISCORD_MIN_INTERVAL_MS: "5",
 };
 const maps = servedMaps(config);
 const reader = new ServeReader(config, maps, config.state.journalPath);
 const state = (): DashboardState => stateFromJournal(config, maps, reader, NOW);
 // The real CLI stands in for ~/bin/ranger: the action's argv after the binary, run as-is.
 const run: ActionRunner = async (argv) => {
  const out = await runCli(argv.slice(1), env);
  return { code: out.code, stderr: out.stderr };
 };
 // A frozen state is the page's read, stale by the time the verb runs.
 let frozen: DashboardState | null = null;
 const handler = createHandler({
  port: PORT, token: TOKEN, getState: () => frozen ?? state(), refresh: () => {},
  launch: () => { throw new Error("no launch"); }, verifyGrilling: async () => null,
  actions: { run, env, rangerBin: BIN, configPath, readPr: async () => null, exists: () => true },
 });
 const post = (path: string, body: unknown) => handler(new Request(`http://127.0.0.1:${PORT}${path}`, {
  method: "POST",
  headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "x-ranger-token": TOKEN, "content-type": "application/json" },
  body: JSON.stringify(body),
 }));
 const freeze = () => { frozen = state(); };
 return { config, journal, state, post, freeze, close() { journal.close(); discord.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("node #166 — through the real CLI: the same effect as the verb, or an error and no change", () => {
 test("drain and undrain the visual lane and a headless map; the dashboard reads them back", async () => {
  const r = rig();
  try {
   expect(await (await r.post("/api/drain", { lane: "visual" })).json()).toMatchObject({ ok: true, code: 0 });
   expect(r.journal.isVisualLaneDrained()).toBe(true);
   expect(r.state().gates.visualDrained).toBe(true);
   expect(await (await r.post("/api/drain", { key: `${TOOL}#1` })).json()).toMatchObject({ ok: true });
   expect(r.journal.isMapDrained(`${TOOL}#1`)).toBe(true);
   expect(r.state().gates.drainedMaps).toEqual([`${TOOL}#1`]);
   await r.post("/api/drain", { lane: "visual", off: true });
   await r.post("/api/drain", { key: `${TOOL}#1`, off: true });
   expect(r.journal.isVisualLaneDrained()).toBe(false);
   expect(r.journal.isMapDrained(`${TOOL}#1`)).toBe(false);
   expect(r.journal.listEvents().filter((e) => e.kind === "drain")).toHaveLength(4);
  } finally { r.close(); }
 });

 test("a queued node shows its place; cancel drops it; a cancel the verb refuses shows its error and changes nothing", async () => {
  const r = rig();
  try {
   for (const id of ["40", "41"]) {
    r.journal.upsertWorker({ nodeId: id, repo: GAME, root: 1, status: "parked", lane: "implement", phase: "review", finishedAt: "2026-10-09T09:00:00Z" });
   }
   const first = r.journal.enqueueResume({ nodeId: "41", repo: GAME, root: 1, lane: "visual" }, NOW);
   r.journal.enqueueResume({ nodeId: "40", repo: GAME, root: 1, lane: "visual" }, NOW);
   const state = r.state();
   expect(state.resumeQueue.visual.entries.map((e) => e.nodeId)).toEqual(["41", "40"]);
   expect(state.needsYou.find((e) => e.nodeId === "40")?.queued).toEqual({ lane: "visual", position: 2 });

   const cancelled = await (await r.post("/api/cancel-resume", { key: `${GAME}#1`, id: "40" })).json();
   expect(cancelled).toMatchObject({ ok: true, code: 0 });
   expect(r.journal.listResumeQueue().map((e) => e.nodeId)).toEqual(["41"]);

   // A cancel naming no entry is refused here, with nothing run.
   expect((await r.post("/api/cancel-resume", { key: `${GAME}#1`, id: "40" })).status).toBe(404);

   // The verb is the backstop: the page read the entry, but it is gone when the verb runs.
   r.freeze();
   r.journal.removeResume(first, "resume-dropped", "dropped under the page");
   const before = r.journal.listEvents().length;
   const raced = await r.post("/api/cancel-resume", { key: `${GAME}#1`, id: "41" });
   expect(raced.status).toBe(200);
   expect(await raced.json()).toMatchObject({ ok: false, code: 1, stderr: expect.stringContaining("no unique queued resume for node 41") });
   expect(r.journal.listResumeQueue()).toEqual([]);
   expect(r.journal.listEvents()).toHaveLength(before);
  } finally { r.close(); }
 });

 test("queue resume behind a waiting queue queues it FIFO, as resume-node --when-free does", async () => {
  const r = rig();
  try {
   for (const id of ["40", "41"]) {
    r.journal.upsertWorker({ nodeId: id, repo: GAME, root: 1, status: "parked", lane: "implement", phase: "review", finishedAt: "2026-10-09T09:00:00Z" });
   }
   r.journal.enqueueResume({ nodeId: "41", repo: GAME, root: 1, lane: "visual" }, NOW);
   const res = await (await r.post("/api/queue-resume", { key: `${GAME}#1`, id: "40" })).json();
   expect(res).toMatchObject({ ok: true, code: 0 });
   expect(r.journal.listResumeQueue("visual").map((e) => e.nodeId)).toEqual(["41", "40"]);
   expect(r.state().needsYou.find((e) => e.nodeId === "40")?.actions.cancelResume).toBe(true);
  } finally { r.close(); }
 });
});
