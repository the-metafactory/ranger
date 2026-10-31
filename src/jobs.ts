/**
 * Scheduled jobs (node #301): a Reflex fire enqueues a named job
 * (`ranger job enqueue <name>`, through a cortex process spec); the next tick
 * runs the job's skill headless on the lane the job declares, within its
 * wall clock and the spawn budget, and reports one `execution.run.finished`
 * per run. A job opens no PR, claims no node and writes no graph.
 *
 * enqueue → queued row (one per job at a time) → the tick's job pass reserves
 * the lane (running row) and spawns a detached `ranger job run <id>` → the
 * supervisor picks a substrate, runs the session, records the outcome and
 * emits the envelope. The tick's job sweep fails a run whose supervisor died.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunOutcome } from "@the-metafactory/myelin";
import { expandHome, type RangerConfig, type RangerJobConfig } from "./config.ts";
import { pidAlive, killProcessGroup, processGroupCommands, runCmd, type RunOptions, type RunResult } from "./exec.ts";
import type { JobRunRow, Journal } from "./journal.ts";
import { JOURNAL_PATH_ENV, sessionJournalPath } from "./journal-guard.ts";
import type { ImplementLane, JobLane } from "./lanes.ts";
import { emitJobRunFinished, type RunLedgerDeps } from "./run-ledger.ts";
import type { SubstrateName } from "./store/schema.ts";
import { selectSubstrate, workerCommandFor, workerOutputFor, type SubstrateReaders } from "./substrate.ts";
import { selectForBuild } from "./substrate-policy.ts";
import { finishStudio, prepareStudio, studioCommand, studioEnvironment, studioLimit, studioPrompt, studioSubstrates, validateStudioParams } from "./studio-think.ts";
import { workerHostEnv } from "./worker-env.ts";

/** Where a job's session writes what it produced (e.g. `soma:outputs/…`), for `result_ref`. */
export const JOB_RESULT_ENV = "RANGER_JOB_RESULT_FILE";
/** The longest result ranger keeps from a session. */
const RESULT_MAX_CHARS = 2_000;

export class JobError extends Error {
 override readonly name = "JobError";
}

/** The job named `name` in ranger.yaml; an unknown name throws. */
export function findJob(config: RangerConfig, name: string): RangerJobConfig {
 const job = config.jobs?.find(j => j.name === name);
 if (job === undefined) {
  const known = (config.jobs ?? []).map(j => j.name);
  throw new JobError(`no job named '${name}' in ranger.yaml${known.length === 0 ? " (no jobs declared)" : `; jobs: ${known.join(", ")}`}`);
 }
 return job;
}

/**
 * Queue a run of a declared job. A second enqueue while a run is still
 * queued is a no-op (`queued: false`); an unknown name throws and queues nothing.
 */
export function enqueueJob(
 config: RangerConfig,
 journal: Pick<Journal, "enqueueJobRun">,
 name: string,
 now = new Date(),
 params: Record<string, string> = {},
): { name: string; runId: number; lane: JobLane; queued: boolean } {
 const job = findJob(config, name);
 if (name === "ivy-think") validateStudioParams(params);
 else if (Object.keys(params).length > 0) throw new JobError("Only ivy-think currently accepts named parameters");
 const { run, queued } = journal.enqueueJobRun(job.name, job.lane, now, params);
 return { name: job.name, runId: run.id, lane: job.lane, queued };
}

// ---- the tick's job pass ----

export interface SpawnJobArgs {
 runId: number;
 cliEntry: string;
 configPath: string;
}

export function jobRunArgv(args: SpawnJobArgs): string[] {
 // The same bun pins as a detached run-node (spawn.ts runNodeArgv).
 return [
  `--config=${join(dirname(args.cliEntry), "..", "bunfig.toml")}`,
  "--no-env-file",
  args.cliEntry,
  "job",
  "run",
  String(args.runId),
  "--config",
  args.configPath,
 ];
}

/** Launch a detached `ranger job run <id>` that outlives the tick. Null when nothing spawned. */
export async function spawnJobDetached(args: SpawnJobArgs): Promise<number | null> {
 const child = spawn(process.execPath, jobRunArgv(args), { detached: true, stdio: "ignore", env: process.env });
 child.on("error", () => {});
 child.unref();
 return child.pid ?? null;
}

