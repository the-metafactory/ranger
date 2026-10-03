import {
  type BudgetPolicy,
  assertNotThrottled,
  budgetedRead,
} from "./budget.ts";
import { runCmd } from "./exec.ts";
import {
  type FrontierResult,
  GRAPH_CALL_TIMEOUT_MS,
  graphFrontier,
} from "./graph.ts";
import type { Journal } from "./journal.ts";
import { gatedEnv, type ResolvedToken } from "./token-gate.ts";

/**
 * Frontier reads that skip GraphQL when nothing on the repo changed.
 *
 * A `soma graph frontier` walk costs ~15–25 GraphQL points and arrives as a
 * burst of calls; most 15-minute ticks find the map exactly as the last one
 * left it. So each read first takes the repo's **sentinel** — two REST calls,
 * outside the GraphQL allowance — and reuses the last frontier while the
 * sentinel is unchanged and the cached read is younger than
 * `budget.frontierMaxAgeMin`.
 *
 * The sentinel has two halves because neither alone sees every change
 * (measured 2026-10-03 on the-metafactory/ranger#40/#41):
 *
 * - **newest issue `updated_at`** sees creates, body/title edits, comments,
 *   closes and assignment — but adding or removing a blocked-by edge or a
 *   sub-issue does NOT bump `updated_at` on either issue;
 * - **newest repo issue-event id** sees exactly those edge changes
 *   (`blocked_by_added`, `blocked_by_removed`, `sub_issue_added`,
 *   `parent_issue_added`) plus closes and assignment — but not body edits or
 *   comments.
 *
 * So a node edited to HITL bumps the first half and a newly blocked node bumps
 * the second: the cache never hands the walk a frontier older than the
 * sentinel it just read (the round-29 fresh-read rule holds). Whatever the
 * sentinel cannot see is bounded by the max age. An unreadable sentinel means
 * a fresh read and no cache write — the cache only ever fails toward GraphQL.
 *
 * The cache lives in the journal's `health` table (`frontier:<repo>#<root>`):
 * disposable derived state, so deleting it costs one fresh read.
 */

interface CachedFrontier {
  sentinel: string;
  fetchedAt: string;
  frontier: FrontierResult;
}

const CACHE_KEY = (repo: string, root: number) => `frontier:${repo}#${root}`;

/**
 * The repo's change sentinel: `<newest issue updated_at>|<newest issue-event
 * id>`, or null when either half cannot be read.
 */
export async function readRepoSentinel(
  repo: string,
  token: string,
): Promise<string | null> {
  const gated = gatedEnv(token);
  try {
    const read = async (path: string, jq: string) => {
      const result = await runCmd("gh", ["api", path, "--jq", jq], {
        env: gated.env,
        timeoutMs: 15_000,
      });
      return result.code === 0 ? result.stdout.trim() : null;
    };
    const [updatedAt, eventId] = await Promise.all([
      read(
        `repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=1`,
        '.[0].updated_at // ""',
      ),
      read(`repos/${repo}/issues/events?per_page=1`, '.[0].id // ""'),
    ]);
    if (updatedAt === null || eventId === null) return null;
    return `${updatedAt}|${eventId}`;
  } finally {
    gated.cleanup();
  }
}

function readCache(
  journal: Journal,
  repo: string,
  root: number,
): CachedFrontier | null {
  const raw = journal.getHealth(CACHE_KEY(repo, root));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as CachedFrontier;
  } catch {
    return null;
  }
}

export interface ReadFrontierArgs {
  journal: Journal;
  repo: string;
  root: number;
  token: ResolvedToken;
  policy: BudgetPolicy;
  maxAgeMs: number;
  now: Date;
  timeoutMs?: number;
}

export interface FrontierRead {
  frontier: FrontierResult;
  /** `cache` when the sentinel matched and no GraphQL was spent. */
  source: "cache" | "fresh";
}

/**
 * The map's frontier: the cached read when the repo's sentinel is unchanged
 * and the read is young enough, else a budgeted fresh read (src/budget.ts —
 * which may throw BudgetDeferral). Under a `floor` cooldown a valid cache is
 * still served (the sentinel is REST, a separate bucket); a `throttled` token
 * defers before any call.
 */
export async function readFrontier(
  args: ReadFrontierArgs,
): Promise<FrontierRead> {
  const { journal, repo, root, token, policy, maxAgeMs, now } = args;
  // A throttled token makes no GitHub call at all, the REST sentinel
  // included: requests sent while limited can extend the limit.
  assertNotThrottled(journal, token, now);
  const sentinel = await readRepoSentinel(repo, token.token);
  const cached = readCache(journal, repo, root);
  if (
    sentinel !== null &&
    cached !== null &&
    cached.sentinel === sentinel &&
    now.getTime() - new Date(cached.fetchedAt).getTime() < maxAgeMs
  ) {
    return { frontier: cached.frontier, source: "cache" };
  }
  // The sentinel was read BEFORE the walk, so a change landing between the
  // two is in the frontier but not the sentinel — the next read sees a new
  // sentinel and re-reads. Conservative, never stale.
  const frontier = await budgetedRead(journal, token, policy, now, () =>
    graphFrontier(repo, root, token, {
      timeoutMs: args.timeoutMs ?? GRAPH_CALL_TIMEOUT_MS,
    }),
  );
  if (sentinel !== null) {
    const entry: CachedFrontier = {
      sentinel,
      fetchedAt: now.toISOString(),
      frontier,
    };
    journal.setHealth(CACHE_KEY(repo, root), JSON.stringify(entry));
  }
  return { frontier, source: "fresh" };
}
