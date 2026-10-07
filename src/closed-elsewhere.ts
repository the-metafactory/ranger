import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandHome, type RangerConfig, type RangerMapConfig } from "./config.ts";
import type { NodeResult } from "./graph.ts";
import type { ChangeRequest } from "./forge.ts";
import type { Journal } from "./journal.ts";
import { safeGit } from "./git-ops.ts";
import { trustedSnapshot } from "./git-trust.ts";
import { mapKey } from "./maps.ts";
import { closeGraphEscalation } from "./card-sync.ts";
import { parseForgeRef } from "./forge-ref.ts";

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
}): Promise<{ status: "success" | "released"; detail: string; workerExit: null; prNumber?: number }> {
  const { map, journal, node, pr, generation } = ctx;
  if (node.status !== "closed") throw new Error("closed-elsewhere reconciliation requires a closed graph node");
  const id = node.ref.id;
  const fence = () => journal.assertGeneration(id, map.repo, generation, "finish an externally closed node");
  const merged = pr?.state === "merged";
  const completion = node.node.completion;
  const ownClose = completion?.closer === ctx.botIdentity;
  const receipt = completion === undefined ? "not available" :
    `${node.url}${parseForgeRef(map.repo).forge === "github" ? "#issuecomment-" : "#note_"}${completion.receiptCommentId}`;
  const attribution = completion === undefined ? "closed on the graph without a gated-close receipt; closer unknown" :
    ownClose ? `recovered ranger close by ${completion.closer}` : `closed outside ranger by ${completion.closer}`;
  const detail = `${attribution}; receipt: ${receipt}; ${pr === null ? "no PR" : `PR #${pr.iid} ${pr.state}`}`;
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
  if (merged) journal.resetDeadman();
  journal.recordEvent(completion === undefined ? "closed-elsewhere-ungated" : ownClose ? "closed" : "closed-elsewhere", { nodeId: id, repo: map.repo, detail });
  try {
    await closeGraphEscalation({ journal, map, nodeId: id, owned: fence });
  } catch (error) {
    fence();
    journal.recordEvent("sweep", { nodeId: id, repo: map.repo, detail: `closed graph card sync deferred: ${String(error)}` });
  }
  return { status: merged ? "success" : "released", detail, workerExit: null, ...(pr === null ? {} : { prNumber: pr.iid }) };
}
