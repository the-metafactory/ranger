import type { ChangeRequest, CiPurpose, CiVerdict, ForgePort, ForgeReadPort, IssueComment, MergeOutcome, MergeState, RebaseOutcome } from "./forge.ts";
import type { RangerConfig } from "./config.ts";
import { parseForgeRef } from "./forge-ref.ts";
import { runCmd } from "./exec.ts";
import { parseGlabResponse } from "./glab-transport.ts";
import { assertReadOnlyToken, GateError, gitlabApiRead, tokenBatch, type ResolvedToken } from "./token-gate.ts";
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
/** `squash=true` is honoured under these project settings; `never` ignores it. */
const SQUASH_ALLOWED = new Set(["always", "default_on", "default_off"]);

/** Forge text surfaced to operators: one line, bounded. */
function bounded(text: string): string {
 const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
 return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

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

 /** The project's squash policy (`GET projects/:id`); only `never` refuses, an unknown value fails closed. */
 async squashRefusal(repo: string, token: ResolvedToken): Promise<string | null> {
  const endpoint = this.project(repo);
  const option = object((await this.read(repo, token, endpoint)).body, endpoint).squash_option;
  if (option === "never") return `${repo} has squash_option "never": ranger merges only squashed, so it will not merge here`;
  if (typeof option !== "string" || !SQUASH_ALLOWED.has(option)) invalid(endpoint, "squash_option");
  return null;
 }

 /** Whether GitLab is still rebasing the MR, the error a finished rebase left, and the head now. */
 async rebaseState(repo: string, n: number, token: ResolvedToken): Promise<{ inProgress: boolean; mergeError: string | null; headSha: string }> {
  const endpoint = `${this.project(repo)}/merge_requests/${id(n, repo, "iid")}?include_rebase_in_progress=true`;
  const r = object((await this.read(repo, token, endpoint)).body, endpoint);
  if (id(r.iid, endpoint, "iid") !== n) invalid(endpoint, "iid differs from requested MR");
  if (typeof r.rebase_in_progress !== "boolean") invalid(endpoint, "rebase_in_progress");
  const mergeError = r.merge_error === null || r.merge_error === undefined || r.merge_error === "" ? null : r.merge_error;
  if (mergeError !== null && typeof mergeError !== "string") invalid(endpoint, "merge_error");
  return { inProgress: r.rebase_in_progress, mergeError: mergeError === null ? null : bounded(mergeError), headSha: string(r.sha, endpoint, "sha") };
 }
}

/** Write failures never echo subprocess output or retry an uncertain mutation. */
export class GitLabWriteError extends Error {
 override readonly name = "GitLabWriteError";
 constructor(message: string, readonly endpoint: string, readonly status?: number) {
  super(`${endpoint}: ${message}`);
 }
}

/**
 * How long `rebaseAndWait` polls `rebase_in_progress` before it reports
 * pending. Kept short: the desk re-reads the head next pass anyway, and a
 * long wait holds up every later row in this one.
 */
