import type { RangerConfig, RangerMapConfig } from "./config.ts";
import type { Journal } from "./journal.ts";
import { graphRelease } from "./graph-write.ts";

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
  * Called to respawn a crashed worker. Return false when the spawn cap is
  * exhausted (the claim stays, and the next tick's sweep retries).
  */
 respawn?: (nodeId: string, repo: string) => Promise<boolean>;
}

export interface SweepMapResult {
 repo: string;
 crashed: number;
 respawned: string[];
 parked: string[];
 released: string[];
 paused: boolean;
 deadmanCount: number;
}

/** Is a PID alive on this host? `kill(pid, 0)` is a pure liveness probe. */
export function pidAlive(pid: number | null): boolean {
 if (pid === null || pid <= 0) return false;
 try {
  process.kill(pid, 0);
  return true;
 } catch {
  return false;
 }
}

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
 };

 const inFlight = journal.listWorkers(repo).filter(
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

  if (worker.attempts < config.workers.maxAttempts) {
   const attempt = worker.attempts + 1;
   journal.upsertWorker({
    nodeId: worker.nodeId,
    repo,
    status: "claimed",
    attempts: attempt,
   });
   const launched = ctx.respawn === undefined ? false : await ctx.respawn(worker.nodeId, repo);
   if (launched) {
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

 return result;
}
