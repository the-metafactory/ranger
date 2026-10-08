import type { ChangeRequest, CiPurpose, CiVerdict, ForgeReadPort, IssueComment, MergeState } from "./forge.ts";
import { parseForgeRef } from "./forge-ref.ts";
import { runCmd } from "./exec.ts";
import { GateError, gitlabApiRead, parseGlabResponse, type ResolvedToken } from "./token-gate.ts";

/** Transport and schema failures never become a passing gate value. */
export class GitLabReadError extends Error {
 override readonly name = "GitLabReadError";
 constructor(message: string, readonly endpoint: string, readonly status?: number) {
  super(`${endpoint}: ${message}`);
 }
}

const PENDING = new Set(["checking", "unchecked", "preparing", "approvals_syncing", "ci_still_running", "ci_must_pass"]);
const BLOCKED = new Set([
 "not_approved", "discussions_not_resolved", "draft_status", "blocked_status", "not_open", "requested_changes",
 "status_checks_must_pass", "merge_request_blocked", "locked_paths", "locked_lfs_files", "security_policy_violations",
 "title_regex", "commits_status", "jira_association_missing",
]);

export function gitlabMergeState(status: string): MergeState {
 if (status === "mergeable") return "mergeable";
 if (status === "conflict") return "conflict";
 if (status === "need_rebase") return "needs-rebase";
 if (PENDING.has(status)) return "pending";
 if (BLOCKED.has(status)) return "blocked";
 return "unknown";
}

function invalid(endpoint: string, field: string): never {
 throw new GitLabReadError(`missing or invalid ${field}`, endpoint);
}
function object(raw: unknown, endpoint: string): Record<string, unknown> {
 if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid(endpoint, "object");
 return raw as Record<string, unknown>;
}
function string(raw: unknown, endpoint: string, field: string): string {
 if (typeof raw !== "string" || raw.length === 0) invalid(endpoint, field);
 return raw;
}
function id(raw: unknown, endpoint: string, field: string): number {
 if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) invalid(endpoint, field);
 return raw;
}
function username(raw: unknown, endpoint: string, field: string): string {
 return string(object(raw, endpoint).username, endpoint, `${field}.username`);
}
function nullableString(raw: unknown, endpoint: string, field: string): string | null {
 return raw === null ? null : string(raw, endpoint, field);
}

function changeRequest(raw: unknown, endpoint: string): ChangeRequest {
 const r = object(raw, endpoint);
 const state = string(r.state, endpoint, "state");
 if (!["opened", "closed", "merged", "locked"].includes(state)) invalid(endpoint, "state");
 if (typeof r.draft !== "boolean") invalid(endpoint, "draft");
 const detail = string(r.detailed_merge_status, endpoint, "detailed_merge_status");
 return {
  iid: id(r.iid, endpoint, "iid"), state: state === "opened" ? "open" : state === "merged" ? "merged" : "closed",
  draft: r.draft, headRef: string(r.source_branch, endpoint, "source_branch"), headSha: string(r.sha, endpoint, "sha"),
  baseRef: string(r.target_branch, endpoint, "target_branch"), mergeState: gitlabMergeState(detail), mergeDetail: detail,
  webUrl: string(r.web_url, endpoint, "web_url"), author: username(r.author, endpoint, "author"),
  title: string(r.title, endpoint, "title"), mergeCommitSha: nullableString(r.merge_commit_sha, endpoint, "merge_commit_sha"),
  mergedBy: r.merge_user === null ? null : username(r.merge_user, endpoint, "merge_user"),
 };
}

/** Read half of the forge port; writes and lane routing belong to later nodes. */
export class GitLabReadPort implements ForgeReadPort<ResolvedToken> {
 constructor(private readonly runner: typeof runCmd = runCmd) {}

 private project(repo: string): string {
  const ref = parseForgeRef(repo);
  if (ref.forge !== "gitlab") throw new GitLabReadError("expected a GitLab repo", repo);
  return `projects/${encodeURIComponent(ref.path)}`;
 }

 private async read(repo: string, token: ResolvedToken, endpoint: string): Promise<{ body: unknown; next: string | undefined }> {
  let result;
  try {
   result = await gitlabApiRead(repo, token, endpoint, this.runner);
  } catch (error) {
   if (error instanceof GateError) throw error;
   // A subprocess error can contain credentials; keep it outside diagnostics.
   throw new GitLabReadError("read transport failed", endpoint);
  }
  const { status, body } = parseGlabResponse(result);
  if (result.code !== 0 || status !== 200) throw new GitLabReadError(`read failed (exit ${result.code})`, endpoint, status);
  if (body === undefined) invalid(endpoint, "JSON body");
  const headers = result.stdout.split(/\r?\n\r?\n/, 1)[0]!;
  const next = /^x-next-page:[ \t]*(.*)$/im.exec(headers)?.[1]?.trim();
  return { body, next };
 }

