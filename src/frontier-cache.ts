import { encodeForgeRef, parseForgeRef, isGithubRepo } from "./forge-ref.ts";
import {
  type BudgetPolicy,
  assertNotThrottled,
  budgetedRead,
} from "./budget.ts";
import { createHash } from "node:crypto";
import { runCmd } from "./exec.ts";
import {
  type BriefAudit,
  type BuildBriefNotReady,
  type FrontierEntry,
  type FrontierResult,
  type GraphCallOptions,
  AUDIT_CALL_TIMEOUT_MS,
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
 * Every read also settles `soma graph audit`'s build-brief-not-ready finding
 * (node #154, soma#752 D4: soma's audit is the only definition). The audit
 * reads every node of the map, so on a large map it takes minutes (seelite,
 * 401 nodes: 83s), and an active map moves its sentinel on every comment. So
 * the last good audit is cached on its own, with a fingerprint of each
 * frontier build node's brief (kind, title, body) as the audit saw it, and is
 * reused while it is younger than the max age. A build node new or edited
 * since then is `unverified` and held, as if its audit had failed: the
 * finding is a deny-list, so an unaudited node must never read as ready. Who
 * may run the audit is the caller's `audit` mode: `refresh` runs it when no
 * good audit is young enough or a build brief changed (the walk, before the
 * claim lock); `if-missing` only when there is no good audit at all (the
 * escalation pass, which must fit its 120s budget); `never` serves what is
 * cached (the walk under the claim lock). A failed audit never replaces the
 * last good one: it is served, with the changed nodes held, and the failure
 * reported as `auditNote`. What a fingerprint cannot see (an upgraded soma
 * that newly lists a node, a changed readiness rule) waits for the max age.
 *
 * A GitLab map has no sentinel (node #130): GitLab has no repo-wide
 * issue-event feed (research node #92), and whether link and child edits
 * bump `updated_at` there is unmeasured. So a GitLab read never takes a
 * sentinel and never reads or writes this cache: every scout reads the
 * frontier fresh, under the budget gate's 429 cooldown.
 */

/** The last good audit: its finding, and each frontier build node's brief fingerprint as it saw them. */
interface CachedAudit {
  fetchedAt: string;
  notReady: BuildBriefNotReady[];
  prints: Record<string, string>;
}

interface CachedFrontier {
  sentinel: string;
  fetchedAt: string;
  frontier: FrontierResult;
  /** The last good audit; kept, not replaced, when a later audit fails. */
  audit?: CachedAudit;
  /** Why the latest audit failed; cleared by the next good one. */
  briefsError?: string;
  /** An entry cached before the audit had its own cache: its finding, tied to the frontier read. */
  briefs?: BuildBriefNotReady[];
}

/** One build node's brief as the audit judges it: what changes it changes this fingerprint. */
function briefPrint(entry: FrontierEntry): string {
  return createHash("sha256").update(JSON.stringify([entry.node.kind, entry.node.title, entry.body ?? ""])).digest("hex");
}

/** Every frontier build node's brief fingerprint, by node id. */
function buildPrints(frontier: FrontierResult): Record<string, string> {
  const prints: Record<string, string> = {};
  for (const entry of frontier.frontier) {
    if (entry.node.kind === "build") prints[entry.ref.id] = briefPrint(entry);
  }
  return prints;
}

/** Build nodes whose brief the audit did not see as it stands now. */
function unauditedBuilds(prints: Record<string, string>, audit: CachedAudit): string[] {
  return Object.keys(prints).filter((id) => audit.prints[id] !== prints[id]);
}

/** A served audit: its finding, with the build nodes it did not see held. */
function servedAudit(audit: CachedAudit, prints: Record<string, string>): BriefAudit {
  const unverified = unauditedBuilds(prints, audit);
  return unverified.length === 0
    ? { ok: true, notReady: audit.notReady }
    : { ok: true, notReady: audit.notReady, unverified };
}

/** A cached entry's audit against its own frontier; undefined for an entry cached before node #154. */
function cachedBriefs(cached: CachedFrontier): BriefAudit | undefined {
  if (cached.audit !== undefined) return servedAudit(cached.audit, buildPrints(cached.frontier));
  if (cached.briefsError !== undefined) return { ok: false, error: cached.briefsError };
  if (cached.briefs !== undefined) return { ok: true, notReady: cached.briefs };
  return undefined;
}

function writeCache(journal: Journal, repo: string, root: number, entry: CachedFrontier): void {
  journal.setHealth(frontierCacheKey(repo, root), JSON.stringify(entry));
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

/**
 * Who may run `soma graph audit` on this read: `refresh` when no good audit
 * is young enough or a build brief changed since it; `if-missing` only when
 * there is no good audit at all; `never` serves what is cached.
 */
export type AuditMode = "refresh" | "if-missing" | "never";

export interface ReadFrontierArgs {
  journal: Journal;
  repo: string;
  root: number;
  token: ResolvedToken;
  policy: BudgetPolicy;
  maxAgeMs: number;
  now: Date;
  /** The frontier read's bound (default GRAPH_CALL_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Default `refresh`. */
  audit?: AuditMode;
  /** The audit's bound (default AUDIT_CALL_TIMEOUT_MS). */
  auditTimeoutMs?: number;
  /** Stubbed soma subprocess seam (GraphCallOptions.runner). */
  runner?: GraphCallOptions["runner"];
}

export interface FrontierRead {
  frontier: FrontierResult;
  briefs: BriefAudit;
  /** `cache` when the sentinel matched and no GraphQL was spent. */
  source: "cache" | "fresh";
  /** Wall-clock of the audit this read ran; absent when it ran none. */
  auditMs?: number;
  /** The audit this read ran failed, and an older good audit is served in its place. */
  auditNote?: string;
}

/**
 * The map's frontier: the cached read when the repo's sentinel is unchanged
 * and the read is young enough, else a budgeted fresh read (src/budget.ts —
 * which may throw BudgetDeferral). Under a `floor` cooldown a valid cache is
 * still served (the sentinel is REST, a separate bucket); a `throttled` token
 * defers before any call. A GitLab map always reads fresh. Its audit is
 * settled by `args.audit` (see the module comment).
 */
export async function readFrontier(
  args: ReadFrontierArgs,
): Promise<FrontierRead> {
  const { journal, repo, root, token, policy, maxAgeMs, now } = args;
  // A throttled token makes no forge call at all, the REST sentinel
  // included: requests sent while limited can extend the limit.
  assertNotThrottled(journal, repo, token, now);
  const github = isGithubRepo(repo);
  const sentinel = github ? await readRepoSentinel(repo, token.token) : null;
  const cached = github ? readCache(journal, repo, root) : null;
  const hit =
    sentinel !== null &&
    cached !== null &&
    cached.sentinel === sentinel &&
    now.getTime() - new Date(cached.fetchedAt).getTime() < maxAgeMs;
  // The sentinel was read BEFORE the walk, so a change landing between the
  // two is in the frontier but not the sentinel — the next read sees a new
  // sentinel and re-reads. Conservative, never stale.
  const frontier = hit
    ? cached.frontier
    : await budgetedRead(journal, repo, token, policy, now, () =>
        graphFrontier(repo, root, token, {
          timeoutMs: args.timeoutMs ?? GRAPH_CALL_TIMEOUT_MS,
          ...(args.runner === undefined ? {} : { runner: args.runner }),
        }),
      );
  const settled = await settleAudit(args, frontier, cached);
  if (sentinel !== null) {
    // A cache hit keeps its fetchedAt, so a re-audit never extends the
    // frontier's max age.
    writeCache(journal, repo, root, {
      sentinel,
      fetchedAt: hit ? cached.fetchedAt : now.toISOString(),
      frontier,
      ...(settled.audit === undefined ? {} : { audit: settled.audit }),
      ...(settled.error === undefined ? {} : { briefsError: settled.error }),
    });
  }
  return {
    frontier,
    briefs: settled.briefs,
    source: hit ? "cache" : "fresh",
    ...(settled.ms === undefined ? {} : { auditMs: settled.ms }),
    ...(settled.note === undefined ? {} : { auditNote: settled.note }),
  };
}

interface SettledAudit {
  briefs: BriefAudit;
  /** The good audit to cache (the new one, or the last one kept). */
  audit?: CachedAudit;
  /** The latest audit's failure, to cache. */
  error?: string;
  ms?: number;
  note?: string;
}

/**
 * The read's audit: the last good one while it is young enough and saw every
 * build brief as it stands (or the mode forbids a run), else a fresh run. The
 * audit runs after the frontier, not beside it: under a rate limit two
 * concurrent budgeted reads would each count the same throttle as a strike
 * and double the backoff.
 */
async function settleAudit(
  args: ReadFrontierArgs,
  frontier: FrontierResult,
  cached: CachedFrontier | null,
): Promise<SettledAudit> {
  const { maxAgeMs, now } = args;
  const mode = args.audit ?? "refresh";
  const prints = buildPrints(frontier);
  const kept = cached?.audit;
  const last =
    kept !== undefined && now.getTime() - new Date(kept.fetchedAt).getTime() < maxAgeMs ? kept : undefined;
  const run =
    mode === "refresh"
      ? last === undefined || unauditedBuilds(prints, last).length > 0
      : mode === "if-missing" && last === undefined;
  if (!run) {
    if (last !== undefined) {
      return { briefs: servedAudit(last, prints), audit: last, ...(cached?.briefsError === undefined ? {} : { error: cached.briefsError }) };
    }
    const error = cached?.briefsError ?? "soma graph audit not read yet";
    return { briefs: { ok: false, error }, ...(kept === undefined ? {} : { audit: kept }), error };
  }
  const started = Date.now();
  const briefs = await readBriefs(args);
  const ms = Date.now() - started;
  if (briefs.ok) {
    return { briefs, audit: { fetchedAt: now.toISOString(), notReady: briefs.notReady, prints }, ms };
  }
  if (last !== undefined) {
    return {
      briefs: servedAudit(last, prints),
      audit: last,
      error: briefs.error,
      ms,
      note: `${briefs.error} — serving the audit from ${last.fetchedAt}; build nodes changed since are held`,
    };
  }
  return { briefs, ...(kept === undefined ? {} : { audit: kept }), error: briefs.error, ms };
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
      graphAudit(repo, root, token, {
        timeoutMs: args.auditTimeoutMs ?? AUDIT_CALL_TIMEOUT_MS,
        ...(args.runner === undefined ? {} : { runner: args.runner }),
      }),
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
