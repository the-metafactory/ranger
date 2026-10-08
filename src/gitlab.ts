import type { ChangeRequest, CiPurpose, CiVerdict, ForgePort, ForgeReadPort, IssueComment, MergeState } from "./forge.ts";
import type { RangerConfig } from "./config.ts";
import { parseForgeRef } from "./forge-ref.ts";
import { runCmd } from "./exec.ts";
import { parseGlabResponse } from "./glab-transport.ts";
import { GateError, gitlabApiRead, type ResolvedToken } from "./token-gate.ts";
import { assertWriteIdentity, gitlabApiWrite, resolveWriteToken, WriteGateError } from "./identity.ts";

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
const MR_STATE: Record<string, ChangeRequest["state"]> = { opened: "open", closed: "closed", merged: "merged", locked: "closed" };
const DRAFT_PREFIX = "Draft: ";

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

function changeRequest(raw: unknown, endpoint: string): { mr: ChangeRequest; sameProject: boolean } {
 const r = object(raw, endpoint);
 const state = string(r.state, endpoint, "state");
 if (!Object.hasOwn(MR_STATE, state)) invalid(endpoint, "state");
 if (typeof r.draft !== "boolean") invalid(endpoint, "draft");
 const detail = string(r.detailed_merge_status, endpoint, "detailed_merge_status");
 return {
  sameProject: id(r.source_project_id, endpoint, "source_project_id") === id(r.target_project_id, endpoint, "target_project_id"),
  mr: {
   iid: id(r.iid, endpoint, "iid"),
   state: MR_STATE[state]!,
   draft: r.draft,
   headRef: string(r.source_branch, endpoint, "source_branch"),
   headSha: string(r.sha, endpoint, "sha"),
   baseRef: string(r.target_branch, endpoint, "target_branch"),
   mergeState: gitlabMergeState(detail),
   mergeDetail: detail,
   webUrl: string(r.web_url, endpoint, "web_url"),
   author: username(r.author, endpoint, "author"),
   title: string(r.title, endpoint, "title"),
   mergeCommitSha: nullableString(r.merge_commit_sha, endpoint, "merge_commit_sha"),
   mergedBy: r.merge_user === null ? null : username(r.merge_user, endpoint, "merge_user"),
   // `locked` reads closed by contract, but the MR is mid-merge, not abandoned.
   ...(state === "locked" ? { mergeInProgress: true as const } : {}),
  },
 };
}

function pipeline(raw: unknown, endpoint: string): { id: number; source: string; sha: string; status: string; url: string } {
 const r = object(raw, endpoint);
 return {
  id: id(r.id, endpoint, "pipeline.id"),
  source: string(r.source, endpoint, "pipeline.source"),
  sha: string(r.sha, endpoint, "pipeline.sha"),
  status: string(r.status, endpoint, "pipeline.status"),
  url: string(r.web_url, endpoint, "pipeline.web_url"),
 };
}

function nextPage(next: string | undefined, page: number, endpoint: string): number | null {
 // Row counts prove nothing: GitLab can filter some lists (notes) after paginating,
 // so a short page can sit mid-collection. Only an empty X-Next-Page ends a read.
 if (next === "") return null;
 // Follow numeric pages only, never a server-provided URL or a backward loop.
 const following = Number(next);
 if (next === undefined || !/^\d+$/.test(next) || !Number.isSafeInteger(following) || following <= page) invalid(endpoint, "X-Next-Page");
 return following;
}

/** Read half of the forge port, usable without write configuration. */
export class GitLabReadPort implements ForgeReadPort<ResolvedToken> {
 constructor(protected readonly runner: typeof runCmd = runCmd) {}

 protected project(repo: string): string {
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
  const { status, body, headers } = parseGlabResponse(result);
  if (result.code !== 0 || status !== 200) throw new GitLabReadError(`read failed (exit ${result.code})`, endpoint, status);
  if (body === undefined) invalid(endpoint, "JSON body");
  return { body, next: headers["x-next-page"] };
 }