export interface JobPassResult {
 started: { runId: number; name: string; lane: JobLane; pid: number }[];
 waiting: { runId: number; name: string; reason: string }[];
 /** Runs this pass ended: a dead supervisor, a job no longer declared, a failed spawn. */
 failed: { runId: number; name: string; reason: string }[];
 errors: string[];
}

export interface JobPassContext {
 config: RangerConfig;
 configPath: string;
 journal: Journal;
 spawnJob?: (args: SpawnJobArgs) => Promise<number | null>;
 now?: () => Date;
 /** Lanes an implement claim or resume took earlier in this tick. */
 takenLanes?: Set<ImplementLane>;
 cliEntry?: string;
 ledger?: RunLedgerDeps;
}

/** Does the tick have job work: a run to start, to watch, or to report? */
export function jobsPending(journal: Pick<Journal, "listJobRuns" | "listUnreportedJobRuns">): boolean {
 return journal.listJobRuns("queued").length > 0 || journal.listJobRuns("running").length > 0
  || journal.listUnreportedJobRuns().length > 0;
}

export function emptyJobPass(): JobPassResult {
 return { started: [], waiting: [], failed: [], errors: [] };
}

/**
 * Hand a finished run's envelope to the ledger, then mark it reported.
 * The terminal status is committed first, so a process cut off between the
 * two leaves an unreported finished row that `sweepJobs` reports later. The
 * emit fails open like the tick's and run-node's: a ledger write that fails
 * records a `ledger-failed` journal event, and the run still counts as
 * reported, so that envelope is not retried. A crash between the emit and
 * the mark repeats the envelope, with the same `run_id`.
 */
async function reportRun(ctx: Pick<JobPassContext, "config" | "journal" | "ledger">, id: number): Promise<void> {
 const run = ctx.journal.getJobRun(id);
 if (run === null || run.reportedAt !== null || (run.status !== "succeeded" && run.status !== "failed")) return;
 const outcome: RunOutcome = run.status;
 await emitJobRunFinished(ctx.config, ctx.journal, {
  runUuid: run.runUuid, name: run.name, startedAt: run.startedAt ?? run.queuedAt, endedAt: run.finishedAt ?? run.queuedAt,
  outcome, result: run.result, log: run.log,
 }, ctx.ledger);
 ctx.journal.updateJobRun(id, run.status, { reportedAt: new Date().toISOString() });
}

/** End a run that never reached a session, or whose supervisor died, and report it. */
async function failRun(
 ctx: Pick<JobPassContext, "config" | "journal" | "ledger">,
 run: JobRunRow,
 reason: string,
 now: Date,
): Promise<boolean> {
 const ended = now.toISOString();
 if (!ctx.journal.updateJobRun(run.id, run.status, { status: "failed", reason, finishedAt: ended, pid: null, pgid: null })) return false;
 ctx.journal.recordEvent("job-finished", { detail: `job ${run.name} run ${run.id} failed: ${reason}` });
 await reportRun(ctx, run.id);
 return true;
}

/**
 * A running run whose supervisor is gone failed (`crashed`). Its session
 * group may outlive it on the GPU, so the group is killed, but only after
 * `ps` confirms it still runs the job's skill: a recycled group id is never
 * killed on the journal's word alone.
 *
 * A running row with no pid was reserved by a tick that died before its
 * spawn recorded one: the reserving tick holds the claim lock from the
 * reservation to the pid, and so does this sweep, so such a row is abandoned
 * (`spawn`). A supervisor that did start writes its own pid first thing.
 *
 * A finished run never reported (its process died between status and emit)
 * is reported here once its supervisor is gone.
 */
