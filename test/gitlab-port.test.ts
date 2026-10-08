import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import fixture from "./fixtures/gitlab-reads.json";
import { GitLabReadError, GitLabReadPort, gitlabMergeState } from "../src/gitlab.ts";
import type { ForgeReadPort, MergeState } from "../src/forge.ts";
import { assertReadOnlyToken, GateError, type ResolvedToken } from "../src/token-gate.ts";
import type { RangerConfig } from "../src/config.ts";
import type { runCmd, RunResult } from "../src/exec.ts";

const host = "gitlab.example.test";
const repo = `gitlab:${host}/team/sub/project`;
const project = "projects/team%2Fsub%2Fproject";
const sha = fixture.mr.sha;
const config = { auth: { readOnlyTokens: { [`gitlab:${host}/`]: "READ_GL" } } } as unknown as RangerConfig;
const response = (body: unknown, next?: string, status = 200, code = status === 200 ? 0 : 1): RunResult => ({
 code, stderr: "", stdout: `HTTP/2.0 ${status} Response\r\nContent-Type: application/json\r\n${next === undefined ? "" : `X-Next-Page: ${next}\r\n`}\r\n${JSON.stringify(body)}`,
});
const mrPath = `${project}/merge_requests/7`;
const findPath = `${project}/merge_requests?source_branch=node%2F124%20%26%20fixtures&state=all&per_page=100&page=1`;
const pipelinePath = `${project}/pipelines?sha=${sha}&order_by=id&sort=desc&per_page=100&page=1`;
const notesPath = `${project}/merge_requests/7/notes?order_by=created_at&sort=asc&per_page=100&page=1`;
const issuePath = `${project}/issues/124`;

async function setup(read: (endpoint: string) => RunResult | Promise<RunResult>) {
 const dirs: string[] = [];
 const calls: string[] = [];
 const runner: typeof runCmd = async (bin, args, opts) => {
  expect(bin).toBe("glab");
  expect(args[0]).toBe("api");
  expect(args.slice(2)).toEqual(["--hostname", host, "--method", "GET", "--include"]);
  const dir = opts?.env?.GLAB_CONFIG_DIR!;
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "config.yml")).mode & 0o777).toBe(0o600);
  expect(parse(readFileSync(join(dir, "config.yml"), "utf8"))).toEqual({
   check_update: false, telemetry: false,
   hosts: { [host]: { token: "read-secret", api_host: host, api_protocol: "https" } },
  });
  expect(opts?.env?.SOMA_GRAPH_READONLY).toBe("1");
  expect(opts?.env?.GITLAB_TOKEN).toBeUndefined();
  expect(opts?.env?.GH_TOKEN).toBeUndefined();
  expect(dirs).not.toContain(dir);
  for (const old of dirs) expect(existsSync(old)).toBeFalse();
  dirs.push(dir);
  if (args[1] === "/personal_access_tokens/self") return response({ scopes: ["read_api"] });
  if (args[1] === "/projects/team%2Fsub%2Fproject") return response({ id: 1 });
  calls.push(args[1]);
  return read(args[1]);
 };
 const { token } = await assertReadOnlyToken(config, repo, { READ_GL: "read-secret" }, runner);
 const port: ForgeReadPort<ResolvedToken> = new GitLabReadPort(runner);
 return { port, token, calls, dirs };
}

