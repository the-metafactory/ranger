import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { watchedByMergeDesk } from "../src/merge-desk.ts";
import { freshClaimRefusal } from "../src/candidates.ts";
import { loadConfig, type RangerConfig } from "../src/config.ts";
import { pidAlive } from "../src/exec.ts";
import * as graph from "../src/graph.ts";
import { Journal, openJournal } from "../src/journal.ts";
import { resumeNode } from "../src/resume.ts";
import { stopNode, type StopPorts, type StopResult } from "../src/stop-node.ts";
import { sweepMap } from "../src/sweep.ts";
import { runNode, type RunNodeContext } from "../src/worker.ts";
import { bun, fixturesBin, runCli } from "./support.ts";

const REPO = "acme/widgets";
const KEY = `${REPO}#1`;
const savedEnv = { ...process.env };

let dir: string;
let configPath: string;
let config: RangerConfig;
let journal: Journal;
let children: ChildProcess[];
let script: string;

beforeEach(() => {
 dir = mkdtempSync(join(tmpdir(), "ranger-stop-node-"));
 configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, stringify({
  version: 1,
  maps: [1, 2].map((root) => ({ repo: REPO, root, walk: "full", commands: { test: "bun test" } })),
  bot: { identity: "ivy-bot" },
  auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST" },
  state: { journalPath: join(dir, "journal.sqlite") },
  workers: { spawnCapPerDay: 10 },
 }));
 config = loadConfig(configPath).config;
 journal = openJournal(config);
 children = [];
 script = join(dir, "child.ts");
 writeFileSync(script, [
  `if (process.env.CHILD_IGNORE_TERM === "1") process.on("SIGTERM", () => {});`,
  `else process.on("SIGTERM", () => process.exit(0));`,
  `setInterval(() => {}, 1000);`,
  `console.log("ready");`,
 ].join("\n"));
 Object.assign(process.env, {
  PATH: `${fixturesBin}:${savedEnv.PATH ?? ""}`,
  RANGER_WRITE_TEST: "ghp_write",
  RANGER_NO_SPAWN: "1",
 });
});

afterEach(() => {
 for (const child of children) if (child.pid !== undefined && pidAlive(child.pid)) child.kill("SIGKILL");
 journal.close();
 rmSync(dir, { recursive: true, force: true });
 for (const key of Object.keys(process.env)) if (!(key in savedEnv)) Reflect.deleteProperty(process.env, key);
 Object.assign(process.env, savedEnv);
});

async function disposable(args: string[], env: Record<string, string> = {}): Promise<number> {
 const child = spawn(bun, [script, ...args], {
  detached: true,
  stdio: ["ignore", "pipe", "ignore"],
  env: { ...process.env, ...env },
 });
 children.push(child);
 await new Promise<void>((resolve, reject) => {
  child.once("error", reject);
  child.stdout.on("data", (chunk) => { if (String(chunk).includes("ready")) resolve(); });
 });
 return child.pid!;
}

const supervisor = (nodeId: string, env: Record<string, string> = {}, key = KEY) =>
 disposable(["run-node", nodeId, "--map", key], env);

async function gone(pid: number, within = 3000): Promise<boolean> {
 const deadline = Date.now() + within;
 while (Date.now() < deadline) {
  if (!pidAlive(pid)) return true;
  await new Promise((resolve) => setTimeout(resolve, 25));
 }
 return !pidAlive(pid);
}

function seed(nodeId: string, patch: Parameters<Journal["upsertWorker"]>[0] extends infer R ? Partial<R> : never = {}): number {
 journal.upsertWorker({
  nodeId, repo: REPO, root: 1, status: "running", lane: "implement", phase: "implement",
  worktree: join(dir, `worktree-${nodeId}`), prNumber: 7, ...patch,
 });
 return journal.beginGeneration(nodeId, REPO);
}

const stopCli = async (nodeId: string, generation: string, map = KEY) => {
 const result = await runCli(["stop-node", nodeId, "--map", map, "--generation", generation, "--grace-ms", "5000", "-c", configPath], process.env);
 return { code: result.code, json: JSON.parse(result.stdout) as StopResult, stderr: result.stderr };
};

const livePorts = (overrides: Partial<StopPorts>): StopPorts => ({
 inspect: async () => ({ kind: "alive", command: `bun cli.ts run-node 453 --map ${KEY}` }),
 groupCommands: async () => [],
 signal: () => true,
 signalGroup: () => true,
 sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
 ...overrides,
});

