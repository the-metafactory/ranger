import { budgetedRead, type BudgetPolicy } from "./budget.ts";
import { frontierCacheKey } from "./frontier-cache.ts";
import { GRAPH_CALL_TIMEOUT_MS, graphNode, type FrontierEntry } from "./graph.ts";
import type { Journal } from "./journal.ts";
import type { ResolvedToken } from "./token-gate.ts";

/**
 * Who authored a map's root (node #246, ruling D6): ranger proposes a
 * research close only on a map the principal rooted, so soma's receipt names
 * the principal as ratifier. An issue's author never changes, so the first
 * read is kept in the journal's `health` table for good, and readers that
 * must not call GitHub (`ranger serve`) use the kept value alone.
 */
export const rootAuthorKey = (repo: string, root: number) => `root-author.${frontierCacheKey(repo, root)}`;

/** Does this frontier hold a `propose` research node, the only node the root author gates? */
export function needsRootAuthor(entries: readonly FrontierEntry[]): boolean {
 return entries.some((e) => e.node.autonomy === "propose" && e.node.kind === "research");
}

/** The kept root author, or undefined when none was read yet. */
export function cachedRootAuthor(journal: Journal, repo: string, root: number): string | undefined {
 const author = journal.getHealth(rootAuthorKey(repo, root));
 return author === null || author.length === 0 ? undefined : author;
}

/**
 * The root author: the kept value, else one budgeted `soma graph node` read,
 * kept on success. A failed or deferred read returns undefined, and the
 * caller treats the map as not principal-rooted for this pass.
 */
export async function readRootAuthor(args: {
 journal: Journal;
 repo: string;
 root: number;
 token: ResolvedToken;
 policy: BudgetPolicy;
 now: Date;
 timeoutMs?: number;
}): Promise<string | undefined> {
 const { journal, repo, root } = args;
 const cached = cachedRootAuthor(journal, repo, root);
 if (cached !== undefined) return cached;
 try {
  const node = await budgetedRead(journal, repo, args.token, args.policy, args.now, () =>
   graphNode(repo, String(root), args.token, { timeoutMs: args.timeoutMs ?? GRAPH_CALL_TIMEOUT_MS }));
  if (typeof node.author !== "string" || node.author.length === 0) return undefined;
  journal.setHealth(rootAuthorKey(repo, root), node.author);
  return node.author;
 } catch {
  return undefined;
 }
}
