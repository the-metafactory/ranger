import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandHome, type RangerConfig, type RangerMapConfig } from "./config.ts";
import type { NodeResult } from "./graph.ts";
import type { ChangeRequest, ForgePort } from "./forge.ts";
import type { Journal } from "./journal.ts";
import { safeGit } from "./git-ops.ts";
import { trustedSnapshot } from "./git-trust.ts";
import { mapKey } from "./maps.ts";
import { closeGraphEscalation, type CardBudget } from "./card-sync.ts";
import { changeRequestLabel, changeRequestNoun, nodeCommentUrl } from "./forge-text.ts";
import { implementBranchFor } from "./implement.ts";
import { researchBranchFor, slugify, worktreeBranch } from "./worker.ts";

export async function findNodePr(
  forge: ForgePort,
  repo: string,
  node: NodeResult,
  prNumber: number | null | undefined,
  token: string,
): Promise<ChangeRequest | null> {
  if (prNumber != null) return forge.getPr(repo, prNumber, token);
  const branch = node.node.kind === "research" ? researchBranchFor(node.node) :
    implementBranchFor(node.node, worktreeBranch(node.ref.id, slugify(node.node.title)));
  return forge.findPrByHead(repo, branch, token);
}

/** Reconcile a tracker closure; this never makes a graph write. */
export async function finishClosedElsewhere(ctx: {
  config: RangerConfig;
  map: RangerMapConfig;
  journal: Journal;
  node: NodeResult;
  pr: ChangeRequest | null;
  generation: number;
  botIdentity: string;
  canonical?: string;
  worktree?: string | null;
  cardBudget?: CardBudget;
}): Promise<{ status: "success" | "released"; detail: string; workerExit: null; prNumber?: number; graphClosureReconciled: true }> {
  const { map, journal, node, pr, generation } = ctx;
  if (node.status !== "closed") throw new Error("closed-elsewhere reconciliation requires a closed graph node");
  const id = node.ref.id;
  const fence = () => journal.assertGeneration(id, map.repo, generation, "finish an externally closed node");
  const merged = pr?.state === "merged";
  const completion = node.node.completion;
  const kind = completion === undefined ? "ungated" : completion.closer === ctx.botIdentity ? "own" : "external";
  const receipt = completion === undefined ? "not available" :
    nodeCommentUrl(map.repo, node.url, completion.receiptCommentId);
  const attribution = kind === "ungated" ? "closed on the graph without a gated-close receipt; closer unknown" :
    kind === "own" ? `recovered ranger close by ${completion!.closer}` : `closed outside ranger by ${completion!.closer}`;
  const detail = `${attribution}; receipt: ${receipt}; ${pr === null ? `no ${changeRequestNoun(map.repo)}` : `${changeRequestLabel(map.repo, pr.iid)} ${pr.state}`}`;
  const canonical = ctx.canonical ?? (map.canonical === undefined ? join(expandHome(ctx.config.state.canonicalRoot), map.repo) : expandHome(map.canonical));
  const worktree = ctx.worktree ?? journal.getWorker(id, map.repo)?.worktree;
  fence();
  if (merged && worktree != null && existsSync(worktree)) {
    await trustedSnapshot(journal, canonical, { repo: map.repo, nodeId: id }, mapKey(map));
    fence();
    const removed = await safeGit(["worktree", "remove", "--force", worktree], { cwd: canonical });
    if (removed.code !== 0) throw new Error(`could not remove closed node's worktree: ${removed.stderr}`);
  }
  fence();
  journal.updateWorker(id, map.repo, {
    status: merged ? "success" : "released", pid: null, workerPgid: null,
    phase: "close", finishedAt: new Date().toISOString(), outcome: detail,
    ...(merged ? { worktree: null } : {}),
  });
  if (merged && kind === "own") journal.resetDeadman();
  const eventKind = ({ ungated: "closed-elsewhere-ungated", own: "closed", external: "closed-elsewhere" } as const)[kind];
  journal.recordEvent(eventKind, { nodeId: id, repo: map.repo, detail });
  try {
    await closeGraphEscalation({ journal, map, nodeId: id, owned: fence, budget: ctx.cardBudget });
  } catch (error) {
    fence();
    journal.recordEvent("sweep", { nodeId: id, repo: map.repo, detail: `closed graph card sync deferred: ${String(error)}` });
  }
  return { status: merged ? "success" : "released", detail, workerExit: null, graphClosureReconciled: true, ...(pr === null ? {} : { prNumber: pr.iid }) };
}
