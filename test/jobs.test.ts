import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import { runJobEnqueue } from "../src/cli.ts";
import { ConfigError, loadConfig, type RangerConfig } from "../src/config.ts";
import type { RunOptions, RunResult } from "../src/exec.ts";
import { jobPass, jobPrompt, runJob, JOB_RESULT_ENV, type SpawnJobArgs } from "../src/jobs.ts";
import { openJournal, type Journal } from "../src/journal.ts";
import { ledgerResultRef } from "../src/run-ledger.ts";

const GAME = "acme/seelite";
const dirs: string[] = [];
const journals: Journal[] = [];
afterEach(() => {
 for (const j of journals.splice(0)) j.close();
 for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SHORT = {
 name: "daily-short", skill: "daily-short", lane: "visual", wallClockMin: 90,
 cwd: "/tmp", substrates: ["claude"],
};

function rig(jobs: object[] = [SHORT], extra: Record<string, unknown> = {}) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-jobs-"));
 dirs.push(dir);
 const configPath = join(dir, "ranger.yaml");
 const raw = {
  version: 1,
  // A probe tier puts the map on the visual lane.
  maps: [{ repo: GAME, root: 1, walk: "full", commands: { test: "bun test", probe: "npm run probe" } }],
  state: { journalPath: join(dir, "state.sqlite") },
  bus: { principal: "jc" },
  jobs,
  ...extra,
 };
 writeFileSync(configPath, stringify(raw));
 const config = loadConfig(configPath, {}).config;
 const journal = openJournal(config);
 journals.push(journal);
 const envelopes: ExecutionRunFinishedEvent[] = [];
 const ledger = { env: {}, publisher: async (e: ExecutionRunFinishedEvent) => { envelopes.push(e); } };
 return { dir, configPath, config, journal, envelopes, ledger };
}

/** A recording spawner for the tick's job pass. */
function spawner(pid: number | null = 4242) {
 const calls: SpawnJobArgs[] = [];
 return { calls, spawnJob: async (args: SpawnJobArgs) => { calls.push(args); return pid; } };
}

/** A fake substrate session: records the call, optionally writes a result, returns `result`. */
function session(result: Partial<RunResult> = {}, write?: string) {
 const calls: { bin: string; args: string[]; opts: RunOptions }[] = [];
 return {
  calls,
  runSession: async (bin: string, args: string[], opts: RunOptions): Promise<RunResult> => {
   calls.push({ bin, args, opts });
   opts.onSpawn?.(999_999);
   if (write !== undefined) writeFileSync(opts.env![JOB_RESULT_ENV] as string, `${write}\n`);
   return { code: 0, stdout: "", stderr: "", ...result };
  },
 };
}

/** Hold the visual lane with a running implement session on the game map. */
function holdVisual(journal: Journal) {
 journal.upsertWorker({ nodeId: "7", repo: GAME, root: 1, status: "running", lane: "implement", phase: "implement" });
}

async function startedRun(r: ReturnType<typeof rig>) {
 const { runId } = (JSON.parse(runJobEnqueue("daily-short", r.configPath).report) as { runId: number });
 // A live pid: the sweep must see a running supervisor.
 const s = spawner(process.pid);
 await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: s.spawnJob, ledger: r.ledger });
 return runId;
}

