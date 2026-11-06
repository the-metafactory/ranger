import { requireReachable, type EndpointProbe } from "./endpoint.ts";
import { RECOVERY_LIMIT, nodeRecoveryScope, recordRecovery, recoveryReason, recoveryHold, recoverablePending } from "./recovery.ts";
import { startOwnedWorker, reservationPending, FRESH_START_FAILURE } from "./node-ownership.ts";
import { recordImplementStart } from "./maps.ts";
import { implementLane, startsImplementSession, type ImplementLane } from "./lanes.ts";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import type { Journal } from "./journal.ts";
import { killProcessGroup, pidAlive, processGroupCommands } from "./exec.ts";
import type { ForgePort } from "./forge.ts";
import type { ResolvedToken } from "./token-gate.ts";
import {
 runMergeDesk,
 watchedByMergeDesk,
 type MergeDeskResult,
} from "./merge-desk.ts";
import { graphNode, GRAPH_CALL_TIMEOUT_MS } from "./graph.ts";
import { reconcileGraphClosures } from "./closure-sweep.ts";
import { BudgetDeferral, budgetedRead, budgetPolicy } from "./budget.ts";

/**
 * Sweep (design §7) — reconcile the journal against reality, crash = no-op.
 *
 * A crashed worker: PID dead, no outcome row. The claim survives (assignment is
 * on the tracker); the respawned worker must adopt, not duplicate. Attempt <
 * max → respawn; attempt ≥ max → park + release the claim so the node returns
 * to the frontier for a fresh session. The dead-man counter is maintained by
 * the worker; sweep only reports pause state.
 */

export interface SweepContext {
 endpointProbe?: EndpointProbe;
 now?: () => Date;
 config: RangerConfig;
 journal: Journal;
 map: RangerMapConfig;
 token: string;
 botIdentity: string;
 /** The credential graph reads run under (`graphReadToken`); the write token when unset. */
 graphToken?: ResolvedToken;
 respawn?: (nodeId: string, repo: string, root: number, generation: number) => Promise<number | null>;
 /** Merge-desk seams (tests): the forge and the Discord post. */
 github?: ForgePort;
 /**
  * Which half to run (default both): `liveness` reconciles crashed workers
  * (respawn, park, release); `desk` runs only the merge desk. The tick runs
  * every map's liveness before any map's desk, so a send-back sees the lanes
  * that crashed holders released on any map.
  */
 phase?: "all" | "liveness" | "desk";
 /** Parked probe retries reserve capacity before any crashed implement respawn. */
 reservedLanes?: ReadonlySet<ImplementLane>;
 post?: import("./merge-desk.ts").MergeDeskContext["post"];
}

export interface SweepMapResult {
 repo: string;
 crashed: number;
 respawned: string[];
 parked: string[];
 released: string[];
 paused: boolean;
 deadmanCount: number;
 orphansKilled: string[];
 mergeDesk?: MergeDeskResult;
}

// `pidAlive` moved to exec.ts so `ranger serve` (#37) can read liveness
// without importing this module's graph writes; re-exported where it was.
export { pidAlive };

