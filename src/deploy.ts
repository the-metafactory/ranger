import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCmd, type RunOptions, type RunResult } from "./exec.ts";
import { safeGit } from "./git-ops.ts";
import { withOwnedLease } from "./lock.ts";
import { workerHostEnv } from "./worker-env.ts";

export type DeployRun = (command: string, opts: RunOptions) => Promise<RunResult>;

export interface DeployRequest {
 repo: string;
 command: string;
 canonical: string;
 base: string;
 timeoutMs: number;
 journalPath: string;
 run?: DeployRun;
}

export type DeployResult =
 | { status: "deployed"; sha: string; result: RunResult }
 | { status: "failed"; detail: string; sha: string | null; result: RunResult | null };

const LOCK_WAIT_BEYOND_A_DEPLOY_MS = 60_000;

export function deployLockFile(journalPath: string, repo: string): string {
 return join(dirname(journalPath), `deploy-${repo.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`);
}

/**
 * Deploy a merged change with the map's `commands.deploy`: the operator's
 * command from ranger.yaml, never text from the repo or the tracker. Deploys
 * of one repo run one at a time, since one merge-desk pass can close several
 * of its nodes at once. Under that lock the base's newest commit is checked
 * out into a fresh detached worktree, so a later close fast-forwarding the
 * canonical checkout cannot change files under a running deploy, a branch
 * left checked out there is never what deploys, and a deploy that waited its
 * turn never puts an older base back. The command runs in that worktree, in
 * its own process group, under the allow-listed host env without the forge
 * tokens; the worktree is removed afterwards.
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
    const head = await safeGit(["rev-parse", "--verify", `refs/heads/${req.base}^{commit}`], { cwd: req.canonical, timeoutMs: 10_000 });
    if (head.code !== 0) return { status: "failed", detail: `no ${req.base} in ${req.canonical}: ${head.stderr.trim()}`, sha: null, result: null };
    const sha = head.stdout.trim();
    const scratch = mkdtempSync(join(tmpdir(), "ranger-deploy-"));
    const checkout = join(scratch, "checkout");
    try {
     const added = await safeGit(["worktree", "add", "--detach", checkout, sha], { cwd: req.canonical, timeoutMs: 120_000 });
     if (added.code !== 0) return { status: "failed", detail: `cannot check out ${sha.slice(0, 8)}: ${added.stderr.trim()}`, sha, result: null };
     const result = await run(req.command, { cwd: checkout, env: workerHostEnv(), timeoutMs: req.timeoutMs, processGroup: true });
     if (result.code === 0) return { status: "deployed", sha, result };
     const why = result.timedOut === true ? `timed out after ${Math.round(req.timeoutMs / 60_000)} min` : `exited ${result.code}`;
     const tail = (result.stderr || result.stdout).trim().slice(-300);
     return { status: "failed", detail: `${why}${tail === "" ? "" : `: ${tail}`}`, sha, result };
    } finally {
     await safeGit(["worktree", "remove", "--force", checkout], { cwd: req.canonical, timeoutMs: 60_000 });
     rmSync(scratch, { recursive: true, force: true });
     await safeGit(["worktree", "prune"], { cwd: req.canonical, timeoutMs: 30_000 });
    }
   },
  );
 } catch (error) {
  return { status: "failed", detail: error instanceof Error ? error.message : String(error), sha: null, result: null };
 }
}