export async function sweepJobs(ctx: JobPassContext, result: JobPassResult): Promise<void> {
 const now = ctx.now?.() ?? new Date();
 for (const run of ctx.journal.listUnreportedJobRuns()) {
  if (run.pid !== null && pidAlive(run.pid)) continue;
  await reportRun(ctx, run.id);
 }
 for (const run of ctx.journal.listJobRuns("running")) {
  if (run.pid === null) {
   if (await failRun(ctx, run, "spawn", now)) result.failed.push({ runId: run.id, name: run.name, reason: "spawn" });
   continue;
  }
  if (pidAlive(run.pid)) continue;
  const skill = run.name === "ivy-think" ? "Studio ivy-think job" : ctx.config.jobs?.find(j => j.name === run.name)?.skill;
  if (run.pgid !== null && skill !== undefined) {
   const commands = await processGroupCommands(run.pgid);
   if (commands.some(c => c.includes(skill))) killProcessGroup(run.pgid);
  }
  if (await failRun(ctx, run, "crashed", now)) result.failed.push({ runId: run.id, name: run.name, reason: "crashed" });
 }
}

/**
 * Start each queued run whose lane is free, FIFO. A run waits while the
 * dead-man switch is paused, its lane is drained, the day's spawn cap is
 * spent, or its lane is held (an implement session, another job, or a claim
 * earlier in this tick). Call under the claim lock, before fresh claims.
 */
