import { encodeForgeRef, parseForgeRef, isGithubRepo } from "./forge-ref.ts";
import {
  type BudgetPolicy,
  assertNotThrottled,
  budgetedRead,
} from "./budget.ts";
import { runCmd } from "./exec.ts";
import {
  type BriefAudit,
  type BuildBriefNotReady,
  type FrontierResult,
  type GraphCallOptions,
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
 * graph bumps `updated_at`, so the next tick re-reads both. A failed audit is
 * cached as failed: a sentinel hit then serves the cached frontier and re-runs
 * only the audit, so a soma whose audit keeps failing costs no frontier read.
 * What the sentinel cannot see (an upgraded soma that newly lists a node, a
 * changed readiness rule) waits for the max age, like any other blind spot.
 *
 * A GitLab map has no sentinel (node #130): GitLab has no repo-wide
 * issue-event feed (research node #92), and whether link and child edits
 * bump `updated_at` there is unmeasured. So a GitLab read never takes a
 * sentinel and never reads or writes this cache: every scout reads the
 * frontier fresh, under the budget gate's 429 cooldown.
 */

interface CachedFrontier {
  sentinel: string;
  fetchedAt: string;
  frontier: FrontierResult;
  /** The audit's finding at that read; absent when it failed, and in entries cached before node #154. */
  briefs?: BuildBriefNotReady[];
  /** Why the audit at that read failed. */
  briefsError?: string;
}

/** A cached entry's audit; undefined for an entry cached before node #154. */
function cachedBriefs(cached: CachedFrontier): BriefAudit | undefined {
  if (cached.briefs !== undefined) return { ok: true, notReady: cached.briefs };
  if (cached.briefsError !== undefined) return { ok: false, error: cached.briefsError };
  return undefined;
}

function writeCache(journal: Journal, repo: string, root: number, entry: CachedFrontier): void {
  journal.setHealth(frontierCacheKey(repo, root), JSON.stringify(entry));
}

function withBriefs(entry: Omit<CachedFrontier, "briefs" | "briefsError">, briefs: BriefAudit): CachedFrontier {
  return briefs.ok ? { ...entry, briefs: briefs.notReady } : { ...entry, briefsError: briefs.error };
}

export const frontierCacheKey = (repo: string, root: number) => encodeForgeRef(parseForgeRef(repo), root).cacheKey;

/**
 * The repo's change sentinel: `<newest issue updated_at>|<newest issue-event
 * id>`, or null when either half cannot be read.
 */
export async function readRepoSentinel(
  repo: string,
  token: string,
): Promise<string | null> {
  // readFrontier never asks for a GitLab sentinel; null keeps any other
  // caller off the GitHub API (null means "fresh read, no cache write").
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
  /** Stubbed soma subprocess seam (GraphCallOptions.runner). */
  runner?: GraphCallOptions["runner"];
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
 * defers before any call. A GitLab map always reads fresh.
 */
export async function readFrontier(
  args: ReadFrontierArgs,
): Promise<FrontierRead> {
  const { journal, repo, root, token, maxAgeMs, now } = args;
  // A throttled token makes no forge call at all, the REST sentinel
  // included: requests sent while limited can extend the limit.
  assertNotThrottled(journal, repo, token, now);
  if (!isGithubRepo(repo)) return readFresh(args, null);
  const sentinel = await readRepoSentinel(repo, token.token);
  const cached = readCache(journal, repo, root);
  if (
    sentinel !== null &&
    cached !== null &&
    cached.sentinel === sentinel &&
    now.getTime() - new Date(cached.fetchedAt).getTime() < maxAgeMs
  ) {
    const kept = cachedBriefs(cached);
    if (kept?.ok === true) return { frontier: cached.frontier, briefs: kept, source: "cache" };
    // The cached audit failed (or predates node #154): the frontier still
    // stands, so re-run only the audit. The entry keeps its fetchedAt, so a
    // re-audit never extends the frontier's max age.
    const briefs = await readBriefs(args);
    writeCache(journal, repo, root, withBriefs({ sentinel, fetchedAt: cached.fetchedAt, frontier: cached.frontier }, briefs));
    return { frontier: cached.frontier, briefs, source: "cache" };
  }
  return readFresh(args, sentinel);
}

/**
 * A budgeted fresh read of the frontier and its audit, cached under
 * `sentinel` unless it is null.
 */
async function readFresh(args: ReadFrontierArgs, sentinel: string | null): Promise<FrontierRead> {
  const { journal, repo, root, token, policy, now } = args;
  // The sentinel was read BEFORE the walk, so a change landing between the
  // two is in the frontier but not the sentinel — the next read sees a new
  // sentinel and re-reads. Conservative, never stale.
  //
  // The audit runs after the frontier, not beside it: under a rate limit two
  // concurrent budgeted reads would each count the same throttle as a strike
  // and double the backoff.
  const frontier = await budgetedRead(journal, repo, token, policy, now, () =>
    graphFrontier(repo, root, token, graphOptions(args)),
  );
  const briefs = await readBriefs(args);
  if (sentinel !== null) {
    writeCache(journal, repo, root, withBriefs({ sentinel, fetchedAt: now.toISOString(), frontier }, briefs));
  }
  return { frontier, briefs, source: "fresh" };
}

function graphOptions(args: ReadFrontierArgs): GraphCallOptions {
  return {
    timeoutMs: args.timeoutMs ?? GRAPH_CALL_TIMEOUT_MS,
    ...(args.runner === undefined ? {} : { runner: args.runner }),
  };
}

/**
 * The audit's build-brief-not-ready finding. Any failure (a soma error, a
 * malformed finding, a budget deferral after the frontier was already read)
 * is returned as `ok: false`, so research and task nodes still walk while
 * build nodes wait.
 */
async function readBriefs(args: ReadFrontierArgs): Promise<BriefAudit> {
  const { journal, repo, root, token, policy, now } = args;
  try {
    const audit = await budgetedRead(journal, repo, token, policy, now, () =>
      graphAudit(repo, root, token, graphOptions(args)),
    );
    return { ok: true, notReady: audit.buildBriefNotReady ?? [] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The last frontier the walk or the escalation pass cached for a map, or null.
 * A plain journal read, with no GitHub call and no sentinel check: `ranger
 * serve` (#37) shows it with its age rather than re-reading a map ranger reads
 * every tick on the principal's own budget. A failed audit comes back as
 * `briefs.ok: false`, so the dashboard shows build nodes held as unverified.
 */
export function cachedFrontier(
  journal: Journal,
  repo: string,
  root: number,
): { fetchedAt: string; frontier: FrontierResult; briefs?: BriefAudit } | null {
  const cached = readCache(journal, repo, root);
  if (cached === null) return null;
  const briefs = cachedBriefs(cached);
  return {
    fetchedAt: cached.fetchedAt,
    frontier: cached.frontier,
    ...(briefs === undefined ? {} : { briefs }),
  };
}
