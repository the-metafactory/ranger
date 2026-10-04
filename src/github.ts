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

export interface PullRequest {
 number: number;
 state: "open" | "closed";
 merged: boolean;
 draft: boolean;
 title: string;
 headRef: string;
 headSha: string;
 baseRef: string;
 /** GitHub's mergeability; null while GitHub is still computing it. */
 mergeable: boolean | null;
 /** clean | dirty | blocked | unstable | behind | draft | unknown | has_hooks */
 mergeableState: string;
 mergeCommitSha: string | null;
 /** Who merged it (null while unmerged) — the receipt names the actual merger. */
 mergedBy: string | null;
 url: string;
 author: string;
}

export interface CheckRun {
 id: number;
 name: string;
 status: string;
 conclusion: string | null;
}

export interface IssueComment {
 id: number;
 author: string;
 body: string;
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

function toPullRequest(raw: unknown): PullRequest {
 const r = raw as Record<string, unknown>;
 const head = (r.head ?? {}) as Record<string, unknown>;
 const base = (r.base ?? {}) as Record<string, unknown>;
 const user = (r.user ?? {}) as Record<string, unknown>;
 const mergedBy = (r.merged_by ?? null) as Record<string, unknown> | null;
 return {
  number: Number(r.number),
  state: r.state === "closed" ? "closed" : "open",
  merged: r.merged === true || (typeof r.merged_at === "string" && r.merged_at.length > 0),
  draft: r.draft === true,
  title: String(r.title ?? ""),
  headRef: String(head.ref ?? ""),
  headSha: String(head.sha ?? ""),
  baseRef: String(base.ref ?? ""),
  mergeable: typeof r.mergeable === "boolean" ? r.mergeable : null,
  mergeableState: String(r.mergeable_state ?? "unknown"),
  mergeCommitSha:
   typeof r.merge_commit_sha === "string" ? r.merge_commit_sha : null,
  mergedBy: mergedBy === null ? null : String(mergedBy.login ?? ""),
  url: String(r.html_url ?? ""),
  author: String(user.login ?? ""),
 };
}

/** The newest PR (any state) whose head is `branch` in `repo` — the F2 resume anchor. */
export async function findPrByHead(
 repo: string,
 branch: string,
 token: string,
): Promise<PullRequest | null> {
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
 const prs = list.map(toPullRequest).sort((a, b) => b.number - a.number);
 return prs[0];
}

/** Full PR state, including mergeability (list responses omit it). */
export async function getPr(
 repo: string,
 number: number,
 token: string,
): Promise<PullRequest> {
 return toPullRequest(
  await ghApi(token, [`repos/${repo}/pulls/${number}`], `read PR #${number}`),
 );
}

export async function createDraftPr(
 repo: string,
 pr: { head: string; base: string; title: string; body: string },
 token: string,
): Promise<PullRequest> {
 return toPullRequest(
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
 pr: PullRequest,
 token: string,
): Promise<void> {
 if (!pr.draft) return;
 const raw = (await ghApi(
  token,
  [`repos/${repo}/pulls/${pr.number}`, "--jq", "{node_id: .node_id}"],
  `read PR #${pr.number} node id`,
 )) as { node_id?: string } | null;
 const nodeId = raw?.node_id;
 if (typeof nodeId !== "string" || nodeId.length === 0) {
  throw new GitHubError(`PR #${pr.number} has no node id`);
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
  `mark PR #${pr.number} ready`,
 );
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
   `commit_title=${title} (#${number})`,
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
 const raw = (await ghApi(
  token,
  [`repos/${repo}/commits/${sha}/check-runs?per_page=100`],
  `check runs for ${sha.slice(0, 8)}`,
 )) as { check_runs?: unknown[] } | null;
 return (raw?.check_runs ?? []).map((c) => {
  const r = c as Record<string, unknown>;
  return {
   id: Number(r.id),
   name: String(r.name ?? ""),
   status: String(r.status ?? ""),
   conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
  };
 });
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
