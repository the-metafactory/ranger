import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.ts";
import { openJournal, type WorkerRow } from "../src/journal.ts";
import { infrastructureProbeHead, probeFailureClass, probesFailedOutcome } from "../src/outcomes.ts";
import { probeRequeueCandidates, requeueProbes } from "../src/probe-requeue.ts";
import { walk } from "../src/walk.ts";
import { realGitHub, type ForgePort } from "../src/implement.ts";
import type { ChangeRequest } from "../src/forge.ts";
import { fakeDiscord, fixturesBin } from "./support.ts";

const A = "acme/game";
const B = "acme/other-game";
const SHA = "a".repeat(40);
const deadPid = 2_147_483_647;
const run = (code: number, stdout = "") => ({ code, stdout, stderr: "" });
const failure = (kind: string) => `FAIL probe-site.mjs (1.0s) exit=${kind === "killed" ? "killed:SIGKILL" : "1"} ${kind}\nFAILED: probe-site.mjs`;
const outcome = (head = SHA) => probesFailedOutcome({ sha: head, pr: 1, exit: -1, failed: [], failureClass: "infrastructure", tail: "probe lock: waiting 1795s" });

function rig() {
 const dir = mkdtempSync(join(tmpdir(), "ranger-probe-requeue-"));
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, stringify({
  version: 1,
  maps: [A, B].map((repo) => ({ repo, root: 1, walk: "full", commands: { test: "true", probe: "true" },
   discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1234567890" } })),
  bot: { identity: "ivy-bot" }, auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST" },
  state: { journalPath: join(dir, "state.sqlite") },
 }));
 const config = loadConfig(configPath).config;
 let journal = openJournal(config);
 const park = (id: string, repo = A, extra: Partial<WorkerRow> = {}) => journal.upsertWorker({
  repo, root: 1, nodeId: id, status: "parked", lane: "implement", phase: "review", prNumber: 1,
  outcome: outcome(), finishedAt: "2026-10-07T07:00:00.000Z", ...extra,
 });
 const retry = (spawn: (id: string, repo: string, root: number) => Promise<number | null> = async () => process.pid) =>
  requeueProbes({ journal, maps: config.maps, limit: config.workers.probeRequeues, owned: () => {}, spawn });
 return { dir, config, configPath, get journal() { return journal; }, park, retry,
  reopen() { journal.close(); journal = openJournal(config); },
  close() { journal.close(); rmSync(dir, { recursive: true, force: true }); },
 };
}

describe("probe failure classification", () => {
 test("timeouts, shell signals, killed probes and crashes can requeue", () => {
  for (const result of [run(-1), run(137), run(1, failure("killed")), run(1, failure("crash"))]) {
   expect(probeFailureClass([result])).toBe("infrastructure");
  }
 });
 test("assertions and page errors block even a later timeout", () => {
  for (const kind of ["assert", "pageerror"]) {
   expect(probeFailureClass([run(1, failure(kind)), run(-1)])).toBe("assertion");
  }
  expect(probeFailureClass([run(-1, "     │  FAIL  last change can be scrolled to — false")])).toBe("assertion");
 });
 test("unknown/mixed failure kinds do not auto-retry", () => {
  expect(probeFailureClass([run(1, "unknown error"), run(-1)])).toBe("unknown");
  expect(probeFailureClass([run(1, failure("crash") + "\n" + failure("exit"))])).toBe("unknown");
 });
 test("class survives journal truncation and legacy fallback stays narrow", () => {
  expect(infrastructureProbeHead(outcome().slice(0, 400))).toBe(SHA);
  const legacy = probesFailedOutcome({ sha: SHA, pr: 1, exit: -1, failed: [], tail: "lock wait" });
  expect(infrastructureProbeHead(legacy)).toBe(SHA.slice(0, 8));
  expect(infrastructureProbeHead(legacy + "\nFAILED: probe-site.mjs")).toBeNull();
  expect(infrastructureProbeHead(legacy.replace("exit -1", "exit 1"))).toBeNull();
  expect(infrastructureProbeHead(outcome().replace("infrastructure", "assertion"))).toBeNull();
 });
});

describe("automatic probe requeue", () => {
 test("oldest park wins across maps, one per resource lane", async () => {
  const r = rig();
  try {
   r.park("10", A, { finishedAt: "2026-10-07T08:00:00.000Z" });
   r.park("20", B);
   expect(await r.retry()).toMatchObject({ resumed: [`${B}#20`], pending: [`${A}#10`], lanes: ["visual"] });
   expect(r.journal.getWorker("10", A)?.status).toBe("parked");
   expect(r.journal.getWorker("20", B)).toMatchObject({ status: "claimed", pid: process.pid, prNumber: 1, phase: "review" });
  } finally { r.close(); }
 });
 test("occupied lane waits, and retries resume after it frees", async () => {
  const r = rig();
  try {
   r.park("10");
   r.journal.upsertWorker({ repo: B, root: 1, nodeId: "90", lane: "implement", status: "running", pid: process.pid });
   expect(await r.retry()).toMatchObject({ resumed: [], pending: [`${A}#10`], lanes: ["visual"] });
   r.journal.updateWorker("90", B, { status: "success" });
   expect((await r.retry()).resumed).toEqual([`${A}#10`]);
  } finally { r.close(); }
 });
 test("retry budget survives reopening and a changed head has a new budget", async () => {
  const r = rig();
  try {
   for (let i = 0; i < 2; i++) {
    r.park("10");
    expect((await r.retry()).resumed).toEqual([`${A}#10`]);
    r.reopen();
   }
   r.park("10");
   expect((await r.retry()).resumed).toEqual([]);
   r.park("10", A, { outcome: outcome("b".repeat(40)) });
   expect((await r.retry()).resumed).toEqual([`${A}#10`]);
  } finally { r.close(); }
 });
 test("legacy short-head retry counts toward the full-head budget", async () => {
  const r = rig();
  try {
   r.park("10", A, { outcome: probesFailedOutcome({ sha: SHA, pr: 1, exit: -1, failed: [], tail: "lock wait" }) });
   expect((await r.retry()).resumed).toEqual([`${A}#10`]);
   r.park("10");
   expect((await r.retry()).resumed).toEqual([`${A}#10`]);
   r.park("10");
   expect((await r.retry()).resumed).toEqual([]);
  } finally { r.close(); }
 });
 for (const throws of [false, true]) {
  test(`failed spawn retains priority, row and budget (throws=${throws})`, async () => {
   const r = rig();
   try {
    r.park("10");
    expect(await r.retry(async () => { if (throws) throw new Error("spawn failed"); return null; }))
     .toMatchObject({ resumed: [], pending: [`${A}#10`], lanes: ["visual"] });
    expect(r.journal.getWorker("10", A)).toMatchObject({ status: "parked", outcome: outcome(), finishedAt: "2026-10-07T07:00:00.000Z" });
    expect((await r.retry()).resumed).toEqual([`${A}#10`]);
   } finally { r.close(); }
  });
 }
 test("fast child completion is not overwritten", async () => {
  const r = rig();
  try {
   r.park("10");
   await r.retry(async () => {
    r.journal.beginGeneration("10", A);
    r.journal.updateWorker("10", A, { status: "awaiting-merge", pid: 123 });
    return 123;
   });
   expect(r.journal.getWorker("10", A)).toMatchObject({ status: "awaiting-merge", pid: 123 });
  } finally { r.close(); }
 });
 test("pause, veto, scope, modes, disabled budget and non-infrastructure parks are respected", () => {
  const r = rig();
  try {
   r.park("10");
   const candidates = () => probeRequeueCandidates(r.journal, r.config.maps, r.config.workers.probeRequeues);
   r.journal.setPaused(true); expect(candidates()).toEqual([]); r.journal.setPaused(false);
   expect(probeRequeueCandidates(r.journal, r.config.maps, 0)).toEqual([]);
   r.config.maps[0].skip = ["10"]; expect(candidates()).toEqual([]); r.config.maps[0].skip = [];
   r.config.maps[0].nodes = ["11"]; expect(candidates()).toEqual([]); r.config.maps[0].nodes = undefined;
   r.config.maps[0].walk = "research-only"; expect(candidates()).toEqual([]); r.config.maps[0].walk = "full";
   r.config.maps[0].root = 460; expect(candidates()).toEqual([]); r.config.maps[0].root = 1;
   r.park("10", A, { outcome: outcome().replace("infrastructure", "assertion") }); expect(candidates()).toEqual([]);
   r.park("10"); r.journal.recordVeto("10", "veto"); expect(candidates()).toEqual([]);
  } finally { r.close(); }
 });
});

for (const failedSpawn of [false, true]) {
 test(`walk gives probe retries priority over crash respawns, desk send-backs, queued resumes and new claims (failedSpawn=${failedSpawn})`, async () => {
  const r = rig();
  const discord = fakeDiscord();
  const keys = ["PATH", "FAKE_SOMA_DIR", "FAKE_SOMA_STATE", "RANGER_WRITE_TEST", "RANGER_DISCORD_TOKEN", "RANGER_DISCORD_API_BASE", "RANGER_DISCORD_ALLOW_TEST_OVERRIDE", "RANGER_DISCORD_MIN_INTERVAL_MS"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
   const data = join(r.dir, "data"); mkdirSync(data);
   for (const repo of [A, B]) writeFileSync(join(data, repo.replace("/", "__") + "-frontier.json"), JSON.stringify({
    repo, root: "1", frontier: [{ ref: { id: "30" }, node: { id: "30", title: "Build new", kind: "task", autonomy: "auto", probes: [] },
     status: "open", assignees: [], blockedBy: [], author: "alice", typed: true, url: `https://github.com/${repo}/issues/30` }],
   }));
   const state = join(r.dir, "state.json"); writeFileSync(state, JSON.stringify({ nodes: {}, decisions: [] }));
   Object.assign(process.env, { PATH: `${fixturesBin}:${process.env.PATH ?? ""}`, FAKE_SOMA_DIR: data, FAKE_SOMA_STATE: state,
    RANGER_WRITE_TEST: "ghp_write", RANGER_DISCORD_TOKEN: "fake-token", RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
    RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1", RANGER_DISCORD_MIN_INTERVAL_MS: "5" });
   // Map A appears first, but map B's parked retry has priority over both of A's queued sessions.
   r.park("20", B);
   r.journal.upsertWorker({ repo: A, root: 1, nodeId: "90", status: "running", lane: "implement", phase: "review", pid: deadPid, attempts: 0 });
   r.journal.upsertWorker({ repo: A, root: 1, nodeId: "91", status: "awaiting-merge", lane: "implement", phase: "awaiting-merge", prNumber: 91 });
   r.park("92", A, { outcome: "manual resume" });
   const queued = r.journal.enqueueResume({ repo: A, root: 1, nodeId: "92", lane: "visual" });
   const github: ForgePort = { ...realGitHub,
    getPr: async (_repo, number) => ({ iid: number, state: "open", headSha: SHA, webUrl: "" } as ChangeRequest),
    listComments: async () => [{ id: 1, author: "ivy-bot", body: `<!-- ranger:review round=1 sha=${SHA} blockers=1 majors=0 nits=0 -->` }],
   };
   const spawned: string[] = [];
   const result = await walk({ config: r.config, configPath: r.configPath, journal: r.journal, github,
    spawnRunNode: async (args) => { spawned.push(`${args.repo}#${args.nodeId}`); return failedSpawn ? null : process.pid; },
   });
   expect(spawned).toEqual([`${B}#20`]);
   expect(result.maps.flatMap((map) => map.claimed)).toEqual([]);
   expect(result.probeRequeues.resumed).toEqual(failedSpawn ? [] : [`${B}#20`]);
   expect(r.journal.getWorker("90", A)?.attempts).toBe(0);
   expect(r.journal.getWorker("91", A)?.status).toBe("awaiting-merge");
   expect(r.journal.getWorker("92", A)?.status).toBe("parked");
   expect(r.journal.listResumeQueue()).toEqual([queued]);
   expect(r.journal.spawnsToday()).toBe(0); // resumes are existing claims, as with operator resumes
  } finally {
   for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
   discord.stop(); r.close();
  }
 }, 30_000);
}