describe("ranger stop-node", () => {
 test("stops the exact generation's supervisor and worker group, keeps the work, and leaves an unrelated worker alone", async () => {
  const worktree = join(dir, "worktree-453");
  mkdirSync(worktree);
  const sup = await supervisor("453");
  const worker = await disposable(["worker", worktree]);
  const other = await supervisor("454");
  const generation = seed("453", { pid: sup, workerPgid: worker, worktree, messageId: "claim-1" });
  seed("454", { pid: other });

  const { code, json } = await stopCli("453", String(generation));

  expect(code).toBe(0);
  expect(json).toMatchObject({ ok: true, state: "stopped", nodeId: "453", map: KEY, generation, recordedGeneration: generation, supervisor: "terminated", workerGroup: "terminated" });
  expect(await gone(sup)).toBe(true);
  expect(await gone(worker)).toBe(true);
  expect(pidAlive(other)).toBe(true);
  expect(journal.getWorker("453", REPO)).toMatchObject({
   status: "stop-requested", pid: null, workerPgid: null, worktree, prNumber: 7, messageId: "claim-1", generation,
  });
  expect(journal.getWorker("454", REPO)).toMatchObject({ status: "running", pid: other });
  const kinds = journal.listEvents(REPO).filter((e) => e.nodeId === "453").map((e) => e.kind);
  expect(kinds).toContain("stop-requested");
  expect(kinds).toContain("stopped");
 });

 test("a repeated stop is idempotent and signals nothing; sweep and the other restart paths leave the node stopped", async () => {
  const sup = await supervisor("453");
  const other = await supervisor("454");
  const generation = seed("453", { pid: sup });
  seed("454", { pid: other });
  expect((await stopCli("453", String(generation))).json.state).toBe("stopped");

  const replay = await stopCli("453", String(generation));
  expect(replay.code).toBe(0);
  expect(replay.json).toMatchObject({ ok: true, state: "already-stopped" });
  expect(pidAlive(other)).toBe(true);

  const respawn = async () => { throw new Error("a stopped node must not respawn"); };
  const read = spyOn(graph, "graphNode").mockRejectedValue(new Error("graph is not under test"));
  try {
   const swept = await sweepMap({ config, journal, map: config.maps[0], token: "ghp_write", botIdentity: "ivy-bot", phase: "liveness", respawn });
   expect(swept.crashed).toBe(0);
  } finally { read.mockRestore(); }
  const row = journal.getWorker("453", REPO)!;
  expect(row.status).toBe("stop-requested");
  expect(watchedByMergeDesk(row)).toBe(false);
  expect(freshClaimRefusal({ repo: REPO }, "453", row)).toContain("resume-node");
 });

 test("sweep that read the row as running before the stop does not respawn it", async () => {
  const generation = seed("453", { pid: 2_000_000_000 });
  const respawned: string[] = [];
  const snapshot = journal.listWorkers.bind(journal);
  const read = spyOn(graph, "graphNode").mockRejectedValue(new Error("graph is not under test"));
  const lister = spyOn(journal, "listWorkers").mockImplementation((...args) => {
   const rows = snapshot(...args);
   journal.requestStop("453", REPO, generation, "stop requested by operator", new Date());
   return rows;
  });
  try {
   const swept = await sweepMap({ config, journal, map: config.maps[0], token: "ghp_write", botIdentity: "ivy-bot", phase: "liveness",
    respawn: async (id) => { respawned.push(id); return 1; } });
   expect(swept.crashed).toBe(0);
  } finally { lister.mockRestore(); read.mockRestore(); }
  expect(respawned).toEqual([]);
  expect(journal.getWorker("453", REPO)?.status).toBe("stop-requested");
 });

 test("a queued resume is cancelled by the stop, and a run-node that starts late refuses", async () => {
  const generation = seed("453");
  journal.enqueueResume({ nodeId: "453", repo: REPO, root: 1, lane: "headless" }, new Date());

  const { json } = await stopCli("453", String(generation));

  expect(json).toMatchObject({ state: "stopped", supervisor: "gone", workerGroup: "gone" });
  expect(journal.listResumeQueue()).toEqual([]);
  const outcome = await runNode("453", { config, map: config.maps[0], token: "ghp_write", botIdentity: "ivy-bot", journal });
  expect(outcome.status).toBe("refused");
  expect(journal.getWorker("453", REPO)).toMatchObject({ status: "stop-requested", generation });
 });

 test("an explicit operator resume restarts a settled stop, and refuses while the stop is unsettled", async () => {
  const generation = seed("453", { pid: 2_000_000_000, workerPgid: 2_000_000_001 });
  const stuck = livePorts({});
  const stopping = await stopNode({ config, journal, ports: stuck, graceMs: 20, killGraceMs: 20, pollMs: 1 }, { nodeId: "453", map: KEY, generation });
  expect(stopping.state).toBe("stopping");
  const spawned: string[] = [];
  const ctx = { config, configPath, journal, spawnRunNode: async ({ nodeId }: { nodeId: string }) => { spawned.push(nodeId); return 999_999; } };
  await expect(resumeNode("453", KEY, ctx)).rejects.toThrow(/stop is not settled/);
  expect(spawned).toEqual([]);

  journal.settleStop("453", REPO, generation, "test");
  expect(await resumeNode("453", KEY, ctx)).toMatchObject({ kind: "started" });
  expect(spawned).toEqual(["453"]);
  expect(journal.getWorker("453", REPO)?.status).toBe("claimed");
 });

 test("a newer generation is superseded, an unrecorded one is refused, and neither signals", async () => {
  const sup = await supervisor("453");
  seed("453", { pid: sup });
  const generation = journal.beginGeneration("453", REPO);

  const older = await stopCli("453", String(generation - 1));
  expect(older.code).toBe(1);
  expect(older.json).toMatchObject({ ok: false, state: "superseded", recordedGeneration: generation, generation: generation - 1 });
  const future = await stopCli("453", String(generation + 1));
  expect(future.json).toMatchObject({ ok: false, state: "refused" });

  expect(pidAlive(sup)).toBe(true);
  expect(journal.getWorker("453", REPO)).toMatchObject({ status: "running", pid: sup });
 });

 test("a wrong map, an unregistered map, a missing row and a bad request are refused without a signal", async () => {
  const sup = await supervisor("453");
  const generation = seed("453", { pid: sup });

  expect((await stopCli("453", String(generation), `${REPO}#2`)).json).toMatchObject({ state: "refused", map: `${REPO}#2` });
  expect((await stopCli("453", String(generation), "acme/other#1")).json).toMatchObject({ state: "refused", map: null });
  expect((await stopCli("999", "1")).json).toMatchObject({ state: "refused" });
  expect((await stopCli("453", "abc")).json).toMatchObject({ state: "refused" });
  expect((await stopCli("45x", "1")).json).toMatchObject({ state: "refused" });

  expect(pidAlive(sup)).toBe(true);
  expect(journal.getWorker("453", REPO)?.status).toBe("running");
 });

 test("a completed worker, a PR awaiting merge and an accepted merge are not stopped", async () => {
  const survivors: number[] = [];
  for (const [id, patch] of [
   ["461", { status: "success" as const }],
   ["462", { status: "awaiting-merge" as const, phase: "awaiting-merge" as const }],
   ["463", { status: "running" as const, phase: "close" as const }],
  ] as const) {
   const sup = await supervisor(id);
   survivors.push(sup);
   const generation = seed(id, { pid: sup, ...patch });
   const { json } = await stopCli(id, String(generation));
   expect(json.ok).toBe(false);
   expect(json.state).toBe(id === "463" ? "refused" : "not-active");
   expect(journal.getWorker(id, REPO)?.status).toBe(patch.status);
  }
  expect(survivors.every(pidAlive)).toBe(true);
 });

 test("a recorded pid that now runs something else is never signalled", async () => {
  const stranger = await disposable(["unrelated"]);
  const generation = seed("453", { pid: stranger });

  const { json } = await stopCli("453", String(generation));

  expect(json).toMatchObject({ state: "stopped", supervisor: "foreign" });
  expect(pidAlive(stranger)).toBe(true);
 });

 test("a supervisor that ignores SIGTERM is killed after the bounded wait", async () => {
  const sup = await supervisor("453", { CHILD_IGNORE_TERM: "1" });
  const generation = seed("453", { pid: sup });

  const result = await stopNode({ config, journal, graceMs: 300, killGraceMs: 3000 }, { nodeId: "453", map: KEY, generation });

  expect(result).toMatchObject({ ok: true, state: "stopped", supervisor: "killed" });
  expect(await gone(sup)).toBe(true);
 });

 test("a process that survives is reported stopping, never stopped", async () => {
  const generation = seed("453", { pid: 4242 });
  const signals: string[] = [];
  const ports = livePorts({ signal: (_pid, signal) => { signals.push(signal); return true; } });

  const result = await stopNode({ config, journal, ports, graceMs: 20, killGraceMs: 20, pollMs: 1 }, { nodeId: "453", map: KEY, generation });

  expect(result).toMatchObject({ ok: false, state: "stopping", supervisor: "alive" });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(journal.getWorker("453", REPO)).toMatchObject({ status: "stop-requested", pid: 4242 });
  const replay = await stopNode({ config, journal, ports: livePorts({ inspect: async () => ({ kind: "gone" }) }) }, { nodeId: "453", map: KEY, generation });
  expect(replay).toMatchObject({ ok: true, state: "stopped", supervisor: "gone" });
 });

 test("a process that cannot be identified is not signalled and the result is unknown", async () => {
  const generation = seed("453", { pid: 4242 });
  const signals: string[] = [];
  const ports = livePorts({ inspect: async () => ({ kind: "unknown" }), signal: (_pid, signal) => { signals.push(signal); return true; } });

  const result = await stopNode({ config, journal, ports, graceMs: 20, pollMs: 1 }, { nodeId: "453", map: KEY, generation });

  expect(result).toMatchObject({ ok: false, state: "unknown", supervisor: "unverified" });
  expect(signals).toEqual([]);
  expect(journal.getWorker("453", REPO)).toMatchObject({ status: "stop-requested", pid: 4242 });
 });

 test("a worker group whose commands do not name the worktree is foreign and left alone", async () => {
  const generation = seed("453", { workerPgid: 5151 });
  const groupSignals: number[] = [];
  const ports = livePorts({
   groupCommands: async () => ["/usr/bin/some-other-tool"],
   signalGroup: (pgid) => { groupSignals.push(pgid); return true; },
  });

  const result = await stopNode({ config, journal, ports }, { nodeId: "453", map: KEY, generation });

  expect(result).toMatchObject({ state: "stopped", workerGroup: "foreign" });
  expect(groupSignals).toEqual([]);
 });

 test("a reused supervisor pid is not signalled while the verified worker group is stopped", async () => {
  const worktree = join(dir, "worktree-453");
  const generation = seed("453", { pid: 4242, workerPgid: 5151 });
  const signals: string[] = [];
  const groupSignals: string[] = [];
  let groupAlive = true;
  const ports = livePorts({
   inspect: async () => ({ kind: "alive", command: "/usr/bin/some-other-tool" }),
   groupCommands: async () => (groupAlive ? [`worker ${worktree}`] : []),
   signal: (_pid, signal) => { signals.push(signal); return true; },
   signalGroup: (_pgid, signal) => { groupSignals.push(signal); groupAlive = false; return true; },
  });

  const result = await stopNode({ config, journal, ports, graceMs: 50, pollMs: 1 }, { nodeId: "453", map: KEY, generation });

  expect(result).toMatchObject({ state: "stopped", supervisor: "foreign", workerGroup: "terminated" });
  expect(signals).toEqual([]);
  expect(groupSignals).toEqual(["SIGTERM"]);
 });

 test("a reused worker group is not signalled while the verified supervisor is stopped", async () => {
  const generation = seed("453", { pid: 4242, workerPgid: 5151 });
  const signals: string[] = [];
  const groupSignals: string[] = [];
  let supervisorAlive = true;
  const ports = livePorts({
   inspect: async () => (supervisorAlive ? { kind: "alive", command: `bun cli.ts run-node 453 --map ${KEY}` } : { kind: "gone" }),
   groupCommands: async () => ["/usr/bin/some-other-tool"],
   signal: (_pid, signal) => { signals.push(signal); supervisorAlive = false; return true; },
   signalGroup: (_pgid, signal) => { groupSignals.push(signal); return true; },
  });

  const result = await stopNode({ config, journal, ports, graceMs: 50, pollMs: 1 }, { nodeId: "453", map: KEY, generation });

  expect(result).toMatchObject({ state: "stopped", supervisor: "terminated", workerGroup: "foreign" });
  expect(signals).toEqual(["SIGTERM"]);
  expect(groupSignals).toEqual([]);
 });
});
