import { hasMergeConflict } from "./forge.ts";
import { conflictResume } from "./resume-priority.ts";
import { quietHostGate, queuedResumeStale, queueSpawnGate, whenFreeQueues, queueEntryGate } from "./resume-gates.ts";
export { quietHostGate, queuedResumeStale, queueSpawnGate, whenFreeQueues, queueEntryGate, type QueueEntryGate } from "./resume-gates.ts";
import { resolveNodeSelector, workerPreflight, type DispatchDeps } from "./node-dependency.ts";
import { OperationFailure } from "./operation-outcome.ts";
import { reviewThrottle } from "./budget.ts";
import { WRITE_TOKEN_SOURCE } from "./github-usage.ts";
import { activeRecovery, nodeRecoveryScope, recoveryHold, resetRecovery } from "./recovery.ts";
import { startOwnedWorker, reservationPending } from "./node-ownership.ts";
import { join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { withClaimLock } from "./claim-lock.ts";
import { laneCredentialRefusal } from "./forge-lanes.ts";
import { changeRequestNoun } from "./forge-text.ts";
import { pidAlive } from "./exec.ts";
import { assertWriteIdentity, WriteGateError } from "./identity.ts";
import type { Journal, ResumeQueueRow, WorkerStatus } from "./journal.ts";
import { implementLane, startsImplementSession, type ImplementLane } from "./lanes.ts";
import { graphNode, GRAPH_CALL_TIMEOUT_MS } from "./graph.ts";
import type { ForgePort } from "./forge.ts";
import type { ResolvedToken } from "./token-gate.ts";
import type { OwnedCheck } from "./lock.ts";
import { laneHeldMessage, mapKey, recordImplementStart, resumeMap } from "./maps.ts";
import { spawnRunNodeDetached, type SpawnRunNodeArgs } from "./spawn.ts";
import { busyLoadFor, hostBusy, realHostLoad, type HostLoad, type HostLoadReading } from "./host-load.ts";
import { unchangedHeadPark } from "./worktree-head.ts";

export interface ResumeContext extends DispatchDeps {
 config: RangerConfig;
 configPath: string;
 journal: Journal;
 spawnRunNode?: (args: SpawnRunNodeArgs) => Promise<number | null>;
 now?: () => Date;
 /** The host load queued resumes wait on (node #297); tests inject a quiet or busy host. */
 hostLoad?: HostLoad;
}

/** The same identity gate as run-node: the forge credential refusal, then the bot's write identity. */
async function identityGate(config: RangerConfig, map: Pick<RangerMapConfig, "repo">): Promise<void> {
 const refusal = laneCredentialRefusal(config, map.repo);
 if (refusal !== null) throw new WriteGateError(refusal);
 await assertWriteIdentity(config, map.repo);
}

/** A gate that could not be evaluated, as opposed to one that refused. */
const transientGate = (error: unknown) => error instanceof WriteGateError && error.transient;

const releasedError = (nodeId: string) => new Error(`node ${nodeId}'s claim was released — the walk re-claims it from the frontier`);
const missingRowError = (nodeId: string, repo: string) => new Error(`no journal row for node ${nodeId} on ${repo} — nothing to resume`);

/** The journal's spawn gates for a queued start; the lane holder, when it matters, is the caller's. */
const spawnGate = (journal: Journal, config: RangerConfig, now: Date, lane: ImplementLane,
 holder: { nodeId: string; repo: string } | null = null) =>
 queueSpawnGate({ paused: journal.isPaused(), lane, holder, spawns: journal.spawnsToday(now), cap: config.workers.spawnCapPerDay });

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
 options: { force?: boolean; queued?: ResumeQueueRow; resetRecovery?: boolean } = {},
): Promise<ResumeOutcome> {
 const { journal } = ctx;
 await identityGate(ctx.config, map);
 if (options.resetRecovery) resetRecovery(journal, nodeRecoveryScope(map.repo, nodeId));
 const held = recoveryHold(journal, nodeRecoveryScope(map.repo, nodeId), ctx.now?.() ?? new Date());
 if (held !== null) throw new Error(`${held}; use resume-node --reset-recovery after intervention`);
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
 // A proposed node waits for the principal's ratification (node #246); a
 // resumed run would post a second proposal.
 if (row.status === "proposed") {
  throw new Error(`node ${nodeId} is proposed (comment ${row.proposalCommentId ?? "id unknown"}) — it waits for the principal's 👍, not a resume`);
 }
 // A live occupant keeps the node: a second run-node would race it through
 // the same worktree and PR (2026-10-07, soma #753: two generations raced the
 // close, and the loser's park was re-spawned 50 times).
 if ((row.status === "running" || row.status === "claimed") && (pidAlive(row.pid) || reservationPending(row, ctx.now?.() ?? new Date()))) {
  throw new Error(
   `node ${nodeId}'s run-node (pid ${row.pid}) is still ${row.status} — resume only a parked, failed or dead worker`,
  );
 }
 if (row.status === "stop-requested" && (row.pid !== null || row.workerPgid !== null)) {
  throw new Error(
   `node ${nodeId}'s stop is not settled (supervisor pid ${row.pid ?? "none"}, worker group ${row.workerPgid ?? "none"}) — replay \`ranger stop-node ${nodeId} --map ${mapKey(map)} --generation ${row.generation}\` until it reports stopped`,
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
 const spawner = ctx.spawnRunNode ?? spawnRunNodeDetached;
 let spawnError: Error | undefined;
 const pid = await startOwnedWorker({ journal, row, now,
  ...(options.queued !== undefined && conflictResume(options.queued) ? { status: "running" as const, patch: { phase: "review" as const, outcome: null, mergeMessageId: null } } : {}),
  preflight: () => workerPreflight(row, map, { ...ctx, nodeSelector: resolveNodeSelector(ctx) }),
  onSpawnFailure: error => { spawnError = error; },
  spawn: generation => spawner({ nodeId, repo: map.repo, root: map.root, generation,
   cliEntry: join(import.meta.dir, "cli.ts"), configPath: ctx.configPath }),
 });
 owned();
 if (pid === null) {
  const recovery = activeRecovery(journal, nodeRecoveryScope(map.repo, nodeId));
  if (recovery !== null && recovery.status !== "complete") throw new OperationFailure({ kind: recovery.kind, operation: recovery.operation, target: recovery.target, evidence: recovery.evidence, action: recovery.action });
  throw spawnError ?? new Error("run-node spawn returned no PID or ownership was taken");
 }
 if (takesLane) recordImplementStart(journal, map);
 if (options.queued !== undefined) journal.recordSpawn(now);
 const entry = options.queued ?? journal.getResume(map.repo, nodeId);
 if (entry !== null) journal.removeResume(entry, "resume-started", `resume-node started; run-node pid ${pid}`);
 journal.recordEvent("sweep", { nodeId, repo: map.repo, detail: `resume-node by ${options.queued === undefined ? "operator" : "queue"} (was ${row.status}); run-node pid ${pid}` });
 return { ...result, pid, kind: "started" };
}

export async function resumeNode(nodeId: string, selector: string | undefined, ctx: ResumeContext,
 options: { force?: boolean; whenFree?: boolean; cancel?: boolean; resetRecovery?: boolean } = {}) {
 if ((options.cancel && (options.force || options.whenFree || options.resetRecovery)) || (options.force && options.whenFree)) {
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
   busy: hostBusy(ctx.hostLoad, busyLoadFor(config.workers, lane)) !== null,
  })) {
   await identityGate(config, map);
   owned();
   if (options.resetRecovery) resetRecovery(journal, nodeRecoveryScope(map.repo, nodeId), { owner: { nodeId, repo: map.repo, generation: row.generation } });
   const entry = journal.enqueueResume({ nodeId, repo: map.repo, root: map.root, lane }, ctx.now?.() ?? new Date());
   return { nodeId, repo: map.repo, root: map.root, queued: true, lane: entry.lane, queuedAt: entry.queuedAt };
  }
  return startResumeNode(nodeId, map, ctx, owned, { force: options.force, resetRecovery: options.resetRecovery });
 });
}

