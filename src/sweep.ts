import { startOwnedWorker, reservationPending, startFailureOutcome } from "./node-ownership.ts";
import { recordImplementStart, mapKey } from "./maps.ts";
import { implementLane, startsImplementSession, type ImplementLane } from "./lanes.ts";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import type { Journal } from "./journal.ts";
import { killProcessGroup, pidAlive, processGroupCommands } from "./exec.ts";
import { graphRelease } from "./graph-write.ts";
import type { ForgePort } from "./forge.ts";
import type { ResolvedToken } from "./token-gate.ts";
import {
 runMergeDesk,
 watchedByMergeDesk,
 type MergeDeskResult,
} from "./merge-desk.ts";
import { crashParkOutcome, respawnedEvent } from "./outcomes.ts";
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
   : journal.listWorkers(repo, map.root).filter((w) => w.status === "claimed" || w.status === "running");

 for (const worker of inFlight) {
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
  if (worker.pid === null) {
   const detail = `abandoned worker reservation without a supervisor PID; resume node ${worker.nodeId} to retry`;
   scoped.updateWorker(worker.nodeId, repo, {
    status: "parked", outcome: startFailureOutcome(worker.outcome, detail, true), finishedAt: new Date().toISOString(),
   });
   result.parked.push(worker.nodeId);
   journal.recordEvent("parked", { nodeId: worker.nodeId, repo, detail });
   continue;
  }
  result.crashed += 1;
  journal.recordEvent("sweep", { nodeId: worker.nodeId, repo,
   detail: `crashed worker (pid ${worker.pid}) with no outcome — attempt ${worker.attempts}/${config.workers.maxAttempts}` });
  if (worker.attempts < config.workers.maxAttempts) {
   const holder = startsImplementSession(worker) ? journal.laneHolder(implementLane(map), { nodeId: worker.nodeId, repo },
    row => row.pid === null || pidAlive(row.pid)) : null;
   const reservedLane = startsImplementSession(worker) && ctx.reservedLanes?.has(implementLane(map));
   if (holder !== null || reservedLane) {
    scoped.updateWorker(worker.nodeId, repo, { status: worker.status, pid: worker.pid, startedAt: worker.startedAt });
    journal.recordEvent("sweep", { nodeId: worker.nodeId, repo,
     detail: `respawn waits for the ${implementLane(map)} implement lane${holder === null ? " reserved by priority work" : ` (held by #${holder.nodeId}, ${mapKey(holder)})`}` });
    continue;
   }
   const attempt = worker.attempts + 1;
   scoped.updateWorker(worker.nodeId, repo, { attempts: attempt });
   const pid = await startOwnedWorker({ journal, row: worker, generation,
    spawn: generation => ctx.respawn === undefined ? Promise.resolve(null) : ctx.respawn(worker.nodeId, repo, worker.root, generation),
   });
   if (pid !== null) {
    if (startsImplementSession(worker)) recordImplementStart(journal, map);
    result.respawned.push(worker.nodeId);
    journal.recordEvent("sweep", { nodeId: worker.nodeId, repo, detail: respawnedEvent(attempt) });
   } else {
    journal.recordEvent("sweep", { nodeId: worker.nodeId, repo,
     detail: "respawn did not start; parked for operator resume with its crash-attempt budget preserved" });
   }
  } else {
   result.parked.push(worker.nodeId);
   journal.recordEvent("parked", {
    nodeId: worker.nodeId,
    repo,
    detail: `crashed ${config.workers.maxAttempts} times — parking; releasing the claim`,
   });
   scoped.assertGeneration(worker.nodeId, repo, generation, "release crashed worker claim");
   const released = await graphRelease(repo, worker.nodeId, botIdentity, token);
   scoped.upsertWorker({
    nodeId: worker.nodeId,
    repo,
    root: worker.root,
    status: released.released ? "released" : "parked",
    attempts: worker.attempts,
    finishedAt: new Date().toISOString(),
    outcome: crashParkOutcome({ attempts: config.workers.maxAttempts, released: released.released, assignees: released.assignees }),
   });
   if (released.released) {
    result.released.push(worker.nodeId);
    journal.recordEvent("released", { nodeId: worker.nodeId, repo, detail: "claim released after park" });
   }
  }
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
