import { encodeForgeRef, parseForgeRef, isGithubRepo } from "./forge-ref.ts";
import {
  type BudgetPolicy,
  BudgetDeferral,
  assertNotThrottled,
  budgetedRead,
} from "./budget.ts";
import { runCmd } from "./exec.ts";
import {
  type BuildBriefNotReady,
  type FrontierResult,
  GRAPH_CALL_TIMEOUT_MS,
  graphAudit,
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
 *
 * A fresh read also reads `soma graph audit` for its build-brief-not-ready
 * finding (node #154, soma#752 D4: soma's audit is the only definition), and
 * caches it beside the frontier under the same sentinel: a body fixed on the
 * graph bumps `updated_at`, so the next tick re-reads both.
 */

interface CachedFrontier {
  sentinel: string;
  fetchedAt: string;
  frontier: FrontierResult;
  /** The audit's finding at that read; absent in entries cached before node #154. */
  briefs?: BuildBriefNotReady[];
}

/**
 * Soma's build-brief-not-ready finding for one frontier read. `ok: false`
 * when the audit could not be read: the walk then holds every build node
 * (src/route.ts). A soma without the field reads as `ok` with none listed.
 */
export type BriefAudit =
  | { ok: true; notReady: BuildBriefNotReady[] }
  | { ok: false; error: string };

export const frontierCacheKey = (repo: string, root: number) => encodeForgeRef(parseForgeRef(repo), root).cacheKey;

/**
 * The repo's change sentinel: `<newest issue updated_at>|<newest issue-event
 * id>`, or null when either half cannot be read.
 */
export async function readRepoSentinel(
  repo: string,
  token: string,
): Promise<string | null> {
  // GitLab has no sentinel implementation yet: null forces a fresh graph
  // read and prevents a cache write instead of issuing a GitHub API call.
  if (!isGithubRepo(repo)) return null;
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
  const raw = journal.getHealth(frontierCacheKey(repo, root));
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
  briefs: BriefAudit;
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
    cached.briefs !== undefined &&
    cached.sentinel === sentinel &&
    now.getTime() - new Date(cached.fetchedAt).getTime() < maxAgeMs
  ) {
    return { frontier: cached.frontier, briefs: { ok: true, notReady: cached.briefs }, source: "cache" };
  }
  // The sentinel was read BEFORE the walk, so a change landing between the
  // two is in the frontier but not the sentinel — the next read sees a new
  // sentinel and re-reads. Conservative, never stale.
  const frontier = await budgetedRead(journal, repo, token, policy, now, () =>
    graphFrontier(repo, root, token, {
      timeoutMs: args.timeoutMs ?? GRAPH_CALL_TIMEOUT_MS,
    }),
  );
  const briefs = await readBriefs(args);
  // A failed audit is not cached: the next tick reads both again.
  if (sentinel !== null && briefs.ok) {
    const entry: CachedFrontier = {
      sentinel,
      fetchedAt: now.toISOString(),
      frontier,
      briefs: briefs.notReady,
    };
    journal.setHealth(frontierCacheKey(repo, root), JSON.stringify(entry));
  }
  return { frontier, briefs, source: "fresh" };
}

/**
 * The audit's build-brief-not-ready finding. A budget deferral defers the
 * whole read like the frontier's own; any other failure (a soma error, a
 * malformed finding) is returned as `ok: false`, so research and task
 * nodes still walk while build nodes wait.
 */
async function readBriefs(args: ReadFrontierArgs): Promise<BriefAudit> {
  const { journal, repo, root, token, policy, now } = args;
  try {
    const audit = await budgetedRead(journal, repo, token, policy, now, () =>
      graphAudit(repo, root, token, {
        timeoutMs: args.timeoutMs ?? GRAPH_CALL_TIMEOUT_MS,
      }),
    );
    return { ok: true, notReady: audit.buildBriefNotReady ?? [] };
  } catch (error) {
    if (error instanceof BudgetDeferral) throw error;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The last frontier the walk or the escalation pass cached for a map, or null.
 * A plain journal read, with no GitHub call and no sentinel check: `ranger
 * serve` (#37) shows it with its age rather than re-reading a map ranger reads
 * every tick on the principal's own budget.
 */
export function cachedFrontier(
  journal: Journal,
  repo: string,
  root: number,
): { fetchedAt: string; frontier: FrontierResult; briefs?: BriefAudit } | null {
  const cached = readCache(journal, repo, root);
  return cached === null
    ? null
    : {
        fetchedAt: cached.fetchedAt,
        frontier: cached.frontier,
        ...(cached.briefs === undefined ? {} : { briefs: { ok: true as const, notReady: cached.briefs } }),
      };
}