export interface ResumeQueueMap {
 botIdentity?: string;
 map: RangerMapConfig;
 token?: string;
 /** The credential graph reads run under (`graphReadToken`); the write token when unset. */
 graphToken?: ResolvedToken;
 gateReason?: string;
 /** The gate failed on a forge read, not a refusal; the entry defers without a count. */
 gateTransient?: boolean;
 errors: string[];
}

/** Caller holds the claim lease; only successful starts reserve implement capacity. */
export async function processResumeQueue(
 ctx: ResumeContext & { github: Pick<ForgePort, "getPr"> }, maps: ResumeQueueMap[],
 reservations: Set<ImplementLane>, owned: OwnedCheck, conflictsOnly = false,
): Promise<ResumeOutcome[]> {
 const started: ResumeOutcome[] = [];
 const { journal, config } = ctx;
 const waiting = new Set<ImplementLane>();
 // One reading per tick, taken only when an entry reaches its host gate.
 let host: HostLoadReading | undefined;
 const readHost = () => (host ??= (ctx.hostLoad ?? realHostLoad)());
 for (const entry of journal.listResumeQueue().filter(e => conflictsOnly === (conflictResume(e)))) {
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
   if (failedStart) state?.errors.push(`queued resume #${entry.nodeId}: ${reason}`);
   if (failedStart && journal.recordResumeStartFailure(entry, reason)) return;
   if (!conflictResume(entry)) waiting.add(entry.lane);
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
  const recoveryWait = recoveryHold(journal, nodeRecoveryScope(entry.repo, entry.nodeId), ctx.now?.() ?? new Date());
  if (recoveryWait !== null) {
   journal.recordEvent("sweep", { nodeId: entry.nodeId, repo: entry.repo, detail: `queued recovery deferred: ${recoveryWait}` });
   continue;
  }
  const cooling = reviewThrottle(journal, config, entry.repo, ctx.now?.() ?? new Date());
  if (cooling !== null) {
   journal.recordEvent("sweep", { nodeId: entry.nodeId, repo: entry.repo, detail: `queued resume #${entry.nodeId} waits until ${cooling.until.toISOString()}: ${cooling.reason}` });
   continue;
  }
  // The lane holder is read at the start itself (startResumeNode), after the
  // forge checks, so a held lane still drops a closed node or merged PR.
  const spawnRefusal = spawnGate(journal, config, ctx.now?.() ?? new Date(), entry.lane);
  if (spawnRefusal !== null) {
   defer(spawnRefusal);
   continue;
  }
  // A queued resume waits for a quiet host: not a failed start, and it holds
  // nothing behind it, on its lane or the other. One event per entry per
  // tick says why it waits, at the entry's lane's busy load (node #312).
  const busy = quietHostGate(readHost(), busyLoadFor(config.workers, entry.lane));
  if (busy !== null) {
   owned();
   journal.recordEvent("reviewed", { nodeId: entry.nodeId, repo: entry.repo, detail: `queued resume #${entry.nodeId} is ${busy}` });
   continue;
  }
  if (state.token === undefined) {
   // A refusal (unmapped token, the principal's identity) is a failed start;
   // a forge read that failed or timed out is a transient read error and is not.
   defer(`start failed: ${state.gateReason ?? "identity gate unavailable"}`, state.gateTransient !== true);
   continue;
  }
  try {
   const node = await graphNode(entry.repo, entry.nodeId, state.graphToken ?? { token: state.token, source: WRITE_TOKEN_SOURCE },
    { timeoutMs: GRAPH_CALL_TIMEOUT_MS });
   if (node.status === "closed") { drop("node is closed"); continue; }
   if (conflictResume(entry)) {
    const reason = node.blockedBy.some(b => b.status !== "closed") ? "node has an open blocker"
     : node.assignees.some(a => a.toLowerCase() !== state.botIdentity?.toLowerCase()) ? "node has another active claim"
     : map.walk !== "full" ? "conflict repair requires walk: full"
     : map.skip.includes(entry.nodeId) || (map.nodes !== undefined && !map.nodes.includes(entry.nodeId)) ? "node is excluded by map policy"
     : journal.hasVeto(entry.nodeId, entry.repo) ? "node is vetoed" : null;
    if (reason !== null) { defer(reason); continue; }
   }
   if (row.prNumber !== null) {
    const pr = await ctx.github.getPr(entry.repo, row.prNumber, state.token);
    if (pr.state === "merged" || pr.state === "closed") {
     drop(`${changeRequestNoun(entry.repo)} is ${pr.state === "merged" ? "merged" : "closed"}`);
     continue;
    }
    if (conflictResume(entry) && !hasMergeConflict(pr)) {
     if (entry.reason === "merge-conflict-host-load") journal.setResumeReason(entry, "host-load");
     else if (entry.reason === "merge-conflict-resume") journal.setResumeReason(entry, null);
     else drop("PR no longer conflicts");
     continue;
    }
    if (await unchangedHeadPark(row, pr.headSha, journal)) {
     owned();
     journal.recordEvent("sweep", { nodeId: entry.nodeId, repo: entry.repo,
      detail: `queued resume #${entry.nodeId} waits: the worktree and PR head are unchanged since the head reconciliation park` });
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
    case "queued":
     defer(journal.laneHolder(entry.lane) === null ? "spawn gate changed before dispatch" : "implement lane is occupied");
     break;
    case "started":
     started.push(resumed);
     waiting.add(entry.lane);
     if (startsImplementSession(row)) reservations.add(implementLane(map));
     break;
   }
  } catch (error) {
   defer(`start failed: ${error instanceof Error ? error.message : String(error)}`, !(error instanceof OperationFailure && ["infrastructure", "dependency"].includes(error.outcome.kind)) && !transientGate(error));
  }
 }
 return started;
}
