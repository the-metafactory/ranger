import { recordImplementStart, mapKey } from "./maps.ts";
import { executionRefusal } from "./forge-ref.ts";
import { implementLane, startsImplementSession, type ImplementLane } from "./lanes.ts";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import type { Journal } from "./journal.ts";
import { killProcessGroup, pidAlive, processGroupCommands } from "./exec.ts";
import { graphRelease } from "./graph-write.ts";
import type { ForgePort } from "./forge.ts";
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
 /**
  * Called to (re)spawn a detached run-node: a crashed worker's respawn, and
  * the merge desk's resume-for-close. Returns the new supervisor's PID, or
  * null when nothing spawned (spawn cap, no hook) — the claim stays and the
  * next tick's sweep retries.
  */
 respawn?: (nodeId: string, repo: string, root: number) => Promise<number | null>;
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
 const refusal = executionRefusal(repo);
 if (refusal !== null) throw new Error(refusal);
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
  // No observed PID = no supervisor yet (freshly claimed, spawn pending, or
  // the no-spawn seam). There is nothing to be dead; leave it for the next
  // tick. Only a row that HAD a supervisor is a crash candidate.
  if (worker.pid === null) continue;
  if (pidAlive(worker.pid)) continue; // genuinely in-flight
  result.crashed += 1;
  journal.recordEvent("sweep", {
   nodeId: worker.nodeId,
   repo,
   detail: `crashed worker (pid ${worker.pid ?? "?"}) with no outcome — attempt ${worker.attempts}/${config.workers.maxAttempts}`,
  });

  // The supervisor is dead, but its worker session may not be: a group the
  // dead supervisor started is reparented and keeps running in the worktree.
  // Kill it before a new occupant adopts the worktree (#23 F1) — but only
  // when a live member still names this node's worktree, never on the
  // journal's recorded group id alone (group ids are recycled).
  if (worker.workerPgid !== null && worker.worktree !== null) {
   const commands = await processGroupCommands(worker.workerPgid);
   const ours = commands.some((c) => c.includes(worker.worktree as string));
   if (ours && killProcessGroup(worker.workerPgid)) {
    result.orphansKilled.push(worker.nodeId);
    journal.recordEvent("orphan-killed", {
     nodeId: worker.nodeId,
     repo,
     detail: `killed orphaned worker group ${worker.workerPgid} (${commands.length} process(es)) in ${worker.worktree}`,
    });
   }
   journal.updateWorker(worker.nodeId, repo, { workerPgid: null });
  }

  if (worker.attempts < config.workers.maxAttempts) {
   if (startsImplementSession(worker)) {
    if (ctx.reservedLanes?.has(implementLane(map))) continue;
    const holder = journal.laneHolder(implementLane(map), { nodeId: worker.nodeId, repo },
     row => row.pid === null || pidAlive(row.pid));
    if (holder !== null) {
     journal.recordEvent("sweep", { nodeId: worker.nodeId, repo,
      detail: `respawn waits for the ${implementLane(map)} implement lane (held by #${holder.nodeId}, ${mapKey(holder)})` });
     continue;
    }
   }
   const attempt = worker.attempts + 1;
   journal.updateWorker(worker.nodeId, repo, {
    status: "claimed",
    attempts: attempt,
    pid: null,
   });
   const pid = ctx.respawn === undefined ? null : await ctx.respawn(worker.nodeId, repo, worker.root);
   if (pid !== null) {
    journal.updateWorker(worker.nodeId, repo, { pid });
    if (startsImplementSession(worker)) recordImplementStart(journal, map);
    result.respawned.push(worker.nodeId);
    journal.recordEvent("sweep", { nodeId: worker.nodeId, repo, detail: respawnedEvent(attempt) });
   } else {
    journal.recordEvent("sweep", {
     nodeId: worker.nodeId,
     repo,
     detail: `respawn refused (spawn cap or no respawn hook) — claim kept for the next tick`,
    });
   }
  } else {
   result.parked.push(worker.nodeId);
   journal.recordEvent("parked", {
    nodeId: worker.nodeId,
    repo,
    detail: `crashed ${config.workers.maxAttempts} times — parking; releasing the claim`,
   });
   const released = await graphRelease(repo, worker.nodeId, botIdentity, token);
   journal.upsertWorker({
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
  const credential = { token, source: "write-token" };
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
