import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import fixture from "./fixtures/gitlab-reads.json";
import { GitLabReadError, GitLabWriteError, gitlabForgePort } from "../src/gitlab.ts";
import type { RangerConfig } from "../src/config.ts";
import type { runCmd, RunResult } from "../src/exec.ts";

const host = "gitlab.example.test";
const repo = `gitlab:${host}/team/sub/project`;
const project = "projects/team%2Fsub%2Fproject";
const mrPath = `${project}/merge_requests/7`;
const statePath = `${mrPath}?include_rebase_in_progress=true`;
const readToken = "read-secret";
const writeToken = "write-secret";
const bot = "project_1_bot_a1b2";
const gated = "c".repeat(40);
const rebased = "d".repeat(40);
const config = {
 auth: { readOnlyTokens: { [`gitlab:${host}/`]: "READ_GL" }, writeTokens: { [repo]: "WRITE_GL" } },
 principal: { login: { [`gitlab:${host}`]: "boss" } }, bot: {},
} as unknown as RangerConfig;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, READ_GL: readToken, WRITE_GL: writeToken };
// glab exits 1 on an HTTP error status and still prints the response; stderr carries the token on purpose.
const response = (body: unknown, status = 200, code = status < 400 ? 0 : 1): RunResult => ({
 code, stderr: writeToken, stdout: `HTTP/2.0 ${status} Response\r\nContent-Type: application/json\r\nX-Next-Page: \r\n\r\n${JSON.stringify(body)}`,
});
const raw = (body: unknown): RunResult => ({ code: 0, stderr: "", stdout: JSON.stringify(body) });

function setup(options: {
 read?: (endpoint: string) => RunResult;
 write?: (args: string[]) => RunResult;
 polls?: number;
} = {}) {
 const reads: string[] = [];
 const writes: string[][] = [];
 const sleeps: number[] = [];
 const runner: typeof runCmd = async (bin, args, opts) => {
  expect(bin).toBe("glab");
  const credential = parse(readFileSync(join(opts?.env?.GLAB_CONFIG_DIR!, "config.yml"), "utf8")).hosts[host].token;
  const method = args[args.indexOf("--method") + 1];
  if (method === "GET" && !args.includes("--include")) {
   // The write gate's identity check, under the write credential.
   expect(credential).toBe(writeToken);
   return raw(args[1] === "/user" ? { username: bot, bot: true } : { id: 1 });
  }
  if (method === "GET") {
   expect(credential).toBe(readToken);
   expect(opts?.env?.SOMA_GRAPH_READONLY).toBe("1");
   if (args[1] === "/personal_access_tokens/self") return response({ scopes: ["read_api"] });
   if (args[1] === `/${project}`) return response({ id: 1 });
   reads.push(args[1]);
   return options.read ? options.read(args[1]) : response({});
  }
  expect(credential).toBe(writeToken);
  writes.push(args.slice(1));
  return options.write ? options.write(args) : response({ state: "merged", squash: true });
 };
 const port = gitlabForgePort(config, {
  runner, env, wait: { polls: options.polls ?? 3, intervalMs: 5, sleep: async (ms) => { sleeps.push(ms); } },
 });
 return { port, reads, writes, sleeps };
}

describe("node #126 — GitLab squash merge at the gated head", () => {
 test("merges with squash=true, sha=<gated head> and the '<title> (!<iid>)' squash message", async () => {
  const { port, writes } = setup();
  expect(await port.mergePr(repo, 7, gated, "Merge desk on GitLab", writeToken)).toEqual({ status: "merged" });
  expect(writes).toEqual([[
   `${mrPath}/merge`, "--method", "PUT", "--include",
   "-F", "squash=true", "-f", `sha=${gated}`, "-f", "squash_commit_message=Merge desk on GitLab (!7)",
   "--hostname", host,
  ]]);
 });

 test("409 (SHA does not match HEAD) is head moved, and nothing merged", async () => {
  const { port, writes } = setup({ write: () => response({ message: "SHA does not match HEAD of source branch" }, 409) });
  const outcome = await port.mergePr(repo, 7, gated, "T", writeToken);
  expect(outcome).toMatchObject({ status: "head-moved" });
  expect(writes).toHaveLength(1);
 });

 for (const status of [405, 406, 422]) {
  test(`${status} is not mergeable, with GitLab's message and no credential`, async () => {
   const { port } = setup({ write: () => response({ message: `Branch cannot be merged ${status}` }, status) });
   const outcome = await port.mergePr(repo, 7, gated, "T", writeToken);
   expect(outcome).toMatchObject({ status: "not-mergeable" });
   if (outcome === undefined || outcome.status === "merged") throw new Error("expected a refusal");
   expect(outcome.reason).toContain(`HTTP ${status}: Branch cannot be merged ${status}`);
   expect(outcome.reason).not.toContain(writeToken);
  });
 }

 test("a merge GitLab did not squash is refused for escalation", async () => {
  const { port } = setup({ write: () => response({ state: "merged", squash: false }) });
  expect(await port.mergePr(repo, 7, gated, "T", writeToken)).toMatchObject({ status: "refused" });
 });

 test("a transport failure without a status line throws, never echoing the subprocess", async () => {
  const { port } = setup({ write: () => ({ code: 1, stderr: writeToken, stdout: writeToken }) });
  const error = await port.mergePr(repo, 7, gated, "T", writeToken).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitLabWriteError);
  expect(String(error)).not.toContain(writeToken);
 });

 test("any other HTTP error throws (nothing is assumed merged)", async () => {
  const { port } = setup({ write: () => response({ message: "forbidden" }, 403) });
  await expect(port.mergePr(repo, 7, gated, "T", writeToken)).rejects.toBeInstanceOf(GitLabWriteError);
 });

 test("a write under any other credential is refused before a mutation", async () => {
  const { port, writes } = setup();
  await expect(port.mergePr(repo, 7, gated, "T", readToken)).rejects.toThrow();
  expect(writes).toEqual([]);
 });
});

