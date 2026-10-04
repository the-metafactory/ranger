import { recordImplementStart, mapKey } from "./maps.ts";
import { implementLane } from "./lanes.ts";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import type { Journal } from "./journal.ts";
import { killProcessGroup, pidAlive, processGroupCommands } from "./exec.ts";
import { graphRelease } from "./graph-write.ts";
import type { GitHubPort } from "./implement.ts";
import {
 runMergeDesk,
 watchedByMergeDesk,
 type MergeDeskResult,
} from "./merge-desk.ts";

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
 github?: GitHubPort;
 post?: (content: string, label: string) => Promise<string>;
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

 const inFlight = journal.listWorkers(repo, map.root).filter(
  (w) => w.status === "claimed" || w.status === "running",
 );

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
   if (worker.lane === "implement" && worker.phase !== "close") {
    const holder = journal.laneHolder(implementLane(map), { nodeId: worker.nodeId, repo });
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
    if (worker.lane === "implement" && worker.phase !== "close") recordImplementStart(journal, map);
    result.respawned.push(worker.nodeId);
    journal.recordEvent("sweep", { nodeId: worker.nodeId, repo, detail: `respawned (attempt ${attempt})` });
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
    outcome: `parked after ${config.workers.maxAttempts} crash(es); release ${released.released ? "ok" : `refused: ${released.assignees.join(",") || "unclaimed"}`}`,
   });
   if (released.released) {
    result.released.push(worker.nodeId);
    journal.recordEvent("released", { nodeId: worker.nodeId, repo, detail: "claim released after park" });
   }
  }
 }

 // Implement-lane rows waiting on (or parked before) the principal's merge (#23).
 if (journal.listWorkers(repo, map.root).some(watchedByMergeDesk)) {
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