describe("GitLab MR reads", () => {
 test("find reads all states with encoded branch and picks newest iid across pages", async () => {
  const { port, token, calls } = await setup(path => {
   if (path === findPath) return response([{ ...fixture.mr, iid: 2 }], "2");
   expect(path).toBe(findPath.replace("&page=1", "&page=2"));
   return response([fixture.mr], "");
  });
  expect(await port.findPrByHead(repo, fixture.mr.source_branch, token)).toEqual({
   iid: 7, state: "open", draft: false, headRef: fixture.mr.source_branch, headSha: sha, baseRef: "main",
   mergeState: "mergeable", mergeDetail: "mergeable", webUrl: fixture.mr.web_url,
   author: "ivy-bot", title: fixture.mr.title, mergeCommitSha: null, mergedBy: null,
  });
  expect(calls).toHaveLength(2);
 });
 test("a valid empty search is null", async () => {
  const { port, token } = await setup(() => response([]));
  expect(await port.findPrByHead(repo, fixture.mr.source_branch, token)).toBeNull();
 });
 test("same-named fork MR with a newer iid cannot replace the project's MR across pages", async () => {
  const { port, token, calls } = await setup(path => path === findPath
   ? response([fixture.mr], "2")
   : response([{ ...fixture.mr, iid: 99, source_project_id: 2, sha: "b".repeat(40) }], ""));
  expect(await port.findPrByHead(repo, fixture.mr.source_branch, token)).toMatchObject({ iid: 7, headSha: sha });
  expect(calls).toHaveLength(2);
 });
 test("fork-only search is null and direct fork MR reads are refused", async () => {
  const fork = { ...fixture.mr, source_project_id: 2 };
  const { port, token } = await setup(path => response(path === mrPath ? fork : [fork]));
  expect(await port.findPrByHead(repo, fixture.mr.source_branch, token)).toBeNull();
  await expect(port.getPr(repo, 7, token)).rejects.toBeInstanceOf(GitLabReadError);
 });
 test.each([ ["opened", "open"], ["closed", "closed"], ["merged", "merged"], ["locked", "closed"] ])("state %s maps to %s", async (state, expected) => {
  const { port, token } = await setup(path => {
   expect(path).toBe(mrPath);
   return response({ ...fixture.mr, state, merge_commit_sha: sha, merge_user: { username: "merge-bot" } });
  });
  const mr = await port.getPr(repo, 7, token);
  expect(mr).toMatchObject({ state: expected, headSha: sha, mergedBy: "merge-bot", mergeCommitSha: sha });
  expect(mr.mergeInProgress).toBe(state === "locked" ? true : undefined);
 });
 test.each(Object.keys(fixture.mr).filter(key => key !== "id"))("missing MR field %s throws on find and get", async field => {
  const raw: Record<string, unknown> = { ...fixture.mr };
  delete raw[field];
  const { port, token } = await setup(path => response(path === mrPath ? raw : [raw]));
  await expect(port.getPr(repo, 7, token)).rejects.toBeInstanceOf(GitLabReadError);
  await expect(port.findPrByHead(repo, fixture.mr.source_branch, token)).rejects.toBeInstanceOf(GitLabReadError);
 });
 test.each([{ iid: 8 }, { draft: "false" }, { state: "future-state" }, { author: {} }, { sha: null },
  { source_project_id: null }, { target_project_id: "1" }])("invalid or mismatched MR data %j throws", async patch => {
  const { port, token } = await setup(() => response({ ...fixture.mr, ...patch }));
  await expect(port.getPr(repo, 7, token)).rejects.toBeInstanceOf(GitLabReadError);
 });
});

describe("GitLab detailed merge status", () => {
 // Mirrors the detailed_merge_status table in node #124's acceptance criteria; keep it literal rather than
 // derived from the adapter. merge_time and external_status_checks are real GitLab values the table does not
 // list, so they fall under its "any other value → unknown" rule.
 const mappings = {
  mergeable: ["mergeable"], conflict: ["conflict"], "needs-rebase": ["need_rebase"],
  pending: ["checking", "unchecked", "preparing", "approvals_syncing", "ci_still_running", "ci_must_pass"],
  blocked: ["not_approved", "discussions_not_resolved", "draft_status", "blocked_status", "not_open", "requested_changes",
   "status_checks_must_pass", "merge_request_blocked", "locked_paths", "locked_lfs_files", "security_policy_violations",
   "title_regex", "commits_status", "jira_association_missing"], unknown: ["future-status", "broken_status", "merge_time", "external_status_checks"],
 };
 for (const [expected, values] of Object.entries(mappings) as [MergeState, string[]][]) {
  test.each(values)(`%s maps to ${expected} through get`, async value => {
   const { port, token } = await setup(() => response({ ...fixture.mr, detailed_merge_status: value }));
   expect(gitlabMergeState(value)).toBe(expected);
   expect((await port.getPr(repo, 7, token)).mergeState).toBe(expected);
  });
 }
});

