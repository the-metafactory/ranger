import { headSha, isAncestor, safeGit } from "./git-ops.ts";
import type { Journal, WorkerRow } from "./journal.ts";

export async function recordedRebaseFrom(opts: {
 worktree: string;
 here: string;
 prHead: string;
 rebases: ReturnType<Journal["listRebases"]>;
}): Promise<string | null> {
 for (const rebase of opts.rebases) {
  if (rebase.to !== opts.prHead) continue;
  const have = await safeGit(["cat-file", "-e", `${rebase.from}^{commit}`], { cwd: opts.worktree, timeoutMs: 10_000 });
  if (have.code === 0 && await isAncestor(opts.worktree, rebase.from, opts.here)) return rebase.from;
 }
 return null;
}

export async function unchangedHeadPark(row: WorkerRow, prHead: string, journal: Journal): Promise<boolean> {
 if (row.status !== "parked" || row.worktree === null || row.outcome === null) return false;
 const foreign = /^the worktree \(([0-9a-f]{8})\) has commits .+?'s head \(([0-9a-f]{8})\) does not contain: someone pushed/.exec(row.outcome);
 const conflict = /^rebase merge conflicts: the worktree \(([0-9a-f]{8})\) and .+?'s head \(([0-9a-f]{8})\)/.exec(row.outcome);
 const parked = foreign ?? conflict;
 if (parked === null || !prHead.startsWith(parked[2])) return false;
 const here = await headSha(row.worktree);
 if (!here.startsWith(parked[1])) return false;
 if (conflict !== null) return true;
 return await recordedRebaseFrom({ worktree: row.worktree, here, prHead, rebases: journal.listRebases(row.repo, row.nodeId) }) === null;
}