 private async *pages(repo: string, token: ResolvedToken, endpoint: string): AsyncGenerator<{ endpoint: string; rows: unknown[] }> {
  let page = 1;
  while (true) {
   const path = `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
   const { body, next } = await this.read(repo, token, path);
   if (!Array.isArray(body)) invalid(path, "array");
   const following = nextPage(next, page, path);
   yield { endpoint: path, rows: body };
   if (following === null) return;
   page = following;
  }
 }

 async findPrByHead(repo: string, branch: string, token: ResolvedToken): Promise<ChangeRequest | null> {
  string(branch, repo, "source branch");
  let newest: ChangeRequest | null = null;
  const endpoint = `${this.project(repo)}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all`;
  for await (const page of this.pages(repo, token, endpoint)) {
   for (const raw of page.rows) {
    const { mr, sameProject } = changeRequest(raw, page.endpoint);
    if (mr.headRef !== branch) invalid(page.endpoint, "source_branch differs from requested branch");
    if (!sameProject) continue;
    if (newest === null || mr.iid > newest.iid) newest = mr;
   }
  }
  return newest;
 }

 async getPr(repo: string, n: number, token: ResolvedToken): Promise<ChangeRequest> {
  const endpoint = `${this.project(repo)}/merge_requests/${id(n, repo, "iid")}`;
  const { mr, sameProject } = changeRequest((await this.read(repo, token, endpoint)).body, endpoint);
  if (!sameProject) invalid(endpoint, "source_project_id differs from target_project_id (fork MR)");
  if (mr.iid !== n) invalid(endpoint, "iid differs from requested MR");
  return mr;
 }

 async ciVerdictFor(repo: string, sha: string, token: ResolvedToken, _purpose?: CiPurpose): Promise<CiVerdict> {
  string(sha, repo, "head SHA");
  const endpoint = `${this.project(repo)}/pipelines?sha=${encodeURIComponent(sha)}&order_by=id&sort=desc`;
  let latest: ReturnType<typeof pipeline> | undefined;
  for await (const page of this.pages(repo, token, endpoint)) {
   for (const raw of page.rows) {
    const row = pipeline(raw, page.endpoint);
    if (row.sha !== sha) invalid(page.endpoint, "pipeline.sha differs from requested head");
    if (!["push", "merge_request_event"].includes(row.source)) continue;
    if (latest === undefined || row.id > latest.id) latest = row;
   }
   // The API orders ids descending, so later pages cannot supersede this page.
   if (latest !== undefined) break;
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

 /** MR notes: GitLab issue and MR iids are separate namespaces, so this never reads issue notes. */
 async listComments(repo: string, changeRequest: number, token: ResolvedToken): Promise<IssueComment[]> {
  const endpoint = `${this.project(repo)}/merge_requests/${id(changeRequest, repo, "iid")}/notes?order_by=created_at&sort=asc`;
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

 async issueLabels(repo: string, issue: number, token: ResolvedToken): Promise<string[]> {
  const endpoint = `${this.project(repo)}/issues/${id(issue, repo, "iid")}`;
  const r = object((await this.read(repo, token, endpoint)).body, endpoint);
  if (id(r.iid, endpoint, "iid") !== issue) invalid(endpoint, "iid differs from requested issue");
  if (!Array.isArray(r.labels) || r.labels.some(label => typeof label !== "string")) invalid(endpoint, "labels");
  return r.labels;
 }
}

/** Write failures never echo subprocess output or retry an uncertain mutation. */
export class GitLabWriteError extends Error {
 override readonly name = "GitLabWriteError";
 constructor(message: string, readonly endpoint: string, readonly status?: number) {
  super(`${endpoint}: ${message}`);
 }
}

/** GitLab forge operations; merge/rebase are supplied by their separate node. */
export class GitLabPort extends GitLabReadPort implements Omit<ForgePort<ResolvedToken>, "mergePr"> {
 constructor(
  private readonly config: RangerConfig,
  runner: typeof runCmd = runCmd,
  private readonly env: NodeJS.ProcessEnv = process.env,
 ) { super(runner); }

 private mrEndpoint(repo: string, n: number): string {
  return `${this.project(repo)}/merge_requests/${id(n, repo, "iid")}`;
 }

 private async write(repo: string, token: string, endpoint: string, method: "POST" | "PUT", fields: string[]): Promise<unknown> {
  // Validate the exact credential used below, not merely another token from config.
  const credential = resolveWriteToken(this.config, repo, this.env);
  if (token !== credential.token) throw new WriteGateError("GitLab write credential differs from the configured machine credential");
  await assertWriteIdentity(this.config, repo, this.env, this.runner);
  let result;
  try {
   result = await gitlabApiWrite(repo, token, [endpoint, "--method", method, "--include", ...fields], this.runner, { env: this.env });
  } catch (error) {
   if (error instanceof WriteGateError) throw error;
   throw new GitLabWriteError("write transport failed", endpoint);
  }
  if (result.code !== 0) throw new GitLabWriteError(`write failed (exit ${result.code})`, endpoint);
  const { status, body } = parseGlabResponse(result);
  if (status < 200 || status >= 300) {
   throw new GitLabWriteError(`write failed (exit ${result.code})`, endpoint, status);
  }
  return body;
 }

 private decodeWrite<T>(endpoint: string, decode: () => T): T {
  try { return decode(); }
  catch (error) {
   if (!(error instanceof GitLabReadError)) throw error;
   throw new GitLabWriteError("invalid write response", endpoint);
  }
 }

 async createDraftPr(repo: string, pr: { head: string; base: string; title: string; body: string }, token: string): Promise<ChangeRequest> {
  const endpoint = `${this.project(repo)}/merge_requests`;
  const title = pr.title.startsWith(DRAFT_PREFIX) ? pr.title : `${DRAFT_PREFIX}${pr.title}`;
  const raw = await this.write(repo, token, endpoint, "POST", [
   "-f", `source_branch=${pr.head}`, "-f", `target_branch=${pr.base}`, "-f", `title=${title}`,
   "-f", `description=${pr.body}`, "-F", "remove_source_branch=false",
  ]);
  return this.decodeWrite(endpoint, () => {
   const { mr, sameProject } = changeRequest(raw, endpoint);
   if (!sameProject) invalid(endpoint, "source_project_id differs from target_project_id (fork MR)");
   return mr;
  });
 }

 async updatePrBody(repo: string, n: number, body: string, token: string): Promise<void> {
  const endpoint = this.mrEndpoint(repo, n);
  await this.write(repo, token, endpoint, "PUT", ["-f", `description=${body}`]);
 }

 async markReady(repo: string, pr: ChangeRequest, token: string): Promise<void> {
  if (!pr.title.startsWith(DRAFT_PREFIX)) {
   if (pr.draft) throw new GitLabWriteError("draft title lacks the supported Draft prefix", this.mrEndpoint(repo, pr.iid));
   return;
  }
  const endpoint = this.mrEndpoint(repo, pr.iid);
  await this.write(repo, token, endpoint, "PUT", ["-f", `title=${pr.title.slice(DRAFT_PREFIX.length)}`]);
 }

 async postComment(repo: string, n: number, body: string, token: string): Promise<number> {
  const endpoint = `${this.mrEndpoint(repo, n)}/notes`;
  const raw = await this.write(repo, token, endpoint, "POST", ["-f", `body=${body}`]);
  return this.decodeWrite(endpoint, () => id(object(raw, endpoint).id, endpoint, "note.id"));
 }
}