describe("GitLab head pipeline trust", () => {
 test("external success is ignored and latest qualifying pipeline supplies citation for every purpose", async () => {
  const { port, token } = await setup(path => { expect(path).toBe(pipelinePath); return response(fixture.pipelines); });
  for (const purpose of ["merge", "close", "research"] as const) {
   expect(await port.ciVerdictFor(repo, sha, token, purpose)).toEqual({
    state: "green", runId: 30, runUrl: fixture.pipelines[1]!.web_url, runName: "pipeline 30", snapshot: `30@${sha}`,
   });
  }
 });
 for (const source of ["push", "merge_request_event"]) {
  for (const status of ["success", "failed", "canceled", "created", "waiting_for_resource", "preparing", "pending", "running", "manual", "skipped", "scheduled", "future"]) {
   test(`${source}/${status} overrides older success`, async () => {
    const { port, token } = await setup(() => response([
     { ...fixture.pipelines[1], source, status }, { ...fixture.pipelines[2], status: "success" },
    ]));
    expect((await port.ciVerdictFor(repo, sha, token)).state).toBe(status === "success" ? "green" : ["failed", "canceled"].includes(status) ? "red" : "pending");
   });
  }
 }
 test.each([[], [fixture.pipelines[0]], [{ ...fixture.pipelines[0], status: "failed" }], [{ ...fixture.pipelines[0], source: "web" }]].map(rows => ({ rows })))("no trusted pipeline is pending %j", async ({ rows }) => {
  const { port, token } = await setup(() => response(rows));
  expect((await port.ciVerdictFor(repo, sha, token)).state).toBe("pending");
 });
 test("qualifying pipeline beyond first external-only page counts", async () => {
  const { port, token, calls } = await setup(path => path === pipelinePath ? response([fixture.pipelines[0]], "2") : response([fixture.pipelines[1]], ""));
  expect(await port.ciVerdictFor(repo, sha, token)).toMatchObject({ state: "green", runId: 30 });
  expect(calls[1]).toBe(pipelinePath.replace("&page=1", "&page=2"));
 });
 test("stops after the first page containing a qualifying pipeline", async () => {
  const { port, token, calls } = await setup(path => {
   expect(path).toBe(pipelinePath);
   return response(fixture.pipelines, "2");
  });
  expect(await port.ciVerdictFor(repo, sha, token)).toMatchObject({ state: "green", runId: 30 });
  expect(calls).toHaveLength(1);
 });
 test("still validates the entire deciding page before returning green", async () => {
  const { port, token } = await setup(() => response([fixture.pipelines[1], { ...fixture.pipelines[2], sha: "b".repeat(40) }], "2"));
  await expect(port.ciVerdictFor(repo, sha, token)).rejects.toBeInstanceOf(GitLabReadError);
 });
 test.each(["id", "source", "status", "sha", "web_url"])("missing pipeline field %s throws", async field => {
  const raw: Record<string, unknown> = { ...fixture.pipelines[1] };
  delete raw[field];
  const { port, token } = await setup(() => response([raw]));
  await expect(port.ciVerdictFor(repo, sha, token)).rejects.toBeInstanceOf(GitLabReadError);
 });
 test("a success on another SHA is refused", async () => {
  const { port, token } = await setup(() => response([{ ...fixture.pipelines[1], sha: "b".repeat(40) }]));
  await expect(port.ciVerdictFor(repo, sha, token)).rejects.toBeInstanceOf(GitLabReadError);
 });
});

