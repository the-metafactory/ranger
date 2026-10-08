import type { NodeResult } from "./graph.ts";
import type { SweepContext, SweepMapResult } from "./sweep.ts";
import { mapKey } from "./maps.ts";
import { closedCardBudget, reconcileGraphClosedCards } from "./card-sync.ts";
import { mapPool } from "./pool.ts";
import { findNodePr, finishClosedElsewhere } from "./closed-elsewhere.ts";
import * as githubApi from "./github.ts";

/** Fixed work per tick; the keyset cursor prevents an open prefix starving the tail. */
export const MAX_WORKER_CLOSURE_READS = 5;

export async function reconcileGraphClosures(
 ctx: SweepContext,
 readNode: (id: string) => Promise<NodeResult>,
 result: SweepMapResult,
): Promise<void> {
 const { journal, map } = ctx;
 const cursorKey = `sweep.closureCursor.${mapKey(map)}`;
 const after = journal.getHealth(cursorKey) || undefined;
 const rows = journal.listClosureCandidates(map.repo, map.root, MAX_WORKER_CLOSURE_READS, after);
 const observations = await mapPool(rows, 3, async worker => {
  try {
   const node = await readNode(worker.nodeId);
   return { worker, node };
  } catch (error) {
   journal.recordEvent("sweep", { nodeId: worker.nodeId, repo: map.repo, detail: `graph closure reconciliation deferred: ${String(error)}` });
   return { worker, node: null };
  }
 });
 const cardBudget = closedCardBudget();
 // Git worktree removals affect shared canonical state: keep these sequential.
 for (const { worker, node } of observations) {
  if (node?.status !== "closed") continue;
  try {
   const forge = ctx.github ?? githubApi;
   const pr = await findNodePr(forge, map.repo, node, worker.prNumber, ctx.token);
   const outcome = await finishClosedElsewhere({ ...ctx, node, pr, generation: worker.generation, worktree: worker.worktree, cardBudget });
   if (outcome.status === "released") result.released.push(worker.nodeId);
  } catch (error) {
   journal.recordEvent("sweep", { nodeId: worker.nodeId, repo: map.repo, detail: `graph closure reconciliation deferred: ${String(error)}` });
  }
 }
 journal.setHealth(cursorKey, rows.length < MAX_WORKER_CLOSURE_READS ? "" : rows.at(-1)!.nodeId);
 try { await reconcileGraphClosedCards({ journal, map, readNode, budget: cardBudget }); }
 catch (error) { journal.recordEvent("sweep", { repo: map.repo, detail: `graph-closed cards deferred: ${String(error)}` }); }
}
