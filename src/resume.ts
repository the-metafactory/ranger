import { join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { withClaimLock } from "./claim-lock.ts";
import { executionRefusal } from "./forge-ref.ts";
import { changeRequestNoun } from "./forge-text.ts";
import { pidAlive } from "./exec.ts";
import { assertWriteIdentity, WriteGateError } from "./identity.ts";
import type { Journal, ResumeQueueRow, WorkerRow, WorkerStatus } from "./journal.ts";
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

/**
 * Pass 1c's spawn gates for a queue head, in the walk's order: the dead-man
 * pause, a holder of the entry's lane, the spent daily spawn cap. Why the
 * head waits, or null when it may start. `ranger serve` reads its "next"
 * head through this same gate (node #166).
 */
export function queueSpawnGate(g: {
 paused: boolean;
 lane: ImplementLane;
 holder: { nodeId: string; repo: string } | null;
 spawns: number;
 cap: number;
}): string | null {
 if (g.paused) return "dead-man paused: queued resumes wait for `ranger resume-run`";
 if (g.holder !== null) return `waits for the ${g.lane} lane, held by #${g.holder.nodeId} (${g.holder.repo})`;
 if (g.spawns >= g.cap) return `waits: the daily spawn cap (${g.cap}) is spent`;
 return null;
}

/** The journal's spawn gates for a queued start; the lane holder, when it matters, is the caller's. */
const spawnGate = (journal: Journal, config: RangerConfig, now: Date, lane: ImplementLane,
 holder: { nodeId: string; repo: string } | null = null) =>
 queueSpawnGate({ paused: journal.isPaused(), lane, holder, spawns: journal.spawnsToday(now), cap: config.workers.spawnCapPerDay });

/**
 * Whether `resume-node --when-free` queues the row rather than starting it:
 * an implement session, and its lane held, the node already queued, or a
 * queue already waiting in that lane. `ranger serve` offers its "Queue
 * resume" by this same rule (node #166).
 */
export const whenFreeQueues = (row: Pick<WorkerRow, "lane" | "phase">,
 lane: { held: boolean; queued: boolean; backlog: number }) =>
 startsImplementSession(row) && (lane.held || lane.queued || lane.backlog > 0);

/**
 * The resume queue's journal-only gate for one entry, ahead of the spawn
 * gates and any forge read: what Pass 1c does with it, and what `ranger
 * serve` shows (node #166). `drop` leaves the queue and holds nothing;
 * `defer` stays and holds its lane's queue behind it; `behind` waits for an
 * earlier entry or a claim already holding the lane this tick. Null passes
 * the entry on to the spawn gates (pause, spawn cap, lane holder).
 */
export type QueueEntryGate = { kind: "drop" | "defer"; reason: string } | { kind: "behind" } | null;
export function queueEntryGate(
 entry: Pick<ResumeQueueRow, "root" | "lane">,
 map: { walk: RangerMapConfig["walk"]; lane: ImplementLane } | undefined,
 row: Pick<WorkerRow, "status" | "root"> | null,
 laneWaiting: boolean,
): QueueEntryGate {
 if (map?.walk === "none") return { kind: "drop", reason: "map is walk: none" };
 if (laneWaiting) return { kind: "behind" };
 if (row !== null && queuedResumeStale(row.status)) return { kind: "drop", reason: `worker row is ${row.status}` };
 if (map === undefined) return { kind: "defer", reason: "map is no longer registered" };
 if (row === null) return { kind: "defer", reason: "worker row is missing" };
 if (row.root !== entry.root) return { kind: "defer", reason: "worker map root changed" };
 if (entry.lane !== map.lane) return { kind: "defer", reason: `map implement lane changed from ${entry.lane} to ${map.lane}` };
 return null;
}

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
 if (options.queued !== undefined && spawnGate(journal, ctx.config, now, lane, holder) !== null) {
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
  if (options.whenFree && whenFreeQueues(row, {
   held: journal.laneHolder(lane, { nodeId, repo: map.repo }) !== null,
   queued: journal.getResume(map.repo, nodeId) !== null,
   backlog: journal.listResumeQueue(lane).length,
  })) {
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
  const row = journal.getWorker(entry.nodeId, entry.repo);
  const gate = queueEntryGate(entry, map === undefined ? undefined : { walk: map.walk, lane: implementLane(map) }, row,
   waiting.has(entry.lane) || reservations.has(entry.lane));
  if (gate?.kind === "behind") continue;
  if (gate?.kind === "drop") { drop(gate.reason); continue; }
  if (gate?.kind === "defer") { defer(gate.reason); continue; }
  // The gate passes only with a registered map and its row; should it ever
  // not, the entry still defers and holds its lane, never skips silently.
  if (state === undefined || map === undefined || row === null) {
   defer(state === undefined ? "map state is unavailable" : "map or worker row is unavailable");
   continue;
  }
  // The lane holder is read at the start itself (startResumeNode), after the
  // forge checks, so a held lane still drops a closed node or merged PR.
  if (spawnGate(journal, config, ctx.now?.() ?? new Date(), entry.lane) !== null) {
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
     drop(`${changeRequestNoun(entry.repo)} is ${pr.state === "merged" ? "merged" : "closed"}`);
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