export async function jobPass(ctx: JobPassContext): Promise<JobPassResult> {
 const { config, journal } = ctx;
 const result = emptyJobPass();
 await sweepJobs(ctx, result);
 const taken = ctx.takenLanes ?? new Set<ImplementLane>();
 for (const run of journal.listJobRuns("queued")) {
  const now = ctx.now?.() ?? new Date();
  const job = config.jobs?.find(j => j.name === run.name);
  if (job === undefined) {
   if (await failRun(ctx, run, "job no longer declared", now)) {
    result.failed.push({ runId: run.id, name: run.name, reason: "job no longer declared" });
   }
   continue;
  }
  const lane = run.lane;
  const wait = (reason: string) => {
   journal.updateJobRun(run.id, "queued", { reason });
   result.waiting.push({ runId: run.id, name: run.name, reason });
  };
  if (run.name === "ivy-think") {
   const prepared = await prepareStudio(job, run.params);
   if (prepared.kind === "deferred") { wait(prepared.reason); continue; }
   const limit = job.studio ? studioLimit(prepared, job.studio, journal.listJobRuns(), now, run.id) : "Studio job is not configured";
   if (limit) { wait(limit); continue; }
   if ((await studioSubstrates(job, config, prepared.policy)).length === 0) { wait(`No permitted ${prepared.policy} substrate is available`); continue; }
   journal.updateJobRun(run.id, "queued", { policy: prepared.policy, reason: null });
  }
  if (journal.isPaused()) { wait("dead-man paused"); continue; }
  if (lane === "visual" && journal.isVisualLaneDrained()) { wait("visual lane drained"); continue; }
  if (journal.spawnsToday(now) >= config.workers.spawnCapPerDay) { wait("daily spawn cap reached"); continue; }
  if (lane !== "none" && taken.has(lane)) { wait(`the ${lane} lane was taken this tick`); continue; }
  const holder = lane === "none" ? null : journal.laneHolder(lane);
  if (holder !== null) {
   wait(`the ${lane} lane is held by ${holder.job === undefined ? `#${holder.nodeId} (${holder.repo}#${holder.root})` : `job ${holder.job}`}`);
   continue;
  }
  // Reserve the lane before spawning: the child must find a running row,
  // and every other scheduler must see the lane occupied.
  if (!journal.updateJobRun(run.id, "queued", { status: "running", startedAt: now.toISOString() })) continue;
  if (lane !== "none") taken.add(lane);
  journal.recordSpawn(now);
  let pid: number | null = null;
  try {
   pid = await (ctx.spawnJob ?? spawnJobDetached)({
    runId: run.id,
    cliEntry: ctx.cliEntry ?? join(import.meta.dir, "cli.ts"),
    configPath: ctx.configPath,
   });
  } catch (error) {
   result.errors.push(`job ${run.name}: spawn failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const running = journal.getJobRun(run.id)!;
  if (pid === null) {
   if (await failRun(ctx, running, "spawn", now)) result.failed.push({ runId: run.id, name: run.name, reason: "spawn" });
   continue;
  }
  // The child may already have recorded its own pid (the same process).
  if (running.pid === null) journal.updateJobRun(run.id, "running", { pid });
  journal.recordEvent("job-started", { detail: `job ${run.name} run ${run.id} started ${lane === "none" ? "without a lane" : `on the ${lane} lane`} (pid ${pid})` });
  result.started.push({ runId: run.id, name: run.name, lane, pid });
 }
 return result;
}

// ---- the supervisor: `ranger job run <id>` ----

/** The session prompt: Claude invokes the skill as a slash command; Codex and Pi are asked to use it. */
export function jobPrompt(job: Pick<RangerJobConfig, "skill" | "prompt">, substrate: SubstrateName): string {
 const rest = job.prompt.trim();
 return substrate === "claude"
  ? `/${job.skill}${rest === "" ? "" : ` ${rest}`}`
  : `Use the ${job.skill} skill.${rest === "" ? "" : ` ${rest}`}`;
}

/** The run's session log, next to the journal (like a worker's). */
export function jobLogFile(journalPath: string, name: string, runId: number): string {
 return join(dirname(journalPath), "logs", "jobs", `${name}-${runId}.log`);
}

function saveJobLog(journalPath: string, run: JobRunRow, substrate: SubstrateName, result: RunResult): string | null {
 const file = jobLogFile(journalPath, run.name, run.id);
 try {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, [
   `===== ${new Date().toISOString()} job ${run.name} run ${run.id} on ${substrate} — exit ${result.code}${result.timedOut ? " (wall clock)" : ""}`,
   "----- stdout", result.stdout, "----- stderr", result.stderr, "",
  ].join("\n"), { mode: 0o600 });
  return file;
 } catch {
  return null; // The log is evidence, never a gate.
 }
}

function readResult(file: string): string | null {
 try {
  const text = readFileSync(file, "utf8").split("\n")[0]?.trim() ?? "";
  return text === "" ? null : text.slice(0, RESULT_MAX_CHARS);
 } catch {
  return null;
 }
}

export interface RunJobContext {
 config: RangerConfig;
 journal: Journal;
 now?: () => Date;
 /** The session runner (tests inject a fake substrate). */
 runSession?: (bin: string, args: string[], opts: RunOptions) => Promise<RunResult>;
 /** Substrate quota readers (tests inject fakes, as the implement lane's do). */
 substrateReaders?: SubstrateReaders;
 /** Pin the substrate instead of picking by quota. */
 substrate?: SubstrateName;
 ledger?: RunLedgerDeps;
}

export interface RunJobOutcome {
 runId: number;
 name: string;
 status: "succeeded" | "failed" | "refused" | "deferred";
 reason?: string;
 substrate?: SubstrateName;
 result?: string | null;
 log?: string | null;
}

/**
 * Supervise one job run the tick started: pick the substrate (quota-picked
 * among the job's `substrates`), run the skill session in the job's cwd under
 * the worker host env (no ranger credentials, a per-session journal), kill it
 * at the wall clock, then record the outcome and hand its envelope to the ledger.
 */
export async function runJob(runId: number, ctx: RunJobContext): Promise<RunJobOutcome> {
 const { config, journal } = ctx;
 const now = () => ctx.now?.() ?? new Date();
 const run = journal.getJobRun(runId);
 if (run === null || run.status !== "running") {
  return { runId, name: run?.name ?? "?", status: "refused", reason: run === null ? "no such run" : `run is ${run.status}, not running` };
 }
 if (!journal.claimJobRun(runId, process.pid)) {
  return { runId, name: run.name, status: "refused", reason: `run is supervised by pid ${run.pid}` };
 }
 let job: RangerJobConfig;
 try {
  job = findJob(config, run.name);
 } catch (error) {
  await failRun(ctx, run, "job no longer declared", now());
  return { runId, name: run.name, status: "failed", reason: (error as Error).message };
 }

 const studio = run.name === "ivy-think" ? await prepareStudio(job, run.params) : null;
 const defer = (reason: string): RunJobOutcome => {
  journal.updateJobRun(runId, "running", { status: "queued", reason, startedAt: null, pid: null, pgid: null });
  return { runId, name: run.name, status: "deferred", reason };
 };
 if (studio?.kind === "deferred") return defer(studio.reason);
 if (studio?.kind === "ready" && job.studio) {
  const limit = studioLimit(studio, job.studio, journal.listJobRuns(), now(), run.id);
  if (limit) return defer(limit);
 }
 const permitted = studio?.kind === "ready" ? await studioSubstrates(job, config, studio.policy) : job.substrates;
 if (permitted.length === 0) return defer("No policy-permitted substrate is available");
 if (ctx.substrate !== undefined && !permitted.includes(ctx.substrate)) return defer("Requested substrate is forbidden by the job policy");
 let substrate = ctx.substrate ?? permitted[0];
 if (ctx.substrate === undefined && studio?.policy !== "local") {
  try {
   const picked = (await selectSubstrate(journal, {
    config: config.substrates, excluded: new Set(), readers: ctx.substrateReaders, pick: selectForBuild,
   })).substrate;
   if (permitted.includes(picked)) substrate = picked;
  } catch {
   substrate = permitted[0] ?? substrate;
  }
 }
 journal.updateJobRun(runId, "running", { substrate, ...(studio?.kind === "ready" ? { policy: studio.policy } : {}) });

 const scratch = mkdtempSync(join(tmpdir(), "ranger-job-"));
 const resultFile = join(scratch, "result");
 const command = studio?.kind === "ready" ? studioCommand(substrate, config, resultFile) : workerCommandFor(substrate, config);
 const output = workerOutputFor(substrate);
 let raw: RunResult;
 try {
  raw = await (ctx.runSession ?? runCmd)(command[0], [...command.slice(1), studio?.kind === "ready" ? studioPrompt(studio) : jobPrompt(job, substrate)], {
   cwd: studio?.kind === "ready" ? scratch : expandHome(job.cwd),
   timeoutMs: job.wallClockMin * 60_000,
   processGroup: true,
   // A visual job (GPU capture) keeps normal priority, as the browser probes do.
   nice: job.lane === "visual" ? undefined : config.workers.niceness,
   env: { ...(studio?.kind === "ready" ? studioEnvironment() : workerHostEnv()), [JOURNAL_PATH_ENV]: sessionJournalPath(), [JOB_RESULT_ENV]: resultFile },
   onSpawn: pgid => journal.updateJobRun(runId, "running", { pgid }),
   ...(studio?.kind === "ready" ? {} : output.runOptions),
  });
 } catch (error) {
  raw = { code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
 }
 let result = readResult(resultFile);
 if (studio?.kind === "ready" && raw.code === 0 && !raw.timedOut) {
  try {
   const modelText = substrate === "codex" ? readFileSync(resultFile, "utf8") : raw.stdout;
   result = await finishStudio(studio, job, run, substrate, modelText, now());
  } catch (error) {
   raw = { ...raw, code: -1, stderr: `${raw.stderr}\n${error instanceof Error ? error.message : String(error)}` };
  }
 }
 rmSync(scratch, { recursive: true, force: true });
 const read = studio?.kind === "ready" ? raw : output.read(raw, journal).result;
 const log = saveJobLog(journal.path, run, substrate, read);

 const reason = raw.timedOut ? "budget"
  : raw.code !== 0 ? `exit ${raw.code}`
  : job.requireResult && result === null ? "no result"
  : undefined;
 const outcome: RunOutcome = reason === undefined ? "succeeded" : "failed";
 const ended = now().toISOString();
 // The pid stays on the finished row until it is reported, so a sweep
 // leaves the report to this live supervisor.
 const recorded = journal.updateJobRun(runId, "running", {
  status: outcome === "succeeded" ? "succeeded" : "failed",
  finishedAt: ended, reason: reason ?? null, result, log, pgid: null,
 });
 // A sweep that already failed this run reported it.
 if (recorded) {
  journal.recordEvent("job-finished", { detail: `job ${run.name} run ${runId} ${outcome}${reason === undefined ? "" : `: ${reason}`}` });
  await reportRun(ctx, runId);
 }
 return { runId, name: run.name, status: outcome === "succeeded" ? "succeeded" : "failed", reason, substrate, result, log };
}