describe("node #301 — scheduled jobs", () => {
 test("ranger.yaml jobs: validated, unique names, defaults", () => {
  const r = rig([{ ...SHORT, substrates: undefined }]);
  expect(r.config.jobs?.[0]).toMatchObject({ name: "daily-short", prompt: "", substrates: ["claude", "codex", "pi"] });
  for (const bad of [[SHORT, SHORT], [{ ...SHORT, lane: "gpu" }], [{ ...SHORT, cwd: "relative" }], [{ ...SHORT, name: "Bad Name" }]]) {
   writeFileSync(r.configPath, stringify({ maps: [{ repo: GAME, root: 1 }], state: { journalPath: join(r.dir, "x.sqlite") }, jobs: bad }));
   expect(() => loadConfig(r.configPath, {})).toThrow(ConfigError);
  }
 });

 test("enqueue queues once; a second enqueue before the run starts is a no-op", () => {
  const r = rig();
  const first = runJobEnqueue("daily-short", r.configPath);
  const second = runJobEnqueue("daily-short", r.configPath);
  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  expect(JSON.parse(first.report)).toMatchObject({ name: "daily-short", lane: "visual", queued: true });
  expect(JSON.parse(second.report)).toMatchObject({ queued: false, runId: JSON.parse(first.report).runId });
  expect(r.journal.listJobRuns("queued")).toHaveLength(1);
 });

 test("an unknown job name exits non-zero and queues nothing", () => {
  const r = rig();
  const result = runJobEnqueue("nightly-thing", r.configPath);
  expect(result.exitCode).toBe(1);
  expect(result.report).toContain("no job named 'nightly-thing'");
  expect(r.journal.listJobRuns()).toHaveLength(0);
 });

 test("a queued visual job waits while a visual implement session holds the lane", async () => {
  const r = rig();
  runJobEnqueue("daily-short", r.configPath);
  holdVisual(r.journal);
  const s = spawner();
  const pass = await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: s.spawnJob });
  expect(s.calls).toHaveLength(0);
  expect(pass.waiting[0].reason).toContain("held by #7");
  expect(r.journal.listJobRuns("queued")).toHaveLength(1);
 });

 test("a running visual job holds the lane against implement sessions, and never runs beside one", async () => {
  const r = rig();
  const runId = await startedRun(r);
  expect(r.journal.getJobRun(runId)).toMatchObject({ status: "running", pid: process.pid });
  const holder = r.journal.laneHolder("visual");
  expect(holder).toMatchObject({ job: "daily-short", nodeId: "job:daily-short" });
  // The headless lane stays free.
  expect(r.journal.laneHolder("headless")).toBeNull();
  // A second run queued now waits on the first.
  runJobEnqueue("daily-short", r.configPath);
  const pass = await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: spawner().spawnJob });
  expect(pass.waiting[0].reason).toContain("held by job daily-short");
 });

 test("a lane a claim took this tick is not given to a job", async () => {
  const r = rig();
  runJobEnqueue("daily-short", r.configPath);
  const s = spawner();
  const pass = await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: s.spawnJob, takenLanes: new Set(["visual"]) });
  expect(s.calls).toHaveLength(0);
  expect(pass.waiting[0].reason).toContain("taken this tick");
 });

 test("paused, drained or out of spawn budget: the job waits", async () => {
  const capped = rig([SHORT], { workers: { spawnCapPerDay: 1 } });
  capped.journal.recordSpawn();
  runJobEnqueue("daily-short", capped.configPath);
  let pass = await jobPass({ config: capped.config, configPath: capped.configPath, journal: capped.journal, spawnJob: spawner().spawnJob });
  expect(pass.waiting[0].reason).toBe("daily spawn cap reached");

  const r = rig();
  runJobEnqueue("daily-short", r.configPath);
  r.journal.setVisualLaneDrained(true);
  pass = await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: spawner().spawnJob });
  expect(pass.waiting[0].reason).toBe("visual lane drained");
 });

 test("a free lane: the tick spawns the job's supervisor and counts the spawn", async () => {
  const r = rig();
  runJobEnqueue("daily-short", r.configPath);
  const s = spawner();
  const pass = await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: s.spawnJob });
  expect(pass.started).toEqual([{ runId: 1, name: "daily-short", lane: "visual", pid: 4242 }]);
  expect(s.calls[0]).toMatchObject({ runId: 1, configPath: r.configPath });
  expect(r.journal.spawnsToday()).toBe(1);
 });

 test("the supervisor runs the skill through claude -p in the job's cwd, without ranger's secrets", async () => {
  const r = rig();
  const runId = await startedRun(r);
  const s = session({}, "soma:outputs/G6/2026-10-15.md");
  process.env.RANGER_DISCORD_TOKEN = "secret";
  try {
   const outcome = await runJob(runId, { config: r.config, journal: r.journal, runSession: s.runSession, substrateReaders: {
    claude: async () => { throw new Error("no read"); }, codex: async () => { throw new Error("no read"); },
   }, ledger: r.ledger });
   expect(outcome).toMatchObject({ status: "succeeded", substrate: "claude", result: "soma:outputs/G6/2026-10-15.md" });
  } finally {
   delete process.env.RANGER_DISCORD_TOKEN;
  }
  const call = s.calls[0];
  expect([call.bin, ...call.args]).toEqual(["claude", "-p", "--model", "claude-sonnet-5-5", "--output-format", "stream-json", "--verbose", "/daily-short"]);
  expect(call.opts).toMatchObject({ cwd: "/tmp", timeoutMs: 90 * 60_000, processGroup: true });
  expect(call.opts.nice).toBeUndefined();
  expect(call.opts.env?.RANGER_DISCORD_TOKEN).toBeUndefined();
  expect(call.opts.env?.RANGER_JOURNAL_PATH).not.toBe(r.config.state.journalPath);
  expect(r.journal.getJobRun(runId)).toMatchObject({ status: "succeeded", pgid: null, substrate: "claude" });
  // The lane is free again.
  expect(r.journal.laneHolder("visual")).toBeNull();
 });

 test("a finished run emits exactly one envelope: the job name as ran.ref, its outcome and result_ref", async () => {
  const r = rig();
  const runId = await startedRun(r);
  await runJob(runId, { config: r.config, journal: r.journal, substrate: "claude",
   runSession: session({}, "soma:outputs/G6/2026-10-15.md").runSession, ledger: r.ledger });
  expect(r.envelopes).toHaveLength(1);
  const payload = r.envelopes[0].input.payload;
  expect(payload).toMatchObject({ producer: "ranger", ran: { kind: "job", ref: "daily-short" }, outcome: "succeeded",
   result_ref: "soma:outputs/G6/2026-10-15.md" });
  expect(payload.detail_ref).toContain("logs/jobs/daily-short-1.log");
 });

 test("a result that is not a soma: ref stays in the journal and off the envelope", async () => {
  const r = rig();
  const runId = await startedRun(r);
  await runJob(runId, { config: r.config, journal: r.journal, substrate: "claude",
   runSession: session({}, "https://youtube.com/shorts/C67Fj9RkhRI").runSession, ledger: r.ledger });
  expect(r.envelopes[0].input.payload).not.toHaveProperty("result_ref");
  expect(r.journal.getJobRun(runId)?.result).toBe("https://youtube.com/shorts/C67Fj9RkhRI");
 });

 test("past wallClockMin the run is failed with reason budget, one envelope, no result_ref", async () => {
  const r = rig();
  const runId = await startedRun(r);
  const outcome = await runJob(runId, { config: r.config, journal: r.journal, substrate: "claude",
   runSession: session({ code: -1, timedOut: true }, "soma:outputs/x.md").runSession, ledger: r.ledger });
  expect(outcome).toMatchObject({ status: "failed", reason: "budget" });
  expect(r.journal.getJobRun(runId)).toMatchObject({ status: "failed", reason: "budget" });
  expect(r.envelopes).toHaveLength(1);
  expect(r.envelopes[0].input.payload).toMatchObject({ outcome: "failed" });
  expect(r.envelopes[0].input.payload).not.toHaveProperty("result_ref");
 });

 test("requireResult: a clean exit with no result fails as no result; with a result it succeeds", async () => {
  const r = rig([{ ...SHORT, requireResult: true }]);
  const runId = await startedRun(r);
  const outcome = await runJob(runId, { config: r.config, journal: r.journal, substrate: "claude", runSession: session().runSession, ledger: r.ledger });
  expect(outcome).toMatchObject({ status: "failed", reason: "no result", result: null });
  expect(r.journal.getJobRun(runId)).toMatchObject({ status: "failed", reason: "no result" });
  expect(r.envelopes).toHaveLength(1);
  expect(r.envelopes[0].input.payload).toMatchObject({ outcome: "failed" });

  const s = rig([{ ...SHORT, requireResult: true }]);
  const okId = await startedRun(s);
  const ok = await runJob(okId, { config: s.config, journal: s.journal, substrate: "claude",
   runSession: session({}, "soma:outputs/G6/2026-10-15.md").runSession, ledger: s.ledger });
  expect(ok).toMatchObject({ status: "succeeded", result: "soma:outputs/G6/2026-10-15.md" });
 });

 test("without requireResult a clean exit with no result still succeeds", async () => {
  const r = rig();
  const runId = await startedRun(r);
  await runJob(runId, { config: r.config, journal: r.journal, substrate: "claude", runSession: session().runSession, ledger: r.ledger });
  expect(r.journal.getJobRun(runId)).toMatchObject({ status: "succeeded", reason: null, result: null });
 });

 test("a non-zero exit fails the run with its exit code", async () => {
  const r = rig();
  const runId = await startedRun(r);
  await runJob(runId, { config: r.config, journal: r.journal, substrate: "claude", runSession: session({ code: 3 }).runSession, ledger: r.ledger });
  expect(r.journal.getJobRun(runId)).toMatchObject({ status: "failed", reason: "exit 3" });
 });

 test("a dead supervisor is swept to failed (crashed), reported once, and frees the lane", async () => {
  const r = rig();
  const runId = await startedRun(r);
  r.journal.updateJobRun(runId, "running", { pid: 2_147_483_000 });
  const pass = await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: spawner().spawnJob, ledger: r.ledger });
  expect(pass.failed).toEqual([{ runId, name: "daily-short", reason: "crashed" }]);
  expect(r.journal.laneHolder("visual")).toBeNull();
  expect(r.envelopes).toHaveLength(1);
  // A late supervisor finishing the same run reports nothing more.
  r.envelopes.length = 0;
  const late = await runJob(runId, { config: r.config, journal: r.journal, substrate: "claude", runSession: session().runSession, ledger: r.ledger });
  expect(late.status).toBe("refused");
  expect(r.envelopes).toHaveLength(0);
 });

 test("a reservation whose tick died before recording a pid is swept as spawn and frees the lane", async () => {
  const r = rig();
  const { runId } = JSON.parse(runJobEnqueue("daily-short", r.configPath).report) as { runId: number };
  // The tick reserved the lane, then died before the spawn recorded a pid.
  r.journal.updateJobRun(runId, "queued", { status: "running", startedAt: new Date().toISOString() });
  expect(r.journal.laneHolder("visual")).not.toBeNull();
  const pass = await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: spawner().spawnJob, ledger: r.ledger });
  expect(pass.failed).toEqual([{ runId, name: "daily-short", reason: "spawn" }]);
  expect(r.journal.laneHolder("visual")).toBeNull();
  expect(r.envelopes).toHaveLength(1);
  expect(r.journal.getJobRun(runId)?.reportedAt).not.toBeNull();
 });

 test("a finished run its supervisor never reported is reported once by the sweep, after the supervisor is gone", async () => {
  const r = rig();
  const runId = await startedRun(r);
  // The supervisor committed the terminal status, then died before its emit.
  r.journal.updateJobRun(runId, "running", { status: "succeeded", finishedAt: new Date().toISOString(), result: "soma:outputs/G6-2026-10-15.md" });
  let pass = await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: spawner().spawnJob, ledger: r.ledger });
  // Its pid (this process) is alive: the report is still the supervisor's.
  expect(r.envelopes).toHaveLength(0);
  r.journal.updateJobRun(runId, "succeeded", { pid: 2_147_483_000 });
  pass = await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: spawner().spawnJob, ledger: r.ledger });
  expect(pass.errors).toEqual([]);
  expect(r.envelopes).toHaveLength(1);
  expect(r.envelopes[0].input.payload).toMatchObject({ ran: { ref: "daily-short" }, outcome: "succeeded", result_ref: "soma:outputs/G6-2026-10-15.md" });
  await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: spawner().spawnJob, ledger: r.ledger });
  expect(r.envelopes).toHaveLength(1);
 });

 test("a second supervisor for a run another live process supervises is refused, and starts no session", async () => {
  const r = rig();
  const runId = await startedRun(r);
  // The tick recorded a different, live supervisor (this test runner's parent).
  r.journal.updateJobRun(runId, "running", { pid: process.ppid });
  const s = session();
  const outcome = await runJob(runId, { config: r.config, journal: r.journal, substrate: "claude", runSession: s.runSession, ledger: r.ledger });
  expect(outcome).toMatchObject({ status: "refused" });
  expect(s.calls).toHaveLength(0);
  expect(r.journal.getJobRun(runId)).toMatchObject({ status: "running", pid: process.ppid });
 });

 test("an envelope repeated after a crash carries the run's own run_id", async () => {
  const r = rig();
  const runId = await startedRun(r);
  await runJob(runId, { config: r.config, journal: r.journal, substrate: "claude", runSession: session().runSession, ledger: r.ledger });
  const uuid = r.journal.getJobRun(runId)!.runUuid;
  // The supervisor emitted, then died before marking the run reported.
  r.journal.updateJobRun(runId, "succeeded", { reportedAt: null, pid: 2_147_483_000 });
  await jobPass({ config: r.config, configPath: r.configPath, journal: r.journal, spawnJob: spawner().spawnJob, ledger: r.ledger });
  expect(r.envelopes.map(e => e.input.payload.run_id)).toEqual([uuid, uuid]);
 });

 test("a completed run is marked reported", async () => {
  const r = rig();
  const runId = await startedRun(r);
  await runJob(runId, { config: r.config, journal: r.journal, substrate: "claude", runSession: session().runSession, ledger: r.ledger });
  expect(r.journal.getJobRun(runId)?.reportedAt).not.toBeNull();
  expect(r.envelopes).toHaveLength(1);
 });

 test("a quota pick outside the job's substrates falls back to its first", async () => {
  const r = rig();
  const runId = await startedRun(r);
  const s = session();
  // Both strong readings fail: the policy picks pi, which the job does not allow.
  await runJob(runId, { config: r.config as RangerConfig, journal: r.journal, runSession: s.runSession, ledger: r.ledger,
   substrateReaders: { claude: async () => { throw new Error("x"); }, codex: async () => { throw new Error("x"); } } });
  expect(s.calls[0].bin).toBe("claude");
 });

 test("prompts and result refs", () => {
  expect(jobPrompt({ skill: "daily-short", prompt: "" }, "claude")).toBe("/daily-short");
  expect(jobPrompt({ skill: "weekly", prompt: "for G5" }, "codex")).toBe("Use the weekly skill. for G5");
  expect(ledgerResultRef("soma:outputs/a.md", "succeeded")).toBe("soma:outputs/a.md");
  for (const bad of ["https://x", "soma:/abs", "soma:a/../b", "soma:", "soma:a b"]) expect(ledgerResultRef(bad, "succeeded")).toBeUndefined();
  expect(ledgerResultRef("soma:outputs/a.md", "failed")).toBeUndefined();
 });
});
