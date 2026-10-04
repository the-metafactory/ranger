import { join } from "node:path";
import { ClaimLeaseLost, ClaimLockBusy, withClaimLock } from "./claim-lock.ts";
import type { RangerMapConfig } from "./config.ts";
import type { Journal, WorkerRow } from "./journal.ts";
import { implementLane, startsImplementSession } from "./lanes.ts";
import { laneHeldMessage, recordImplementStart } from "./maps.ts";
import { spawnRunNodeDetached, type SpawnRunNodeArgs } from "./walk.ts";

/**
 * `ranger resume-node` (design §5/§7): put a parked, failed or stuck node
 * back in motion. The row returns to `claimed` and a detached run-node takes
 * it as a new occupant; the implement lane re-derives its phase from GitHub
 * (F2), so a resumed node picks up where its PR is. The tracker claim is
 * untouched — a node whose claim was released must be re-claimed by the walk.
 *
 * A resume admits a worker to the implement lane, so it reads the row and
 * the lane holder under the claim lock (node #58) and holds it through the
 * row update and the spawn: a walk claim or `ranger build-now` that read the
 * lane empty cannot be joined by a resume until its own row holds the lane.
 */
export interface ResumeNodeContext {
 journal: Journal;
 map: RangerMapConfig;
 configPath: string;
 force?: boolean;
 spawnRunNode?: (args: SpawnRunNodeArgs) => Promise<number | null>;
 /** How long to wait for a claim in progress (CLAIM_LOCK_TIMEOUT_MS unless injected). */
 claimLockWaitMs?: number;
}

export interface ResumeNodeResult {
 nodeId: string;
 repo: string;
 root: number;
 was: WorkerRow["status"];
 pid: number | null;
}

export async function resumeNode(nodeId: string, ctx: ResumeNodeContext): Promise<ResumeNodeResult> {
 const { journal, map } = ctx;
 try {
  return await withClaimLock(
   journal,
   async (owned) => {
    const row = journal.getWorker(nodeId, map.repo);
    if (row === null || row.repo !== map.repo) {
     throw new Error(`no journal row for node ${nodeId} on ${map.repo} — nothing to resume`);
    }
    if (row.status === "released") {
     throw new Error(`node ${nodeId}'s claim was released — the walk re-claims it from the frontier`);
    }
    // A resume starts a worker session in this map's resource lane.
    const lane = implementLane(map);
    const takesLane = startsImplementSession(row);
    const holder = takesLane ? journal.laneHolder(lane, { nodeId, repo: map.repo }) : null;
    if (holder !== null && ctx.force !== true) {
     throw new Error(laneHeldMessage(lane, holder, "resume", nodeId));
    }
    // The fence before the first write; none of the writes below awaits
    // before the spawn (as in `claimNode`).
    owned();
    journal.updateWorker(nodeId, map.repo, { status: "claimed", pid: null, workerPgid: null, finishedAt: null });
    if (takesLane) recordImplementStart(journal, map);
    const pid = await (ctx.spawnRunNode ?? spawnRunNodeDetached)({
     nodeId,
     repo: map.repo,
     root: map.root,
     cliEntry: join(import.meta.dir, "cli.ts"),
     configPath: ctx.configPath,
    });
    if (pid !== null) journal.updateWorker(nodeId, map.repo, { pid });
    journal.recordEvent("sweep", {
     nodeId,
     repo: map.repo,
     detail: `resume-node by operator (was ${row.status}); run-node pid ${pid ?? "none"}`,
    });
    return { nodeId, repo: map.repo, root: map.root, was: row.status, pid };
   },
   ctx.claimLockWaitMs,
  );
 } catch (error) {
  if (error instanceof ClaimLockBusy) {
   throw new Error(`another claim is in progress (the tick or a build-now) — run resume-node again: ${error.message}`);
  }
  if (error instanceof ClaimLeaseLost) {
   throw new Error(`resume stopped before any write — ${error.message}`);
  }
  throw error;
 }
}