describe("GitLab notes and issue labels", () => {
 test("requests notes oldest-first across pages, drops system notes, uses username and keeps empty bodies", async () => {
  const { port, token, calls, dirs } = await setup(path => {
   if (path === notesPath) return response(fixture.notes[0], "2");
   expect(path).toBe(notesPath.replace("&page=1", "&page=2"));
   return response(fixture.notes[1], "");
  });
  expect(await port.listComments(repo, 7, token)).toEqual([
   { id: 11, author: "sage-bot", body: "Review marker" }, { id: 12, author: "ivy-bot", body: "" },
  ]);
  expect(calls).toHaveLength(2);
  expect(calls.every(path => path.includes("?order_by=created_at&sort=asc&"))).toBeTrue();
  for (const dir of dirs) expect(existsSync(dir)).toBeFalse();
 });
 test("without pagination headers full pages continue until short page", async () => {
  const { port, token, calls } = await setup(path => response(path === notesPath ? Array.from({ length: 100 }, (_, i) => ({
   id: i + 1, system: false, author: { username: "bot" }, body: "note",
  })) : fixture.notes[1]));
  expect(await port.listComments(repo, 7, token)).toHaveLength(101);
  expect(calls).toHaveLength(2);
 });
 test.each(["0", "1", "-1", "https://evil.test", "NaN", "9007199254740992"])("invalid next page %s throws", async next => {
  const { port, token } = await setup(() => response([], next));
  await expect(port.listComments(repo, 7, token)).rejects.toBeInstanceOf(GitLabReadError);
 });
 test.each([{}, { system: null }, { system: false, id: 1, body: "x", author: {} }, { system: false, id: 1, author: { username: "bot" } }])("malformed note %j throws", async note => {
  const { port, token } = await setup(() => response([note]));
  await expect(port.listComments(repo, 7, token)).rejects.toBeInstanceOf(GitLabReadError);
 });
 test("node labels come from the issue endpoint including hold-back label", async () => {
  const { port, token } = await setup(path => { expect(path).toBe(issuePath); return response(fixture.issue); });
  expect(await port.issueLabels(repo, 124, token)).toEqual(fixture.issue.labels);
 });
 test.each([{}, { iid: 124, labels: null }, { iid: 124, labels: [1] }, { labels: [] }, { iid: 125, labels: [] }])("malformed labels or mismatched issue %j throws", async raw => {
  const { port, token } = await setup(() => response(raw));
  await expect(port.issueLabels(repo, 124, token)).rejects.toBeInstanceOf(GitLabReadError);
 });
});

async function rejection(pending: Promise<unknown>): Promise<GitLabReadError> {
 try { await pending; } catch (error) { expect(error).toBeInstanceOf(GitLabReadError); return error as GitLabReadError; }
 throw new Error("unexpected success");
}

type Read = (p: ForgeReadPort<ResolvedToken>, r: string, t: ResolvedToken) => Promise<unknown>;
const reads: Read[] = [
 (p, r, t) => p.findPrByHead(r, fixture.mr.source_branch, t),
 (p, r, t) => p.getPr(r, 7, t),
 (p, r, t) => p.ciVerdictFor(r, sha, t),
 (p, r, t) => p.listComments(r, 7, t),
 (p, r, t) => p.issueLabels(r, 124, t),
];
describe("every GitLab read fails closed", () => {
 test.each([401, 403, 404, 500].flatMap(status => [0, 1].map(code => ({ status, code }))))("HTTP errors retain status for zero and nonzero glab exits %j", async ({ status, code }) => {
  const { port, token, dirs } = await setup(() => response({ message: "denied" }, undefined, status, code));
  for (const read of reads) expect((await rejection(read(port, repo, token))).status).toBe(status);
  for (const dir of dirs) expect(existsSync(dir)).toBeFalse();
 });
 test.each([response(null), response({}), { code: 0, stdout: "HTTP/2.0 200 OK\n\nnot JSON", stderr: "" }, response({}, undefined, 200, 1)])("malformed transport or schema %j cannot pass", async result => {
  const { port, token } = await setup(() => result);
  for (const read of reads) await expect(read(port, repo, token)).rejects.toBeInstanceOf(GitLabReadError);
 });
 test("copied and cross-project or cross-host grants never spawn a read", async () => {
  const { port, token, calls } = await setup(() => { throw new Error("must not reach runner"); });
  for (const read of reads) {
   for (const [target, grant] of [[repo, { ...token }], [`gitlab:${host}/team/other`, token], ["gitlab:other.test/team/sub/project", token]] as const) {
    await expect(read(port, target, grant)).rejects.toBeInstanceOf(GateError);
   }
  }
  expect(calls).toHaveLength(0);
 });
 test("failure on a later notes page never returns partial notes", async () => {
  const { port, token } = await setup(path => path === notesPath ? response(fixture.notes[0], "2") : response({}, undefined, 404));
  await expect(port.listComments(repo, 7, token)).rejects.toBeInstanceOf(GitLabReadError);
 });
 test("spawn failures are typed, sanitized, and clean private config directories", async () => {
  const { port, token, dirs } = await setup(() => { throw new Error("read-secret"); });
  for (const read of reads) expect((await rejection(read(port, repo, token))).message).not.toContain("read-secret");
  for (const dir of dirs) expect(existsSync(dir)).toBeFalse();
 });
});
