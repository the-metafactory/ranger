import { headSha, isAncestor, safeGit } from "./git-ops.ts";
import type { Journal, WorkerRow } from "./journal.ts";
import { parseHeadPark } from "./outcomes.ts";

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
 const parked = parseHeadPark(row.outcome);
 if (parked === null || !prHead.startsWith(parked.prHead)) return false;
 const here = await headSha(row.worktree);
 if (!here.startsWith(parked.here)) return false;
 if (parked.kind === "conflict") return true;
 return await recordedRebaseFrom({ worktree: row.worktree, here, prHead, rebases: journal.listRebases(row.repo, row.nodeId) }) === null;
}
