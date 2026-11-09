import { dirname, join } from "node:path";
import { runCmd, type RunOptions, type RunResult } from "./exec.ts";
import { withOwnedLease } from "./lock.ts";
import { workerHostEnv } from "./worker-env.ts";

export type DeployRun = (command: string, opts: RunOptions) => Promise<RunResult>;

export interface DeployRequest {
 repo: string;
 command: string;
 mergedCheckout: string;
 timeoutMs: number;
 journalPath: string;
 run?: DeployRun;
}

export type DeployResult =
 | { status: "deployed"; result: RunResult }
 | { status: "failed"; detail: string; result: RunResult | null };

const LOCK_WAIT_BEYOND_A_DEPLOY_MS = 60_000;

export function deployLockFile(journalPath: string, repo: string): string {
 return join(dirname(journalPath), `deploy-${repo.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`);
}

/**
 * Deploy a merged change with the map's `commands.deploy`: the operator's
 * command from ranger.yaml, never text from the repo or the tracker. It runs
 * in the canonical checkout, in its own process group, under the
 * allow-listed host env without the forge tokens. Deploys of one repo run
 * one at a time: one merge-desk pass can close several of its nodes at once.
 */
export async function deployMerged(req: DeployRequest): Promise<DeployResult> {
 const run: DeployRun = req.run ?? ((command, opts) => runCmd("/bin/sh", ["-c", command], opts));
 try {
  return await withOwnedLease(
   deployLockFile(req.journalPath, req.repo),
   {
    timeoutMs: req.timeoutMs + LOCK_WAIT_BEYOND_A_DEPLOY_MS,
    contended: () => new Error(`another deploy of ${req.repo} still holds the lock`),
    lost: (why) => new Error(`lost the deploy lock for ${req.repo}: ${why}`),
   },
   async () => {
    const result = await run(req.command, {
     cwd: req.mergedCheckout,
     env: workerHostEnv(),
     timeoutMs: req.timeoutMs,
     processGroup: true,
    });
    if (result.code === 0) return { status: "deployed", result };
    const why = result.timedOut === true ? `timed out after ${Math.round(req.timeoutMs / 60_000)} min` : `exited ${result.code}`;
    const tail = (result.stderr || result.stdout).trim().slice(-300);
    return { status: "failed", detail: `${why}${tail === "" ? "" : `: ${tail}`}`, result };
   },
  );
 } catch (error) {
  return { status: "failed", detail: error instanceof Error ? error.message : String(error), result: null };
 }
}
