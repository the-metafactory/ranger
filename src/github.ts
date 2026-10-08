import type { ChangeRequest, MergeState, CiPurpose, CiVerdict, IssueComment } from "./forge.ts";
import { githubCiVerdict } from "./github-ci.ts";
import { runCmd } from "./exec.ts";
import { runReadRetryingTransient } from "./transient.ts";
import { writeEnv } from "./identity.ts";

/**
 * The implement lane's pull-request surface (design §4, #23): every call is a
 * `gh api` REST request under the machine account's write token, isolated from
 * the keyring (`writeEnv`). The supervisor calls these; the worker session
 * never does — it holds no credential.
 */

export class GitHubError extends Error {
 override readonly name = "GitHubError";
}

const GH_TIMEOUT_MS = 60_000;

/** gh api flags that make the request a write (a method other than GET, or a body). */
const WRITE_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

/** A plain GET is safe to repeat; anything with a body or another method is not. */
export function isReadRequest(args: string[]): boolean {
 for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (WRITE_FLAGS.has(a) || a.startsWith("--field=") || a.startsWith("--raw-field=") || a.startsWith("--input=")) return false;
  if (a === "-X" || a === "--method") {
   if ((args[i + 1] ?? "").toUpperCase() !== "GET") return false;
  } else if (a.startsWith("--method=") || a.startsWith("-X")) {
   const method = a.startsWith("--method=") ? a.slice(9) : a.slice(2);
   if (method.length > 0 && method.toUpperCase() !== "GET") return false;
  }
 }
 return true;
}

export interface CheckRun {
 id: number;
 name: string;
 status: string;
 conclusion: string | null;
}

export interface WorkflowRun extends CheckRun {
 workflowId: number;
 event: string;
 attempt: number;
}

export interface CommitStatus {
 id: number;
 context: string;
 state: string;
}