export interface RebaseWait {
 polls: number;
 intervalMs: number;
 sleep: (ms: number) => Promise<void>;
}
const REBASE_WAIT: RebaseWait = { polls: 2, intervalMs: 1_500, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** An HTTP success status. */
const ok = (status: number): boolean => status >= 200 && status < 300;

/**
 * Rebase-request statuses that are GitLab declining (no push access, the
 * request refused or unprocessable): the row parks. Any other non-success
 * status is a fault and throws.
 */
const REBASE_REFUSED = [403, 405, 422];

/** GitLab's own `message` from an error response, bounded; never subprocess output. */
function forgeMessage(body: unknown, status: number): string {
 const message = body !== null && typeof body === "object" ? (body as Record<string, unknown>).message : undefined;
 const text = typeof message === "string" ? message : message === undefined ? "" : JSON.stringify(message);
 return text.length > 0 ? `HTTP ${status}: ${bounded(text)}` : `HTTP ${status}`;
}

/** GitLab forge operations: MR writes, the squash merge at the gated head, and the rebase it may ask for first. */
export class GitLabPort extends GitLabReadPort implements ForgePort<ResolvedToken> {
 constructor(
  private readonly config: RangerConfig,
  runner: typeof runCmd = runCmd,
  private readonly env: NodeJS.ProcessEnv = process.env,
  private readonly wait: RebaseWait = REBASE_WAIT,
 ) { super(runner); }

 private mrEndpoint(repo: string, n: number): string {
  return `${this.project(repo)}/merge_requests/${id(n, repo, "iid")}`;
 }

 private async send(repo: string, token: string, endpoint: string, method: "POST" | "PUT", fields: string[]) {
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
  return { code: result.code, ...parseGlabResponse(result) };
 }

 private async write(repo: string, token: string, endpoint: string, method: "POST" | "PUT", fields: string[]): Promise<unknown> {
  const { code, status, body } = await this.send(repo, token, endpoint, method, fields);
  if (code !== 0) throw new GitLabWriteError(`write failed (exit ${code})`, endpoint);
  if (!ok(status)) {
   throw new GitLabWriteError(`write failed (exit ${code})`, endpoint, status);
  }
  return body;
 }

 /**
  * A write whose HTTP refusals are answers, not faults. glab exits nonzero on
  * an HTTP error but still prints the status line, so the status decides; a
  * missing status or a nonzero exit on a success status stays a fault.
  */
 private async answer(repo: string, token: string, endpoint: string, fields: string[]): Promise<{ status: number; body: unknown }> {
  const { code, status, body } = await this.send(repo, token, endpoint, "PUT", fields);
  if (status === 0 || (code !== 0 && status < 400)) throw new GitLabWriteError(`write failed (exit ${code})`, endpoint, status || undefined);
  return { status, body };
 }

 /**
  * Squash-merge pinned to the gated head (ranger issue #97 ruling Q4: the
  * project keeps `rebase_merge`, ranger passes `squash=true`). A 409 is GitLab
  * saying the head is no longer `sha`; 405/406/422 is GitLab declining.
  */
 async mergePr(repo: string, n: number, sha: string, title: string, token: string): Promise<MergeOutcome> {
  const endpoint = `${this.mrEndpoint(repo, n)}/merge`;
  string(sha, endpoint, "gated head SHA");
  const { status, body } = await this.answer(repo, token, endpoint, [
   "-F", "squash=true", "-f", `sha=${sha}`, "-f", `squash_commit_message=${title} (!${n})`,
  ]);
  if (status === 409) return { status: "head-moved", reason: `!${n} is no longer at ${sha.slice(0, 8)} (${forgeMessage(body, status)})` };
  if ([405, 406, 422].includes(status)) return { status: "not-mergeable", reason: `GitLab declined to merge !${n}: ${forgeMessage(body, status)}` };
  if (!ok(status)) throw new GitLabWriteError(`merge failed (${forgeMessage(body, status)})`, endpoint, status);
  return this.decodeWrite(endpoint, () => {
   const r = object(body, endpoint);
   if (r.state !== "merged") invalid(endpoint, "state");
   // The merge happened; a squash GitLab did not honour is escalated, not hidden.
   if (r.squash !== true) return { status: "merged", unsquashed: `GitLab merged !${n} without squashing (squash=${String(r.squash)}): check the project's squash option` };
   return { status: "merged" };
  });
 }

 /**
  * Ask GitLab to rebase the MR's source branch onto its target, then poll
  * `rebase_in_progress` (read credential) a bounded number of times. Never
  * merges: a finished rebase moves the head, which the merge gate must see.
  */
 async rebaseAndWait(repo: string, n: number, token: { read: ResolvedToken; write: string }): Promise<RebaseOutcome> {
  const endpoint = `${this.mrEndpoint(repo, n)}/rebase`;
  // A rebase an earlier pass started is waited on, never requested again.
  const before = await this.rebaseState(repo, n, token.read);
  const requested = !before.inProgress;
  if (requested) {
   const { status, body } = await this.answer(repo, token.write, endpoint, []);
   // 409: GitLab could not enqueue the rebase yet ("try again later").
   if (status === 409) return { status: "pending", reason: `GitLab did not start the rebase of !${n} yet: ${forgeMessage(body, status)}`, requested };
   if (REBASE_REFUSED.includes(status)) return { status: "not-mergeable", reason: `GitLab declined to rebase !${n}: ${forgeMessage(body, status)}` };
   // Anything else (a 5xx, a 429, a revoked token) is a fault: the desk records it and retries next pass.
   if (!ok(status)) throw new GitLabWriteError(`rebase request failed (${forgeMessage(body, status)})`, endpoint, status);
  }
  for (let poll = 0; poll < this.wait.polls; poll++) {
   await this.wait.sleep(this.wait.intervalMs);
   const state = await this.rebaseState(repo, n, token.read);
   if (state.inProgress) continue;
   // A moved head is the rebase landing; a merge_error left from an earlier attempt does not undo it.
   if (state.headSha === before.headSha) {
    if (state.mergeError !== null) return { status: "not-mergeable", reason: `GitLab could not rebase !${n}: ${state.mergeError}` };
    return { status: "pending", reason: `GitLab finished rebasing !${n} but the head is still ${before.headSha.slice(0, 8)}`, requested };
   }
   return { status: "head-moved", headSha: state.headSha, requested };
  }
  return { status: "pending", reason: `GitLab is still rebasing !${n} after ${this.wait.polls} checks`, requested };
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

/**
 * The GitLab port in the shape the supervisor lanes hold: one string
 * credential per call, the machine write token. Writes pass it through to
 * the write gate; reads ignore it and use the map's read-only credential,
 * gated once per adapter. Make one per desk pass, never a long-lived one:
 * the read gate must see a token revoked or re-scoped since.
 */
export function gitlabForgePort(
 config: RangerConfig,
 opts: { runner?: typeof runCmd; env?: NodeJS.ProcessEnv; wait?: RebaseWait } = {},
): ForgePort {
 const env = opts.env ?? process.env;
 const runner = opts.runner ?? runCmd;
 const port = new GitLabPort(config, runner, env, opts.wait);
 const read = tokenBatch(config, (c, repo) => assertReadOnlyToken(c, repo, env, runner));
 return {
  findPrByHead: async (repo, branch) => port.findPrByHead(repo, branch, await read(repo)),
  getPr: async (repo, n) => port.getPr(repo, n, await read(repo)),
  ciVerdictFor: async (repo, sha, _token, purpose) => port.ciVerdictFor(repo, sha, await read(repo), purpose),
  issueLabels: async (repo, issue) => port.issueLabels(repo, issue, await read(repo)),
  listComments: async (repo, n) => port.listComments(repo, n, await read(repo)),
  squashRefusal: async (repo) => port.squashRefusal(repo, await read(repo)),
  createDraftPr: (repo, pr, token) => port.createDraftPr(repo, pr, token),
  updatePrBody: (repo, n, body, token) => port.updatePrBody(repo, n, body, token),
  markReady: (repo, pr, token) => port.markReady(repo, pr, token),
  postComment: (repo, n, body, token) => port.postComment(repo, n, body, token),
  mergePr: (repo, n, sha, title, token) => port.mergePr(repo, n, sha, title, token),
  rebasePr: async (repo, n, token) => port.rebaseAndWait(repo, n, { read: await read(repo), write: token }),
 };
}
