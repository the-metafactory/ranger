import { join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { withClaimLock } from "./claim-lock.ts";
import { executionRefusal } from "./forge-ref.ts";
import { pidAlive } from "./exec.ts";
import { assertWriteIdentity, WriteGateError } from "./identity.ts";
import type { Journal, ResumeQueueRow, WorkerStatus } from "./journal.ts";
import { implementLane, startsImplementSession, type ImplementLane } from "./lanes.ts";
import { graphNode, GRAPH_CALL_TIMEOUT_MS } from "./graph.ts";
import type { ForgePort } from "./forge.ts";
import type { OwnedCheck } from "./lock.ts";
import { laneHeldMessage, mapKey, recordImplementStart, resumeMap } from "./maps.ts";
import { spawnRunNodeDetached, type SpawnRunNodeArgs } from "./spawn.ts";

export interface ResumeContext {
 config: RangerConfig;
 configPath: string;
 journal: Journal;
 spawnRunNode?: (args: SpawnRunNodeArgs) => Promise<number | null>;
 now?: () => Date;
}

/** The same identity gate as run-node: an execution refusal, then the bot's write identity. */
async function identityGate(config: RangerConfig, map: Pick<RangerMapConfig, "repo">): Promise<void> {
 const refusal = executionRefusal(map.repo);
 if (refusal !== null) throw new WriteGateError(refusal);
 await assertWriteIdentity(config, map.repo);
}

/** A gate that could not be evaluated, as opposed to one that refused. */
const transientGate = (error: unknown) => error instanceof WriteGateError && error.transient;

const releasedError = (nodeId: string) => new Error(`node ${nodeId}'s claim was released — the walk re-claims it from the frontier`);
const missingRowError = (nodeId: string, repo: string) => new Error(`no journal row for node ${nodeId} on ${repo} — nothing to resume`);

export const queuedResumeStale = (status: WorkerStatus) => status === "released" || status === "claimed" || status === "running";
export const spawnHeld = (journal: Journal, config: RangerConfig, now: Date) =>
 journal.isPaused() || journal.spawnsToday(now) >= config.workers.spawnCapPerDay;

interface ResumeResult {
 nodeId: string;
 repo: string;
 root: number;
 was: WorkerStatus;
 pid: number | null;
}
export type ResumeOutcome = ResumeResult & (
 | { kind: "started" }
 | { kind: "queued"; queued: true }
 | { kind: "dropped"; dropped: true; reason: string }
);

/** Caller holds the claim lock. CLI and queued resumes use this same startup path. */
export async function startResumeNode(
 nodeId: string, map: RangerMapConfig, ctx: ResumeContext, owned: OwnedCheck,
 options: { force?: boolean; queued?: ResumeQueueRow } = {},
): Promise<ResumeOutcome> {
 const { journal } = ctx;
 await identityGate(ctx.config, map);
 const row = journal.getWorker(nodeId, map.repo);
 if (row === null) throw missingRowError(nodeId, map.repo);
 journal.assertWorkerRoot(nodeId, map.repo, map.root);
 const result = { nodeId, repo: map.repo, root: map.root, was: row.status, pid: null as number | null };
 if (options.queued !== undefined && queuedResumeStale(row.status)) {
  owned();
  journal.removeResume(options.queued, "resume-dropped", `worker row is ${row.status}`);
  return { ...result, kind: "dropped", dropped: true, reason: `worker row is ${row.status}` };
 }
 if (row.status === "released") throw releasedError(nodeId);
 // A live occupant keeps the node: a second run-node would race it through
 // the same worktree and PR (2026-10-07, soma #753: two generations raced the
 // close, and the loser's park was re-spawned 50 times).
 if ((row.status === "running" || row.status === "claimed") && pidAlive(row.pid)) {
  throw new Error(
   `node ${nodeId}'s run-node (pid ${row.pid}) is still ${row.status} — resume only a parked, failed or dead worker`,
  );
 }
 const lane = implementLane(map);
 const takesLane = startsImplementSession(row);
 const holder = takesLane ? journal.laneHolder(lane, { nodeId, repo: map.repo }) : null;
 const now = ctx.now?.() ?? new Date();
 if (options.queued !== undefined && (spawnHeld(journal, ctx.config, now) || holder !== null)) {
  return { ...result, kind: "queued", queued: true };
 }
 if (holder !== null && options.force !== true) throw new Error(laneHeldMessage(lane, holder, "resume", nodeId));
 owned();
 journal.updateWorker(nodeId, map.repo, { status: "claimed", pid: null, workerPgid: null, finishedAt: null });
 const restore = () => journal.updateWorker(nodeId, map.repo, {
  status: row.status, pid: row.pid, workerPgid: row.workerPgid, finishedAt: row.finishedAt,
 });
 let pid: number | null;
 const spawner = ctx.spawnRunNode ?? spawnRunNodeDetached;
 try {
  pid = await spawner({ nodeId, repo: map.repo, root: map.root,
   cliEntry: join(import.meta.dir, "cli.ts"), configPath: ctx.configPath });
 } catch (error) {
  owned();
  restore();
  throw error;
 }
 owned();
 if (options.queued !== undefined && pid === null) {
  restore();
  throw new Error("run-node spawn returned no PID");
 }
 if (pid !== null) journal.updateWorker(nodeId, map.repo, { pid });
 if (takesLane) recordImplementStart(journal, map);
 if (options.queued !== undefined) journal.recordSpawn(now);
 const entry = options.queued ?? journal.getResume(map.repo, nodeId);
 if (entry !== null) journal.removeResume(entry, "resume-started", `resume-node started; run-node pid ${pid ?? "none"}`);
 journal.recordEvent("sweep", { nodeId, repo: map.repo, detail: `resume-node by ${options.queued === undefined ? "operator" : "queue"} (was ${row.status}); run-node pid ${pid ?? "none"}` });
 return { ...result, pid, kind: "started" };
}

export async function resumeNode(nodeId: string, selector: string | undefined, ctx: ResumeContext,
 options: { force?: boolean; whenFree?: boolean; cancel?: boolean } = {}) {
 if ((options.cancel && (options.force || options.whenFree)) || (options.force && options.whenFree)) {
  throw new Error("--cancel, --when-free and --force are mutually exclusive");
 }
 return withClaimLock(ctx.journal, async owned => {
  const { journal, config } = ctx;
  if (options.cancel) {
   const entries = journal.listResumeQueue().filter(e => e.nodeId === nodeId &&
    (selector === undefined || selector === e.repo || selector === mapKey(e)));
   if (entries.length !== 1) throw new Error(`no unique queued resume for node ${nodeId}`);
   const entry = entries[0];
   await identityGate(config, entry);
   owned();
   if (!journal.removeResume(entry, "resume-cancelled", "resume-node cancelled by operator")) throw new Error(`no queued resume for node ${nodeId}`);
   return { nodeId, repo: entry.repo, root: entry.root, cancelled: true };
  }
  const map = resumeMap(config, journal.listWorkers(), nodeId, selector);
  const row = journal.getWorker(nodeId, map.repo);
  if (row === null) throw missingRowError(nodeId, map.repo);
  if (row.status === "released") throw releasedError(nodeId);
  const lane = implementLane(map);
  if (options.whenFree && startsImplementSession(row) && (
   journal.laneHolder(lane, { nodeId, repo: map.repo }) !== null ||
   journal.getResume(map.repo, nodeId) !== null ||
   journal.listResumeQueue(lane).length > 0
  )) {
   await identityGate(config, map);
   owned();
   const entry = journal.enqueueResume({ nodeId, repo: map.repo, root: map.root, lane }, ctx.now?.() ?? new Date());
   return { nodeId, repo: map.repo, root: map.root, queued: true, lane: entry.lane, queuedAt: entry.queuedAt };
  }
  return startResumeNode(nodeId, map, ctx, owned, { force: options.force });
 });
}

export interface ResumeQueueMap {
 map: RangerMapConfig;
 token?: string;
 gateReason?: string;
 /** The gate failed on a forge read, not a refusal; the entry defers without a count. */
 gateTransient?: boolean;
 errors: string[];
}

/** Caller holds the claim lease; only successful starts reserve implement capacity. */
export async function processResumeQueue(
 ctx: ResumeContext & { github: ForgePort }, maps: ResumeQueueMap[],
 reservations: Set<ImplementLane>, owned: OwnedCheck,
): Promise<void> {
 const { journal, config } = ctx;
 const waiting = new Set<ImplementLane>();
 for (const entry of journal.listResumeQueue()) {
  const state = maps.find(m => m.map.repo === entry.repo && m.map.root === entry.root);
  const map = state?.map;
  const drop = (reason: string) => {
   owned();
   journal.removeResume(entry, "resume-dropped", reason);
  };
  const defer = (reason: string, failedStart = false) => {
   owned();
   journal.recordEvent("sweep", { nodeId: entry.nodeId, repo: entry.repo,
    detail: `queued resume #${entry.nodeId} deferred: ${reason}` });
   state?.errors.push(`queued resume #${entry.nodeId}: ${reason}`);
   if (failedStart && journal.recordResumeStartFailure(entry, reason)) return;
   waiting.add(entry.lane);
  };
  if (map?.walk === "none") { drop("map is walk: none"); continue; }
  if (waiting.has(entry.lane) || reservations.has(entry.lane)) continue;
  const row = journal.getWorker(entry.nodeId, entry.repo);
  if (row !== null && queuedResumeStale(row.status)) {
   drop(`worker row is ${row.status}`);
   continue;
  }
  if (state === undefined || map === undefined || row === null || row.root !== entry.root || entry.lane !== implementLane(map)) {
   defer(map === undefined ? "map is no longer registered" : row === null ? "worker row is missing" :
    row.root !== entry.root ? "worker map root changed" : `map implement lane changed from ${entry.lane} to ${implementLane(map)}`);
   continue;
  }
  if (spawnHeld(journal, config, ctx.now?.() ?? new Date())) {
   waiting.add(entry.lane);
   continue;
  }
  if (state.token === undefined) {
   // A refusal (unmapped token, the principal's identity) is a failed start;
   // a forge read that failed or timed out is a transient read error and is not.
   defer(`start failed: ${state.gateReason ?? "identity gate unavailable"}`, state.gateTransient !== true);
   continue;
  }
  try {
   const node = await graphNode(entry.repo, entry.nodeId, { token: state.token, source: "write-token" },
    { timeoutMs: GRAPH_CALL_TIMEOUT_MS });
   if (node.status === "closed") { drop("node is closed"); continue; }
   if (row.prNumber !== null) {
    const pr = await ctx.github.getPr(entry.repo, row.prNumber, state.token);
    if (pr.state === "merged" || pr.state === "closed") {
     drop(pr.state === "merged" ? "PR is merged" : "PR is closed");
     continue;
    }
   }
  } catch (error) {
   defer(`validation failed: ${error instanceof Error ? error.message : String(error)}`);
   continue;
  }
  try {
   const resumed = await startResumeNode(entry.nodeId, map, ctx, owned, { queued: entry });
   switch (resumed.kind) {
    case "dropped": break;
    case "queued": waiting.add(entry.lane); break;
    case "started":
     waiting.add(entry.lane);
     if (startsImplementSession(row)) reservations.add(implementLane(map));
     break;
   }
  } catch (error) {
   defer(`start failed: ${error instanceof Error ? error.message : String(error)}`, !transientGate(error));
  }
 }
}