describe("node #126 — the project's squash option, read through the read gate", () => {
 for (const option of ["always", "default_on", "default_off"]) {
  test(`squash_option ${option} permits the merge`, async () => {
   const { port, reads } = setup({ read: () => response({ id: 1, squash_option: option }) });
   expect(await port.squashRefusal!(repo, writeToken)).toBeNull();
   expect(reads).toEqual([project]);
  });
 }
 test("squash_option never refuses", async () => {
  const { port } = setup({ read: () => response({ id: 1, squash_option: "never" }) });
  expect(await port.squashRefusal!(repo, writeToken)).toContain(`squash_option "never"`);
 });
 for (const option of [undefined, "sometimes", 1]) {
  test(`an unknown squash_option (${String(option)}) fails closed`, async () => {
   const { port } = setup({ read: () => response({ id: 1, squash_option: option }) });
   await expect(port.squashRefusal!(repo, writeToken)).rejects.toBeInstanceOf(GitLabReadError);
  });
 }
});

describe("node #126 — rebase on need_rebase, bounded wait, never a merge", () => {
 const state = (inProgress: boolean, sha = rebased, mergeError: string | null = null) =>
  response({ ...fixture.mr, sha, rebase_in_progress: inProgress, merge_error: mergeError });
 const accepted = () => response({ rebase_in_progress: true }, 202);
 /** Answer state reads in order, repeating the last one. */
 const script = (...states: RunResult[]) => () => states.length > 1 ? states.shift()! : states[0]!;

 test("PUT rebase, then poll rebase_in_progress until false: head moved to the new SHA", async () => {
  const { port, writes, reads, sleeps } = setup({ write: accepted, read: script(state(false, gated), state(true, gated), state(false)) });
  expect(await port.rebasePr!(repo, 7, writeToken)).toEqual({ status: "head-moved", headSha: rebased });
  expect(writes).toEqual([[`${mrPath}/rebase`, "--method", "PUT", "--include", "--hostname", host]]);
  expect(reads).toEqual([statePath, statePath, statePath]);
  expect(sleeps).toEqual([5, 5]);
 });

 test("still rebasing after the bound is pending", async () => {
  const { port, writes, reads } = setup({ polls: 3, write: accepted, read: script(state(false, gated), state(true, gated)) });
  expect(await port.rebasePr!(repo, 7, writeToken)).toMatchObject({ status: "pending" });
  expect(writes).toHaveLength(1);
  expect(reads).toHaveLength(4);
 });

 test("a rebase an earlier pass started is waited on, never requested again", async () => {
  const { port, writes, reads } = setup({ write: accepted, read: script(state(true, gated), state(false)) });
  expect(await port.rebasePr!(repo, 7, writeToken)).toEqual({ status: "head-moved", headSha: rebased });
  expect(writes).toEqual([]);
  expect(reads).toHaveLength(2);
 });

 test("409 on the rebase request (not enqueued yet) is pending, not a park", async () => {
  const { port, reads } = setup({ write: () => response({ message: "Failed to enqueue the rebase operation" }, 409), read: () => state(false, gated) });
  expect(await port.rebasePr!(repo, 7, writeToken)).toMatchObject({ status: "pending" });
  expect(reads).toEqual([statePath]);
 });

 test("a finished rebase that left a merge_error on the same head is not mergeable", async () => {
  const { port } = setup({ write: accepted, read: script(state(false, gated), state(false, gated, "Rebase failed: conflict")) });
  expect(await port.rebasePr!(repo, 7, writeToken)).toEqual({ status: "not-mergeable", reason: "GitLab could not rebase !7: Rebase failed: conflict" });
 });

 test("a stale merge_error beside a moved head is the rebase landing", async () => {
  const { port } = setup({ write: accepted, read: script(state(false, gated, "old merge failure"), state(false, rebased, "old merge failure")) });
  expect(await port.rebasePr!(repo, 7, writeToken)).toEqual({ status: "head-moved", headSha: rebased });
 });

 test("a refused rebase request is not mergeable, with GitLab's message", async () => {
  const { port, reads } = setup({ write: () => response({ message: "403 Forbidden" }, 403), read: () => state(false, gated) });
  const outcome = await port.rebasePr!(repo, 7, writeToken);
  expect(outcome).toMatchObject({ status: "not-mergeable" });
  if (outcome.status !== "not-mergeable") throw new Error("expected not-mergeable");
  expect(outcome.reason).toContain("HTTP 403: 403 Forbidden");
  expect(outcome.reason).not.toContain(writeToken);
  expect(reads).toEqual([statePath]);
 });

 test("a rebase state without rebase_in_progress fails closed, before any request", async () => {
  const { port, writes } = setup({ write: accepted, read: () => response({ ...fixture.mr }) });
  await expect(port.rebasePr!(repo, 7, writeToken)).rejects.toBeInstanceOf(GitLabReadError);
  expect(writes).toEqual([]);
 });
});
