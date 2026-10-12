import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { RangerAuthConfig, RangerConfig } from "../src/config.ts";
import { principalLoginForRepo } from "../src/config.ts";
import { runCmd, type RunResult } from "../src/exec.ts";
import {
 assertCommitIdentity, assertNotPrincipal, assertWriteIdentity, gitlabApiWrite, loginForToken,
 matchWriteTokenEnv, resolveBotIdentity, writeEnvForRepo, WriteGateError,
} from "../src/identity.ts";
import { graphClaim, graphClose, graphDecisions, graphRelease } from "../src/graph-write.ts";
import { MACHINE_FORGE_KEYS } from "../src/forge-env.ts";
import { mergeEnv } from "../src/serve-parked.ts";
import { workerEnv, workerHostEnv } from "../src/worker-env.ts";

const host = "gitlab.example.org";
const repo = `gitlab:${host}/team/sub/project`;
const bot = "project_123_bot_a1b2c3";
const source = "CUSTOM_WRITE_SECRET";
const secret = 'write: "quoted"\nsecret';
const config = {
 auth: { readOnlyTokens: {}, writeTokens: { [`gitlab:${host}/team/`]: source } },
 principal: { login: { "github:github.com": "boss-gh", [`gitlab:${host}`]: "boss-gl" } },
 bot: {},
} as unknown as RangerConfig;
const inherited: NodeJS.ProcessEnv = {
 PATH: process.env.PATH, HOME: process.env.HOME, [source]: secret,
 ...Object.fromEntries(MACHINE_FORGE_KEYS.map(k => [k, "principal-secret-or-override"])),
 GLAB_ENABLE_CI_AUTOLOGIN: "true", GL_HOST: "wrong.host", NODE_OPTIONS: "injection",
};
const result = (body: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
const projectPath = `/projects/${encodeURIComponent("team/sub/project")}`;
/** GitLab's answers for the project's own bot: /user flags it, the project id matches its username. */
const botApi = (user: unknown = { username: bot, bot: true }, project: unknown = { id: 123 }) =>
 async (_bin: string, args: string[]) => result(args[1] === "/user" ? user : project);

function inspectEnv(env?: NodeJS.ProcessEnv): string {
 expect(env?.SOMA_GRAPH_READONLY).toBeUndefined();
 expect(env?.PATH).toBe(inherited.PATH);
 for (const name of Object.keys(inherited).filter(k => !["PATH", "HOME", "GLAB_CONFIG_DIR"].includes(k))) {
  expect(env?.[name]).toBeUndefined();
 }
 const dir = env?.GLAB_CONFIG_DIR!;
 expect(statSync(dir).mode & 0o777).toBe(0o700);
 expect(readdirSync(dir)).toEqual(["config.yml"]);
 const file = join(dir, "config.yml");
 expect(statSync(file).mode & 0o777).toBe(0o600);
 expect(parse(readFileSync(file, "utf8"))).toEqual({ check_update: false, telemetry: false,
  hosts: { [host]: { token: secret, api_host: host, api_protocol: "https" } } });
 return dir;
}

describe("GitLab write gate", () => {
 test("host-qualified longest-prefix matching never inherits GitHub defaults or other hosts", () => {
  const auth = { readOnlyTokens: {}, writeTokens: {
   "*": "GH", "team/": "GH_TEAM", "github:github.com/team/": "GH_QUALIFIED",
   [`gitlab:${host}/`]: "GL_HOST", [`gitlab:${host}/team/`]: source,
   "gitlab:other.host/team/": "OTHER",
  }, defaultWriteTokenEnv: "GH_DEFAULT" };
  expect(matchWriteTokenEnv(auth, repo)).toBe(source);
  expect(matchWriteTokenEnv(auth, `gitlab:${host}/other/project`)).toBe("GL_HOST");
  expect(matchWriteTokenEnv(auth, "gitlab:missing.host/team/project")).toBeUndefined();
  expect(matchWriteTokenEnv(auth, "github:github.com/team/project")).toBe("GH_QUALIFIED");
  expect(matchWriteTokenEnv(auth, "team/project")).toBe("GH_QUALIFIED");
  expect(matchWriteTokenEnv({ ...auth, writeTokens: {} }, "other/project")).toBe("GH_DEFAULT");
 });

 test("principal policy is forge and host specific; scalar applies only to GitHub", () => {
  expect(principalLoginForRepo(config, repo)).toBe("boss-gl");
  expect(principalLoginForRepo(config, "team/project")).toBe("boss-gh");
  expect(() => assertNotPrincipal(config, "BOSS-GL", repo)).toThrow(/principal's identity/);
  expect(() => assertNotPrincipal(config, "boss-gh", "team/project")).toThrow(WriteGateError);
  expect(() => assertNotPrincipal(config, bot, "gitlab:other.host/team/project")).toThrow(/no principal login/);
  const legacy = { ...config, principal: { login: "boss-gl" } };
  expect(principalLoginForRepo(legacy, repo)).toBeUndefined();
  expect(() => assertNotPrincipal(legacy, bot, repo)).toThrow(/no principal login/);
  expect(() => assertNotPrincipal(config, "", repo)).toThrow(/empty write identity/);
 });

 test("GET /user resolves username from the write credential and cleans its config", async () => {
  let dir = "";
  const endpoints: string[] = [];
  const authorized = await assertWriteIdentity(config, repo, inherited, async (bin, args, opts) => {
   expect(bin).toBe("glab");
   expect(args).toEqual(["api", args[1], "--hostname", host, "--method", "GET"]);
   endpoints.push(args[1]!);
   dir = inspectEnv(opts?.env);
   return args[1] === "/user" ? result({ id: 456, username: bot, login: "wrong-field", bot: true }) : result({ id: 123 });
  });
  expect(authorized).toEqual({ token: secret, botIdentity: bot });
  expect(endpoints).toEqual(["/user", projectPath]);
  expect(existsSync(dir)).toBeFalse();
 });

 test("a run-node's gate adds the bot's commit identity from the same GET /user (node #127)", async () => {
  const endpoints: string[] = [];
  const user = { id: 456, username: bot, bot: true };
  const runner: typeof runCmd = async (_bin, args) => {
   endpoints.push(args[1]!);
   return result(args[1] === "/user" ? user : { id: 123 });
  };
  expect(await assertCommitIdentity(config, repo, inherited, runner)).toEqual({
   token: secret, botIdentity: bot, commitAuthor: { name: bot, email: `456-${bot}@users.noreply.${host}` },
  });
  expect(endpoints).toEqual(["/user", projectPath]);
  await expect(assertCommitIdentity(config, repo, inherited, botApi({ username: bot, bot: true }))).rejects.toThrow(/missing user id/);
 });

 test("missing credential or principal policy spawns nothing", async () => {
  let calls = 0;
  const runner: typeof runCmd = async () => { calls++; return result({ username: bot }); };
  for (const env of [{}, { [source]: "" }, { [source]: "  " }]) {
   await expect(assertWriteIdentity(config, repo, env, runner)).rejects.toThrow(source);
  }
  await expect(assertWriteIdentity({ ...config, auth: { readOnlyTokens: {}, writeTokens: { "*": "GH" },
   defaultWriteTokenEnv: "GH" } }, repo, { GH: "principal" }, runner)).rejects.toThrow(/no write-token mapping/);
  await expect(assertWriteIdentity({ ...config, principal: { login: {} } }, repo, inherited, runner)).rejects.toThrow(/no principal login/);
  // A worker-inherited name refuses even when the config skipped schema validation.
  await expect(assertWriteIdentity({ ...config, auth: { readOnlyTokens: {}, writeTokens: { [`gitlab:${host}/team/`]: "SOMA_GL_WRITE_TOKEN" } } },
   repo, { SOMA_GL_WRITE_TOKEN: secret }, runner)).rejects.toThrow(/inherited by worker sessions/);
  expect(calls).toBe(0);
 });

 test.each([
  { username: "boss-gl" }, { username: "human-maintainer" }, {}, { username: null },
  { username: bot }, { username: bot, bot: false }, { username: bot, bot: "true" },
  { username: "boss-gl", bot: true }, { username: "human-maintainer", bot: true },
  { username: "" }, { username: " " }, { username: 123 }, null,
 ])("refuses principal, non-project bot and malformed /user identities %j", async body => {
  let dir = "";
  await expect(assertWriteIdentity(config, repo, inherited, async (_bin, args, opts) => {
   expect(args[1]).toBe("/user"); // Only an identity read, no write.
   dir = inspectEnv(opts?.env);
   return result(body);
  })).rejects.toThrow(WriteGateError);
  expect(existsSync(dir)).toBeFalse();
 });

 test.each(["nonzero", "spawn", "json"])("identity failure %s cleans config and never echoes credential", async failure => {
  let dir = "";
  try {
   await assertWriteIdentity(config, repo, inherited, async (_bin, args, opts) => {
    expect(args[1]).toBe("/user");
    dir = inspectEnv(opts?.env);
    if (failure === "spawn") throw new Error(secret);
    return { code: failure === "nonzero" ? 1 : 0, stdout: secret, stderr: secret };
   });
   throw new Error("gate passed");
  } catch (error) {
   expect(error).toBeInstanceOf(WriteGateError);
   expect(String(error)).not.toContain(secret);
  }
  expect(existsSync(dir)).toBeFalse();
 });

 test("a pinned GitHub bot coexists with GitLab project bots and still gates GitHub", async () => {
  const pinned = { ...config, bot: { identity: "ivy-agent" } };
  expect(await resolveBotIdentity(pinned, secret, repo, botApi(), inherited)).toBe(bot);
  expect(await resolveBotIdentity(pinned, "gh-token", "team/project",
   async () => ({ code: 0, stdout: "ivy-agent\n", stderr: "" }), {})).toBe("ivy-agent");
  await expect(resolveBotIdentity(pinned, "gh-token", "team/project",
   async () => ({ code: 0, stdout: "other-bot\n", stderr: "" }), {})).rejects.toThrow(/does not match/);
  await expect(resolveBotIdentity(pinned, secret, repo,
   async () => result({ username: "boss-gl" }), inherited)).rejects.toThrow(/principal's identity/);
  await expect(resolveBotIdentity(pinned, secret, repo,
   async () => result({ username: "human-maintainer" }), inherited)).rejects.toThrow(/not this project's access-token bot/);
 });

 test("a project-bot username is not enough: GitLab must flag a bot owned by this project", async () => {
  // A human may choose a project-bot-shaped username; GitLab's bot flag is not theirs to set.
  await expect(resolveBotIdentity(config, secret, repo, botApi({ username: bot, bot: false }), inherited))
   .rejects.toThrow(/does not report the user as a bot/);
  await expect(resolveBotIdentity(config, secret, repo, botApi({ username: bot }), inherited))
   .rejects.toThrow(/does not report the user as a bot/);
  // Another project's bot token, mapped to this repo by mistake.
  await expect(resolveBotIdentity(config, secret, repo, botApi(undefined, { id: 999 }), inherited))
   .rejects.toThrow(/belongs to project 123/);
  for (const project of [{}, { id: "123" }, null]) {
   await expect(resolveBotIdentity(config, secret, repo, botApi(undefined, project), inherited))
    .rejects.toThrow(WriteGateError);
  }
  await expect(resolveBotIdentity(config, secret, repo, async (_bin, args) =>
   args[1] === "/user" ? result({ username: bot, bot: true }) : { code: 1, stdout: "", stderr: secret }, inherited))
   .rejects.toThrow(/cannot verify/);
 });

 test("qualified and bare GitHub write keys rank by the repo path they cover", () => {
  const auth: RangerAuthConfig = { readOnlyTokens: {}, writeTokens: {
   "github:github.com/acme/": "ORG", "acme/widgets": "PROJECT",
  } };
  expect(matchWriteTokenEnv(auth, "acme/widgets")).toBe("PROJECT");
  expect(matchWriteTokenEnv(auth, "github:github.com/acme/widgets")).toBe("PROJECT");
  expect(matchWriteTokenEnv(auth, "acme/gadgets")).toBe("ORG");
  auth.writeTokens = { "acme/": "BARE_ORG", "github:github.com/acme/widgets": "QUALIFIED_PROJECT", "*": "ALL" };
  expect(matchWriteTokenEnv(auth, "acme/widgets")).toBe("QUALIFIED_PROJECT");
  expect(matchWriteTokenEnv(auth, "acme/gadgets")).toBe("BARE_ORG");
  auth.writeTokens = { "github:github.com/": "QUALIFIED_ALL", "*": "BARE_ALL" };
  expect(matchWriteTokenEnv(auth, "acme/widgets")).toBe("QUALIFIED_ALL");
 });

 test("GitHub identity lookup remains compatible", async () => {
  expect(await loginForToken("gh-token", "team/project", {}, async (bin, args, opts) => {
   expect(bin).toBe("gh");
   expect(args).toEqual(["api", "/user", "--jq", ".login"]);
   expect(opts?.env?.GH_TOKEN).toBe("gh-token");
   return { code: 0, stdout: "ivy-agent\n", stderr: "" };
  })).toBe("ivy-agent");
 });

 test.each(["1", "0"])("GitLab write env preserves inherited read-only policy %s", async policy => {
  const base = { ...inherited, SOMA_GRAPH_READONLY: policy };
  const gated = writeEnvForRepo(repo, secret, base);
  try { expect(gated.env.SOMA_GRAPH_READONLY).toBe(policy); }
  finally { gated.cleanup(); }
  let dir = "";
  await graphDecisions(repo, "1", secret, { env: base, runner: async (_bin, _args, opts) => {
   expect(opts?.env?.SOMA_GRAPH_READONLY).toBe(policy);
   dir = opts!.env!.GLAB_CONFIG_DIR!;
   return result({});
  } });
  expect(existsSync(dir)).toBeFalse();
 });

 test("inherited read-only policy refuses direct GitLab API writes without spawning", async () => {
  let calls = 0;
  await expect(gitlabApiWrite(repo, secret, ["/projects/42/merge_requests", "--method", "POST"],
   async () => { calls++; return result({}); },
   { env: { ...inherited, SOMA_GRAPH_READONLY: "1" } })).rejects.toThrow(/read-only restriction/);
  expect(calls).toBe(0);
 });

 test("qualified write prefixes match path segments, never sibling groups or projects", () => {
  const auth: RangerAuthConfig = { readOnlyTokens: {}, writeTokens: { [`gitlab:${host}/team`]: source } };
  expect(matchWriteTokenEnv(auth, repo)).toBe(source);
  expect(matchWriteTokenEnv(auth, `gitlab:${host}/team-other/project`)).toBeUndefined();
  auth.writeTokens = { [`gitlab:${host}/team/sub/project`]: source };
  expect(matchWriteTokenEnv(auth, repo)).toBe(source);
  expect(matchWriteTokenEnv(auth, `${repo}-other`)).toBeUndefined();
 });

 test("claim, release, close, decisions and MR API writes each isolate and remove their config", async () => {
  const dirs: string[] = [];
  const runner: typeof runCmd = async (bin, args, opts) => {
   for (const prior of dirs) expect(existsSync(prior)).toBeFalse();
   dirs.push(inspectEnv(opts?.env));
   if (bin === "soma") {
    expect(args[0]).toBe("graph");
    expect(args[args.indexOf("--repo") + 1]).toBe(repo);
    return args[1] === "claim" ? result({ node: "7", held: true, assignees: [bot] })
     : args[1] === "release" ? result({ node: "7", released: true, assignees: [] }) : result({});
   }
   expect(bin).toBe("glab");
   expect(args).toEqual(["api", "/projects/42/merge_requests", "--method", "POST", "--hostname", host]);
   return result({ iid: 8 });
  };
  const opts = { env: inherited, runner };
  expect((await graphClaim(repo, "7", bot, secret, opts)).held).toBeTrue();
  expect((await graphRelease(repo, "7", bot, secret, opts)).released).toBeTrue();
  expect((await graphClose(repo, "7", bot, secret, { resolutionFile: "/tmp/receipt.md" }, opts)).closed).toBeTrue();
  expect((await graphDecisions(repo, "1", secret, opts)).written).toBeTrue();
  await gitlabApiWrite(repo, secret, ["/projects/42/merge_requests", "--method", "POST"], runner, opts);
  expect(new Set(dirs).size).toBe(5);
  for (const dir of dirs) expect(existsSync(dir)).toBeFalse();
 });

 test("write failures clean up per-call configs", async () => {
  for (const fail of [false, true]) {
   let dir = "";
   const runner: typeof runCmd = async (_bin, _args, opts) => {
    dir = inspectEnv(opts?.env);
    if (fail) throw new Error("spawn failure");
    return { code: 2, stdout: "", stderr: "failed" };
   };
   await expect(graphDecisions(repo, "1", secret, { env: inherited, runner })).rejects.toThrow();
   expect(existsSync(dir)).toBeFalse();
   if (fail) await expect(gitlabApiWrite(repo, secret, ["/projects/42"], runner, { env: inherited })).rejects.toThrow();
   else expect((await gitlabApiWrite(repo, secret, ["/projects/42"], runner, { env: inherited })).code).toBe(2);
   expect(existsSync(dir)).toBeFalse();
  }
  expect(() => writeEnvForRepo(repo, "")).toThrow(WriteGateError);
 });

 test("worker and dashboard merge environments strip all forge keys and custom write secrets", () => {
  const hostEnv = workerHostEnv({ ...inherited, GIT_AUTHOR_NAME: "worker" });
  const humanEnv = mergeEnv(inherited);
  for (const name of [...MACHINE_FORGE_KEYS, source]) {
   expect(hostEnv[name]).toBeUndefined();
   expect(humanEnv[name]).toBeUndefined();
  }
  expect(hostEnv.GIT_AUTHOR_NAME).toBe("worker");
  const worker = workerEnv(config, repo, "/tmp/session-journal", { name: bot, email: `456-${bot}@users.noreply.${host}` });
  expect(worker.PILOT_PRINCIPAL).toBe("boss-gl");
  expect(worker.SOMA_GRAPH_REPO).toBe(repo);
  expect(workerEnv(config, "team/project", "/tmp/session-journal").PILOT_PRINCIPAL).toBe("boss-gh");
 });
});
