import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { RangerConfig } from "../src/config.ts";
import { principalLoginForRepo } from "../src/config.ts";
import { runCmd, type RunResult } from "../src/exec.ts";
import {
 assertNotPrincipal, assertWriteIdentity, gitlabApiWrite, loginForToken,
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
 PATH: process.env.PATH, HOME: process.env.HOME, [source]: secret, SOMA_GRAPH_READONLY: "1",
 ...Object.fromEntries(MACHINE_FORGE_KEYS.map(k => [k, "principal-secret-or-override"])),
 GLAB_ENABLE_CI_AUTOLOGIN: "true", GL_HOST: "wrong.host", NODE_OPTIONS: "injection",
};
const result = (body: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });

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
  const authorized = await assertWriteIdentity(config, repo, inherited, async (bin, args, opts) => {
   expect(bin).toBe("glab");
   expect(args).toEqual(["api", "/user", "--hostname", host, "--method", "GET"]);
   dir = inspectEnv(opts?.env);
   return result({ username: bot, login: "wrong-field" });
  });
  expect(authorized).toEqual({ token: secret, botIdentity: bot });
  expect(existsSync(dir)).toBeFalse();
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
  expect(calls).toBe(0);
 });

 test.each([
  { username: "boss-gl" }, { username: "human-maintainer" }, {}, { username: null },
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

 test("configured bot label must still match the resolved credential", async () => {
  await expect(resolveBotIdentity({ ...config, bot: { identity: "other-bot" } }, secret, repo,
   async () => result({ username: bot }), inherited)).rejects.toThrow(/does not match/);
 });

 test("GitHub identity lookup and map principal remain compatible", async () => {
  expect(await loginForToken("gh-token", {}, "team/project", async (bin, args, opts) => {
   expect(bin).toBe("gh");
   expect(args).toEqual(["api", "/user", "--jq", ".login"]);
   expect(opts?.env?.GH_TOKEN).toBe("gh-token");
   return { code: 0, stdout: "ivy-agent\n", stderr: "" };
  })).toBe("ivy-agent");
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
  const worker = workerEnv(config, repo, "/tmp/session-journal");
  expect(worker.PILOT_PRINCIPAL).toBe("boss-gl");
  expect(worker.SOMA_GRAPH_REPO).toBe(repo);
  expect(workerEnv(config, "team/project", "/tmp/session-journal").PILOT_PRINCIPAL).toBe("boss-gh");
 });
});