 private async *pages(repo: string, token: ResolvedToken, endpoint: string): AsyncGenerator<{ endpoint: string; rows: unknown[] }> {
  let page = 1;
  while (true) {
   const path = `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
   const { body, next } = await this.read(repo, token, path);
   if (!Array.isArray(body)) invalid(path, "array");
   yield { endpoint: path, rows: body };
   if (next === "" || (next === undefined && body.length < 100)) return;
   // Follow numeric pages only, never a server-provided URL or a backward loop.
   const following = next === undefined ? page + 1 : Number(next);
   if ((next !== undefined && !/^\d+$/.test(next)) || !Number.isSafeInteger(following) || following <= page) invalid(path, "X-Next-Page");
   page = following;
  }
 }

 async findPrByHead(repo: string, branch: string, token: ResolvedToken): Promise<ChangeRequest | null> {
  string(branch, repo, "source branch");
  let newest: ChangeRequest | null = null;
  const endpoint = `${this.project(repo)}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all`;
  for await (const page of this.pages(repo, token, endpoint)) {
   for (const raw of page.rows) {
    const mr = changeRequest(raw, page.endpoint);
    if (mr.headRef !== branch) invalid(page.endpoint, "source_branch differs from requested branch");
    if (newest === null || mr.iid > newest.iid) newest = mr;
   }
  }
  return newest;
 }

 async getPr(repo: string, n: number, token: ResolvedToken): Promise<ChangeRequest> {
  const endpoint = `${this.project(repo)}/merge_requests/${id(n, repo, "iid")}`;
  const mr = changeRequest((await this.read(repo, token, endpoint)).body, endpoint);
  if (mr.iid !== n) invalid(endpoint, "iid differs from requested MR");
  return mr;
 }

 async ciVerdictFor(repo: string, sha: string, token: ResolvedToken, _purpose?: CiPurpose): Promise<CiVerdict> {
  string(sha, repo, "head SHA");
  const endpoint = `${this.project(repo)}/pipelines?sha=${encodeURIComponent(sha)}&order_by=id&sort=desc`;
  let latest: { id: number; status: string; url: string } | undefined;
  for await (const page of this.pages(repo, token, endpoint)) {
   for (const raw of page.rows) {
    const r = object(raw, page.endpoint);
    const pipelineId = id(r.id, page.endpoint, "pipeline.id");
    const source = string(r.source, page.endpoint, "pipeline.source");
    const head = string(r.sha, page.endpoint, "pipeline.sha");
    const status = string(r.status, page.endpoint, "pipeline.status");
    const url = string(r.web_url, page.endpoint, "pipeline.web_url");
    if (head !== sha) invalid(page.endpoint, "pipeline.sha differs from requested head");
    if (!["push", "merge_request_event"].includes(source)) continue;
    if (latest === undefined || pipelineId > latest.id) latest = { id: pipelineId, status, url };
   }
  }
  if (latest === undefined) return { state: "pending", reason: "no push or merge_request_event pipeline on the head" };
  if (latest.status === "success") return {
   state: "green", runId: latest.id, runUrl: latest.url, runName: `pipeline ${latest.id}`, snapshot: `${latest.id}@${sha}`,
  };
  return {
   state: ["failed", "canceled"].includes(latest.status) ? "red" : "pending",
   reason: `pipeline ${latest.id}@${sha} is ${latest.status}`,
  };
 }

 async listComments(repo: string, n: number, token: ResolvedToken): Promise<IssueComment[]> {
  const endpoint = `${this.project(repo)}/merge_requests/${id(n, repo, "iid")}/notes`;
  const comments: IssueComment[] = [];
  for await (const page of this.pages(repo, token, endpoint)) {
   for (const raw of page.rows) {
    const r = object(raw, page.endpoint);
    if (typeof r.system !== "boolean") invalid(page.endpoint, "note.system");
    if (r.system) continue;
    if (typeof r.body !== "string") invalid(page.endpoint, "note.body");
    comments.push({ id: id(r.id, page.endpoint, "note.id"), author: username(r.author, page.endpoint, "note.author"), body: r.body });
   }
  }
  return comments;
 }

 async issueLabels(repo: string, n: number, token: ResolvedToken): Promise<string[]> {
  const endpoint = `${this.project(repo)}/issues/${id(n, repo, "iid")}`;
  const r = object((await this.read(repo, token, endpoint)).body, endpoint);
  if (!Array.isArray(r.labels) || r.labels.some(label => typeof label !== "string")) invalid(endpoint, "labels");
  return r.labels;
 }
}