async function ghApi(
 token: string,
 args: string[],
 label: string,
): Promise<unknown> {
 const gated = writeEnv(token);
 try {
  // Reads retry a transient GitHub error; writes run once (a timed-out POST may have landed).
  const run = isReadRequest(args) ? runReadRetryingTransient : runCmd;
  const result = await run("gh", ["api", ...args], {
   env: gated.env,
   timeoutMs: GH_TIMEOUT_MS,
  });
  if (result.code !== 0) {
   throw new GitHubError(
    `${label} failed (gh api, exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
   );
  }
  const raw = result.stdout.trim();
  if (raw.length === 0) return null;
  try {
   return JSON.parse(raw) as unknown;
  } catch {
   throw new GitHubError(`${label}: unparseable JSON from gh api`);
  }
 } finally {
  gated.cleanup();
 }
}

function toChangeRequest(raw: unknown): ChangeRequest {
 const r = raw as Record<string, unknown>;
 const head = (r.head ?? {}) as Record<string, unknown>;
 const base = (r.base ?? {}) as Record<string, unknown>;
 const user = (r.user ?? {}) as Record<string, unknown>;
 const mergedBy = (r.merged_by ?? null) as Record<string, unknown> | null;
 return {
  iid: Number(r.number),
  state: r.merged === true || (typeof r.merged_at === "string" && r.merged_at.length > 0) ? "merged" : r.state === "closed" ? "closed" : "open",
  draft: r.draft === true,
  title: String(r.title ?? ""),
  body: String(r.body ?? ""),
  headRef: String(head.ref ?? ""),
  headSha: String(head.sha ?? ""),
  baseRef: String(base.ref ?? ""),
  mergeState: githubMergeState(r.mergeable, r.mergeable_state),
  mergeDetail: githubMergeState(r.mergeable, r.mergeable_state) === "pending" ? "GitHub is still computing mergeability" : `mergeable=${typeof r.mergeable === "boolean" ? r.mergeable : null}, state=${String(r.mergeable_state ?? "unknown")}`,
  mergeCommitSha:
   typeof r.merge_commit_sha === "string" ? r.merge_commit_sha : null,
  mergedBy: mergedBy === null ? null : String(mergedBy.login ?? ""),
  webUrl: String(r.html_url ?? ""),
  author: String(user.login ?? ""),
 };
}

/** The newest PR (any state) whose head is `branch` in `repo` — the F2 resume anchor. */
export async function findPrByHead(
 repo: string,
 branch: string,
 token: string,
): Promise<ChangeRequest | null> {
 const owner = repo.split("/")[0];
 const raw = await ghApi(
  token,
  [
   `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`,
  ],
  `find PR for ${branch}`,
 );
 const list = Array.isArray(raw) ? raw : [];
 if (list.length === 0) return null;
 const prs = list.map(toChangeRequest).sort((a, b) => b.iid - a.iid);
 return prs[0];
}

/** Full PR state, including mergeability (list responses omit it). */
export async function getPr(
 repo: string,
 number: number,
 token: string,
): Promise<ChangeRequest> {
 return toChangeRequest(
  await ghApi(token, [`repos/${repo}/pulls/${number}`], `read PR #${number}`),
 );
}

export async function createDraftPr(
 repo: string,
 pr: { head: string; base: string; title: string; body: string },
 token: string,
): Promise<ChangeRequest> {
 return toChangeRequest(
  await ghApi(
   token,
   [
    `repos/${repo}/pulls`,
    "--method",
    "POST",
    "-f",
    `head=${pr.head}`,
    "-f",
    `base=${pr.base}`,
    "-f",
    `title=${pr.title}`,
    "-f",
    `body=${pr.body}`,
    "-F",
    "draft=true",
   ],
   `open draft PR for ${pr.head}`,
  ),
 );
}

export async function updatePrBody(
 repo: string,
 number: number,
 body: string,
 token: string,
): Promise<void> {
 await ghApi(
  token,
  [`repos/${repo}/pulls/${number}`, "--method", "PATCH", "-f", `body=${body}`],
  `update PR #${number} body`,
 );
}

/** Mark a draft ready for review (REST has no verb for it; GraphQL does). */
export async function markReady(
 repo: string,
 pr: ChangeRequest,
 token: string,
): Promise<void> {
 if (!pr.draft) return;
 const raw = (await ghApi(
  token,
  [`repos/${repo}/pulls/${pr.iid}`, "--jq", "{node_id: .node_id}"],
  `read PR #${pr.iid} node id`,
 )) as { node_id?: string } | null;
 const nodeId = raw?.node_id;
 if (typeof nodeId !== "string" || nodeId.length === 0) {
  throw new GitHubError(`PR #${pr.iid} has no node id`);
 }
 await ghApi(
  token,
  [
   "graphql",
   "-f",
   "query=mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
   "-f",
   `id=${nodeId}`,
  ],
  `mark PR #${pr.iid} ready`,
 );
}

/** The squash commit title ranger sends — the exact text the merge desk guards (node #128). */
export function squashTitle(title: string, number: number): string {
 return `${title} (#${number})`;
}

/**
 * Squash-merge a PR, pinned to the head SHA the gate passed: GitHub refuses
 * the merge if the head moved in between (409), so ranger never merges a
 * commit its gate did not see.
 */
export async function mergePr(
 repo: string,
 number: number,
 sha: string,
 title: string,
 token: string,
): Promise<void> {
 await ghApi(
  token,
  [
   `repos/${repo}/pulls/${number}/merge`,
   "--method",
   "PUT",
   "-f",
   "merge_method=squash",
   "-f",
   `sha=${sha}`,
   "-f",
   `commit_title=${squashTitle(title, number)}`,
  ],
  `merge PR #${number}`,
 );
}

export async function issueLabels(
 repo: string,
 number: number,
 token: string,
): Promise<string[]> {
 const raw = await ghApi(
  token,
  [`repos/${repo}/issues/${number}/labels?per_page=100`],
  `labels of #${number}`,
 );
 return (Array.isArray(raw) ? raw : []).map((l) =>
  String((l as Record<string, unknown>).name ?? ""),
 );
}

export async function checkRunsFor(
 repo: string,
 sha: string,
 token: string,
): Promise<CheckRun[]> {
 const pages = (await ghApi(
  token,
  [`repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`, "--paginate", "--slurp"],
  `check runs for ${sha.slice(0, 8)}`,
 )) as { check_runs: unknown[] }[];
 if (!Array.isArray(pages) || pages.some((p) => !Array.isArray(p.check_runs))) {
  throw new GitHubError("invalid check runs response");
 }
 return pages.flatMap((p) => p.check_runs).map((c) => {
  const r = c as Record<string, unknown>;
  return {
   id: Number(r.id),
   name: String(r.name ?? ""),
   status: String(r.status ?? ""),
   conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
  };
 });
}

/** Workflow runs expose queued workflows before their job check runs exist. */
export async function workflowRunsFor(repo: string, sha: string, token: string): Promise<WorkflowRun[]> {
 const pages = await ghApi(token,
  [`repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`, "--paginate", "--slurp"],
  `workflow runs for ${sha.slice(0, 8)}`,
 ) as { total_count: number; workflow_runs: Record<string, unknown>[] }[];
 if (!Array.isArray(pages) || pages.some((p) => !Array.isArray(p.workflow_runs) || !Number.isSafeInteger(p.total_count) || p.total_count >= 1000)) {
  throw new GitHubError("invalid or search-limited workflow runs response");
 }
 const latest = new Map<string, WorkflowRun>();
 for (const r of pages.flatMap((p) => p.workflow_runs)) {
  if (r.head_sha !== sha) throw new GitHubError("workflow head differs from requested SHA");
  const run: WorkflowRun = {
   id: Number(r.id), name: String(r.name ?? ""), status: String(r.status ?? ""),
   conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
   workflowId: Number(r.workflow_id), event: String(r.event ?? ""), attempt: Number(r.run_attempt),
  };
  const key = `${run.workflowId}:${run.event}`;
  if (!latest.has(key) || latest.get(key)!.id < run.id) latest.set(key, run);
 }
 return [...latest.values()];
}

/** Combined status pages contain the current status of each external CI context. */
export async function commitStatusesFor(repo: string, sha: string, token: string): Promise<CommitStatus[]> {
 const pages = await ghApi(token,
  [`repos/${repo}/commits/${sha}/status?per_page=100`, "--paginate", "--slurp"],
  `commit statuses for ${sha.slice(0, 8)}`,
 ) as { statuses: Record<string, unknown>[] }[];
 if (!Array.isArray(pages) || pages.some((p) => !Array.isArray(p.statuses))) {
  throw new GitHubError("invalid commit statuses response");
 }
 return pages.flatMap((p) => p.statuses).map((s) => ({
  id: Number(s.id), context: String(s.context ?? ""), state: String(s.state ?? ""),
 }));
}

export async function postComment(
 repo: string,
 number: number,
 body: string,
 token: string,
): Promise<number> {
 const raw = (await ghApi(
  token,
  [`repos/${repo}/issues/${number}/comments`, "--method", "POST", "-f", `body=${body}`],
  `comment on #${number}`,
 )) as { id?: number } | null;
 return Number(raw?.id ?? 0);
}

export async function listComments(
 repo: string,
 number: number,
 token: string,
): Promise<IssueComment[]> {
 const raw = await ghApi(
  token,
  [`repos/${repo}/issues/${number}/comments?per_page=100`],
  `list comments on #${number}`,
 );
 return (Array.isArray(raw) ? raw : []).map((c) => {
  const r = c as Record<string, unknown>;
  const user = (r.user ?? {}) as Record<string, unknown>;
  return {
   id: Number(r.id),
   author: String(user.login ?? ""),
   body: String(r.body ?? ""),
  };
 });
}

/** Existing GitHub gate semantics: named non-conflict states were allowed. */
export function githubMergeState(mergeable: unknown, state: unknown): MergeState {
 if (mergeable === false || state === "dirty") return "conflict";
 // New API states must never silently become mergeable, even while computing.
 if (!["clean", "blocked", "unstable", "behind", "draft", "unknown", "has_hooks"].includes(String(state ?? "unknown"))) return "unknown";
 if (typeof mergeable !== "boolean" || state === "unknown" || state == null) return "pending";
 return "mergeable";
}

export async function ciVerdictFor(repo: string, sha: string, token: string, purpose: CiPurpose = "merge"): Promise<CiVerdict> {
 if (purpose !== "research") return githubCiVerdict(repo, await checkRunsFor(repo, sha, token), purpose);
 const [runs, workflows, statuses] = await Promise.all([
  checkRunsFor(repo, sha, token), workflowRunsFor(repo, sha, token), commitStatusesFor(repo, sha, token),
 ]);
 return githubCiVerdict(repo, runs, purpose, workflows, statuses);
}
