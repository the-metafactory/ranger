import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import fixture from "./fixtures/gitlab-reads.json";
import { GitLabPort, GitLabWriteError } from "../src/gitlab.ts";
import type { ChangeRequest, ForgePort } from "../src/forge.ts";
import type { RangerConfig } from "../src/config.ts";
import type { ResolvedToken } from "../src/token-gate.ts";
import { WriteGateError } from "../src/identity.ts";
import type { runCmd, RunResult } from "../src/exec.ts";

const host = "gitlab.example.test";
const repo = `gitlab:${host}/team/sub/project`;
const project = "projects/team%2Fsub%2Fproject";
const token = "write-secret";
const bot = "project_1_bot_a1b2";
const config = {
 auth: { readOnlyTokens: {}, writeTokens: { [repo]: "RANGER_TEST_WRITE_TOKEN" } },
 principal: { login: { [`gitlab:${host}`]: "boss" } }, bot: {},
} as unknown as RangerConfig;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, RANGER_TEST_WRITE_TOKEN: token };
const draft: ChangeRequest = {
 iid: 7, state: "open", draft: true, headRef: "node/125", headSha: fixture.mr.sha,
 baseRef: "main", mergeState: "blocked", webUrl: fixture.mr.web_url, author: bot,
 title: "Draft: Write support", mergeCommitSha: null, mergedBy: null,
};
const input = { head: "node/125 & writes", base: "main", title: "Write support", body: "@literal\n{description}=true & more" };
const created = { ...fixture.mr, source_branch: input.head, draft: true, title: `Draft: ${input.title}`, author: { username: bot } };
const response = (body: unknown, status = 200, code = 0): RunResult => ({
 code, stderr: token, stdout: `HTTP/2.0 ${status} Response\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
});

function setup(options: {
 env?: NodeJS.ProcessEnv; config?: RangerConfig; user?: unknown;
 write?: (args: string[]) => RunResult | Promise<RunResult>;
} = {}) {
 const calls: string[][] = [];
 const writes: string[][] = [];
 const dirs: string[] = [];
 const runner: typeof runCmd = async (bin, args, opts) => {
  expect(bin).toBe("glab");
  expect(args[0]).toBe("api");
  const dir = opts?.env?.GLAB_CONFIG_DIR!;
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "config.yml")).mode & 0o777).toBe(0o600);
  expect(parse(readFileSync(join(dir, "config.yml"), "utf8"))).toEqual({
   check_update: false, telemetry: false,
   hosts: { [host]: { token, api_host: host, api_protocol: "https" } },
  });
  expect(opts?.env?.GITLAB_TOKEN).toBeUndefined();
  expect(opts?.env?.GH_TOKEN).toBeUndefined();
  expect(dirs).not.toContain(dir);
  for (const old of dirs) expect(existsSync(old)).toBeFalse();
  dirs.push(dir);
  calls.push(args);
  if (args[1] === "/user" || args[1] === `/${project}`) {
   expect(args.slice(2)).toEqual(["--hostname", host, "--method", "GET"]);
   return { code: 0, stderr: "", stdout: JSON.stringify(args[1] === "/user"
    ? (options.user ?? { username: bot, bot: true }) : { id: 1 }) };
  }
  writes.push(args);
  return options.write ? options.write(args) : response(created, 201);
 };
 const port: Omit<ForgePort<ResolvedToken>, "mergePr"> = new GitLabPort(options.config ?? config, runner, options.env ?? env);
 return { port, calls, writes, dirs };
}

const operations = ["createDraftPr", "updatePrBody", "markReady", "postComment"] as const;
type Operation = typeof operations[number];
function invoke(port: Omit<ForgePort<ResolvedToken>, "mergePr">, op: Operation, credential = token) {
 switch (op) {
  case "createDraftPr": return port.createDraftPr(repo, input, credential);
  case "updatePrBody": return port.updatePrBody(repo, 7, input.body, credential);
  case "markReady": return port.markReady(repo, draft, credential);
  case "postComment": return port.postComment(repo, 7, input.body, credential);
 }
}

describe("GitLab forge writes", () => {
 test("draft creation sends literal fields and boolean false, returning normalized ChangeRequest", async () => {
  const { port, writes, dirs } = setup();
  expect(await port.createDraftPr(repo, input, token)).toEqual({
   ...draft, headRef: input.head, mergeState: "mergeable", mergeDetail: "mergeable",
  });
  expect(writes).toEqual([["api", `${project}/merge_requests`, "--method", "POST", "--include",
   "-f", `source_branch=${input.head}`, "-f", "target_branch=main", "-f", `title=Draft: ${input.title}`,
   "-f", `description=${input.body}`, "-F", "remove_source_branch=false", "--hostname", host]]);
  for (const dir of dirs) expect(existsSync(dir)).toBeFalse();
 });
 test("description update sends only description, including an empty description", async () => {
  const { port, writes } = setup({ write: () => response({}, 200) });
  await port.updatePrBody(repo, 7, input.body, token);
  await port.updatePrBody(repo, 7, "", token);
  expect(writes).toEqual([input.body, ""].map(body => ["api", `${project}/merge_requests/7`,
   "--method", "PUT", "--include", "-f", `description=${body}`, "--hostname", host]));
 });
 test("readiness strips only the leading Draft prefix, even if draft metadata is false", async () => {
  const { port, writes } = setup({ write: () => response({}, 200) });
  await port.markReady(repo, { ...draft, draft: false, title: "Draft: Draft: Keep this" }, token);
  expect(writes).toEqual([["api", `${project}/merge_requests/7`, "--method", "PUT", "--include",
   "-f", "title=Draft: Keep this", "--hostname", host]]);
 });
 test.each(["Write support", "Contains Draft: text", "Draft:support", "draft: support"])("title %s is a no-op", async title => {
  const { port, calls } = setup();
  await port.markReady(repo, { ...draft, title }, token);
  expect(calls).toHaveLength(0);
 });
 test("comments post MR notes and return the note id", async () => {
  const { port, writes } = setup({ write: () => response({ id: 83 }, 201) });
  expect(await port.postComment(repo, 7, input.body, token)).toBe(83);
  expect(writes).toEqual([["api", `${project}/merge_requests/7/notes`, "--method", "POST", "--include",
   "-f", `body=${input.body}`, "--hostname", host]]);
 });
 for (const op of operations) {
  test(`${op} refuses missing, empty, unmapped or mismatched credentials before any call`, async () => {
   for (const options of [
    { env: {} }, { env: { RANGER_TEST_WRITE_TOKEN: " " } },
    { config: { ...config, auth: { readOnlyTokens: {}, writeTokens: {} } } },
    { config: { ...config, principal: { login: {} } } },
   ]) {
    const { port, calls } = setup(options);
    await expect(invoke(port, op)).rejects.toBeInstanceOf(WriteGateError);
    expect(calls).toHaveLength(0);
   }
   for (const credential of ["", "other-secret"]) {
    const { port, calls } = setup();
    await expect(invoke(port, op, credential)).rejects.toBeInstanceOf(WriteGateError);
    expect(calls).toHaveLength(0);
   }
  });
  test(`${op} refuses principal identity and other bots without a mutation`, async () => {
   for (const user of [{ username: "BOSS", bot: true }, { username: "human" }, { username: "project_2_bot_ab", bot: true }]) {
    const { port, writes, dirs } = setup({ user });
    await expect(invoke(port, op)).rejects.toBeInstanceOf(WriteGateError);
    expect(writes).toHaveLength(0);
    for (const dir of dirs) expect(existsSync(dir)).toBeFalse();
   }
  });
  test.each([199, 301, 400, 403, 409, 429, 500, 503])(`${op} HTTP %i throws once without retries`, async status => {
   const { port, writes, dirs } = setup({ write: () => response({ error: token }, status) });
   await expect(invoke(port, op)).rejects.toBeInstanceOf(GitLabWriteError);
   expect(writes).toHaveLength(1);
   for (const dir of dirs) expect(existsSync(dir)).toBeFalse();
  });
  test(`${op} refuses inherited read-only policy`, async () => {
   const { port, writes } = setup({ env: { ...env, SOMA_GRAPH_READONLY: "1" } });
   await expect(invoke(port, op)).rejects.toBeInstanceOf(WriteGateError);
   expect(writes).toHaveLength(0);
  });
  test.each(["exit", "spawn", "missing-status"])(`${op} %s failure is redacted, not retried, and cleans config`, async failure => {
   const { port, writes, dirs } = setup({ write: () => {
    if (failure === "spawn") throw new Error(token);
    if (failure === "missing-status") return { code: 0, stdout: token, stderr: token };
    return response(created, 201, 1);
   } });
   try { await invoke(port, op); throw new Error("write succeeded"); }
   catch (error) {
    expect(error).toBeInstanceOf(GitLabWriteError);
    expect(String(error)).not.toContain(token);
   }
   expect(writes).toHaveLength(1);
   for (const dir of dirs) expect(existsSync(dir)).toBeFalse();
  });
 }
 test("each mutation repeats the identity gate rather than reusing stale authorization", async () => {
  const options = { user: { username: bot, bot: true }, write: () => response({}, 200) };
  const { port, calls, writes } = setup(options);
  await port.updatePrBody(repo, 7, "first", token);
  options.user = { username: "boss", bot: true };
  await expect(port.updatePrBody(repo, 7, "second", token)).rejects.toBeInstanceOf(WriteGateError);
  expect(calls.filter(args => args[1] === "/user")).toHaveLength(2);
  expect(writes).toHaveLength(1);
 });
 test.each([null, {}, { id: 0 }, { id: "83" }, { id: -1 }, { id: 1.5 }])("invalid note response %j throws without retry", async body => {
  const { port, writes } = setup({ write: () => response(body, 201) });
  await expect(port.postComment(repo, 7, "note", token)).rejects.toBeInstanceOf(GitLabWriteError);
  expect(writes).toHaveLength(1);
 });
 test.each([null, {}, { ...created, source_project_id: 2 }])("invalid draft response throws without retry", async body => {
  const { port, writes } = setup({ write: () => response(body, 201) });
  await expect(port.createDraftPr(repo, input, token)).rejects.toBeInstanceOf(GitLabWriteError);
  expect(writes).toHaveLength(1);
 });
});