export async function sweepMap(ctx: SweepContext): Promise<SweepMapResult> {
 const { config, journal, map, token, botIdentity } = ctx;
 const repo = map.repo;
 const result: SweepMapResult = {
  repo,
  crashed: 0,
  respawned: [],
  parked: [],
  released: [],
  paused: journal.isPaused(),
  deadmanCount: journal.deadmanCount(),
  orphansKilled: [],
 };

 const phase = ctx.phase ?? "all";
 const inFlight =
  phase === "desk"
   ? []
   : journal.listWorkers(repo, map.root).filter((w) => w.status === "claimed" || w.status === "running" || (w.status === "parked" && recoverablePending(journal, nodeRecoveryScope(repo, w.nodeId))));

 for (const worker of inFlight) {
  if (worker.status === "parked") {
   const held = recoveryHold(journal, nodeRecoveryScope(repo, worker.nodeId), ctx.now?.() ?? new Date());
   if (held !== null || journal.spawnsToday(ctx.now?.() ?? new Date()) >= config.workers.spawnCapPerDay) continue;
   const holder = startsImplementSession(worker) ? journal.laneHolder(implementLane(map), { nodeId: worker.nodeId, repo }) : null;
   if (holder !== null || (startsImplementSession(worker) && ctx.reservedLanes?.has(implementLane(map)))) continue;
   const pid = await startOwnedWorker({ journal, row: worker, now: ctx.now?.(),
    preflight: worker.phase === "close" ? undefined : () => requireReachable(map.reachable, ctx.endpointProbe),
    spawn: generation => ctx.respawn?.(worker.nodeId, repo, worker.root, generation) ?? Promise.resolve(null) });
   if (pid !== null) {
    result.respawned.push(worker.nodeId);
    journal.recordSpawn(ctx.now?.() ?? new Date());
    if (startsImplementSession(worker)) recordImplementStart(journal, map);
   }
   continue;
  }
  if (worker.pid === null && reservationPending(worker)) continue;
  if (worker.pid !== null && pidAlive(worker.pid)) continue;
  const generation = journal.reserveWorker(worker);
  if (generation === null) continue;
  const scoped = journal.forWorker(worker.nodeId, repo, generation);
  if (worker.workerPgid !== null && worker.worktree !== null) {
   const commands = await processGroupCommands(worker.workerPgid);
   scoped.assertGeneration(worker.nodeId, repo, generation, "reconcile orphan worker");
   const ours = commands.some(command => command.includes(worker.worktree as string));
   if (ours && killProcessGroup(worker.workerPgid)) {
    result.orphansKilled.push(worker.nodeId);
    journal.recordEvent("orphan-killed", { nodeId: worker.nodeId, repo,
     detail: `killed orphaned worker group ${worker.workerPgid} (${commands.length} process(es)) in ${worker.worktree}` });
   }
  }
  scoped.updateWorker(worker.nodeId, repo, { workerPgid: null });
  if (worker.pid !== null) result.crashed += 1;
  const state = recordRecovery(scoped, nodeRecoveryScope(repo, worker.nodeId), {
   kind: "infrastructure", operation: "worker-supervisor", target: worker.nodeId,
   evidence: [worker.pid === null ? "abandoned worker reservation without a supervisor PID" : `worker supervisor ${worker.pid} died without an outcome`, worker.outcome].filter(Boolean).join("; previous outcome: "),
   action: `inspect the worker log and restore supervision; resume-node ${worker.nodeId} --map ${repo}#${worker.root} --reset-recovery after intervention`,
  }, ctx.now?.() ?? new Date(), undefined, Math.min(RECOVERY_LIMIT, config.workers.maxAttempts + 1));
  const detail = recoveryReason(state);
  scoped.updateWorker(worker.nodeId, repo, { status: "parked", pid: null, workerPgid: null,
   outcome: worker.pid === null ? `${detail}\n${FRESH_START_FAILURE}abandoned reservation` : detail, finishedAt: (ctx.now?.() ?? new Date()).toISOString() });
  result.parked.push(worker.nodeId);
  journal.recordEvent("parked", { nodeId: worker.nodeId, repo, detail });
 }

 // Worker and card closure scans share a deadline after crash handling.
 // Each scan also has a fixed row cap to bound its graph reads.
 if (phase !== "desk") {
  const deadline = Date.now() + GRAPH_CALL_TIMEOUT_MS;
  const credential = ctx.graphToken ?? { token, source: "write-token" };
  const readNode = async (id: string) => {
   if (Date.now() >= deadline) throw new BudgetDeferral("graph closure pass deadline reached");
   return budgetedRead(journal, repo, credential, budgetPolicy(config), new Date(), () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BudgetDeferral("graph closure pass deadline reached");
    return graphNode(repo, id, credential, { timeoutMs: remaining });
   });
  };
  await reconcileGraphClosures(ctx, readNode, result);
 }

 // Implement-lane rows waiting on (or parked before) the principal's merge (#23).
 if (phase !== "liveness" && journal.listWorkers(repo, map.root).some(watchedByMergeDesk)) {
  result.mergeDesk = await runMergeDesk({
   config,
   journal,
   map,
   token,
   botIdentity,
   github: ctx.github,
   post: ctx.post,
   spawn: ctx.respawn,
  });
 }

 return result;
}
