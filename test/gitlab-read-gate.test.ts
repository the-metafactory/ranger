import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { RangerConfig } from "../src/config.ts";
import { runCmd, type RunResult } from "../src/exec.ts";
import { callGraph, RateLimitError } from "../src/graph.ts";
import { glabConfigEnv } from "../src/glab-config-dir.ts";
import { assertReadOnlyToken, GateError, gitlabApiRead, matchTokenEnv, tokenBatch } from "../src/token-gate.ts";
import { probeGlabKeyring } from "../scripts/probe-glab-keyring.ts";
import { activeCooldown, BudgetDeferral, budgetedRead, cooldownScope } from "../src/budget.ts";
import { Journal } from "../src/journal.ts";

const host = "gitlab.example.org";
const repo = `gitlab:${host}/team/sub/project`;
const source = "RANGER_RO_GITLAB";
const secret = 'read-token: "quoted"\nvalue';
const config = { auth: { readOnlyTokens: { [`gitlab:${host}/team/`]: source },
  writeTokens: { [`gitlab:${host}/team/`]: "CUSTOM_WRITE_SECRET" } } } as unknown as RangerConfig;
const env = { [source]: secret, PATH: process.env.PATH, GLAB_CONFIG_DIR: "/principal/config",
  GITLAB_TOKEN: "principal-write", GITLAB_ACCESS_TOKEN: "principal-write", OAUTH_TOKEN: "principal-write",
  CI_JOB_TOKEN: "job-write", JOB_TOKEN: "job-write", GLAB_TOKEN: "principal-write", GITLAB_HOST: "other.host",
  GL_HOST: "other.host", GITLAB_API_HOST: "other.host", GITLAB_API_PROTOCOL: "http", API_PROTOCOL: "http",
  GITLAB_URI: "https://other.host", GITLAB_URL: "https://other.host", GLAB_ENABLE_CI_AUTOLOGIN: "true",
  GLAB_SEND_TELEMETRY: "true", CHECK_UPDATE: "true", GH_TOKEN: "github-write", GITHUB_TOKEN: "github-write",
  GH_ENTERPRISE_TOKEN: "github-write", CUSTOM_WRITE_SECRET: "write-token" };
const response = (body: unknown, status = 200, code = status === 200 ? 0 : 1): RunResult => ({
  code, stdout: `HTTP/2.0 ${status} Response\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`, stderr: "",
});

function inspectConfig(childEnv: NodeJS.ProcessEnv | undefined, token = secret): string {
  expect(childEnv?.SOMA_GRAPH_READONLY).toBe("1");
  const dir = childEnv?.GLAB_CONFIG_DIR;
  expect(dir).toBeDefined();
  expect(dir).not.toBe("/principal/config");
  expect(statSync(dir!).mode & 0o777).toBe(0o700);
  expect(readdirSync(dir!)).toEqual(["config.yml"]);
  const file = join(dir!, "config.yml");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(parse(readFileSync(file, "utf8"))).toEqual({
    check_update: false, telemetry: false,
    hosts: { [host]: { token, api_host: host, api_protocol: "https" } },
  });
  for (const key of Object.keys(env).filter(k => !["PATH", "GLAB_CONFIG_DIR"].includes(k))) {
    expect(childEnv?.[key]).toBeUndefined();
  }
  return dir!;
}

describe("GitLab read gate", () => {
  test("bare and qualified GitHub prefixes never match GitLab, including default fallback", () => {
    const auth = { readOnlyTokens: { "*": "GH", "team/": "GH_TEAM", "github:github.com/team/": "GH_QUALIFIED",
      [`gitlab:${host}/`]: "GL_HOST", [`gitlab:${host}/team/`]: source,
      "gitlab:other.host/team/": "OTHER" }, defaultTokenEnv: "GH_DEFAULT", writeTokens: {} };
    expect(matchTokenEnv(auth, repo)).toBe(source);
    expect(matchTokenEnv(auth, `gitlab:${host}/other/project`)).toBe("GL_HOST");
    expect(matchTokenEnv(auth, "gitlab:missing.host/team/project")).toBeUndefined();
    expect(matchTokenEnv(auth, "github:github.com/team/project")).toBe("GH_QUALIFIED");
    expect(matchTokenEnv(auth, "someone/project")).toBe("GH");
  });

  test("missing mapping or unset env never spawns glab", async () => {
    let calls = 0;
    const runner: typeof runCmd = async () => { calls++; return response({}); };
    await expect(assertReadOnlyToken(config, repo, {}, runner)).rejects.toThrow(source);
    await expect(assertReadOnlyToken({ auth: { readOnlyTokens: { "*": "GH" }, defaultTokenEnv: "GH" } } as unknown as RangerConfig,
      repo, { GH: "principal" }, runner)).rejects.toThrow("no read-only token mapping");
    expect(calls).toBe(0);
  });

  test("allowed scopes proceed; every call has its own config, including soma and ranger GET", async () => {
    const dirs: string[] = [];
    const endpoints: string[] = [];
    const runner: typeof runCmd = async (bin, args, opts) => {
      for (const dir of dirs) expect(existsSync(dir)).toBeFalse();
      dirs.push(inspectConfig(opts?.env));
      expect(bin).toBe("glab");
      expect(args.slice(2)).toEqual(["--hostname", host, "--method", "GET", "--include"]);
      endpoints.push(args[1]);
      return endpoints.length === 1 ? response({ scopes: ["read_api", "read_repository"] }) : response({ id: 42 });
    };
    const { token, info } = await assertReadOnlyToken(config, repo, env, runner);
    expect(info.scopes).toEqual(["read_api", "read_repository"]);
    expect(info).toEqual({ forge: "gitlab", scopes: ["read_api", "read_repository"], tokenType: "gitlab_pat" });
    expect(endpoints).toEqual(["/personal_access_tokens/self", "/projects/team%2Fsub%2Fproject"]);
    await gitlabApiRead(repo, token, "/projects/42/issues", runner, { env });
    await callGraph({ verb: "frontier", root: "1", repo, token, opts: { runner: async (bin, args, opts) => {
      dirs.push(inspectConfig(opts?.env));
      expect(bin).toBe("soma");
      expect(args).toEqual(["graph", "frontier", "1", "--repo", repo, "--json"]);
      return response({});
    } } });
    expect(new Set(dirs).size).toBe(4);
    for (const dir of dirs) expect(existsSync(dir)).toBeFalse();
  });

  test.each([{ scopes: [] }, { scopes: ["read_api"] }, { scopes: ["read_repository"] }])("accepts read-only scope subset %j", async ({ scopes }) => {
    await assertReadOnlyToken(config, repo, env, async () => response({ scopes }));
  });

  test.each([
    { scopes: ["api"] }, { scopes: ["read_api", "write_repository"] }, {}, { scopes: null },
    { scopes: "read_api" }, { scopes: [3] }, { scopes: ["READ_API"] }, null,
  ])("refuses missing, malformed or disallowed scopes before project read %j", async body => {
    const dirs: string[] = [];
    await expect(assertReadOnlyToken(config, repo, env, async (_bin, args, opts) => {
      expect(args[1]).toBe("/personal_access_tokens/self");
      dirs.push(inspectConfig(opts?.env));
      return response(body);
    })).rejects.toThrow(source);
    expect(dirs).toHaveLength(1);
    expect(existsSync(dirs[0])).toBeFalse();
  });

  test.each([201, 204, 301, 401, 403, 404, 500])("refuses non-200 introspection HTTP %i", async status => {
    let calls = 0;
    await expect(assertReadOnlyToken(config, repo, env, async () => {
      calls++; return response({ scopes: ["read_api"] }, status, 0);
    })).rejects.toThrow(source);
    expect(calls).toBe(1);
  });

  test.each([401, 404])("refuses inaccessible project HTTP %i", async status => {
    let calls = 0;
    const dirs: string[] = [];
    await expect(assertReadOnlyToken(config, repo, env, async (_bin, _args, opts) => {
      dirs.push(inspectConfig(opts?.env));
      return ++calls === 1 ? response({ scopes: ["read_api"] }) : response({}, status);
    })).rejects.toThrow(source);
    expect(calls).toBe(2);
    for (const dir of dirs) expect(existsSync(dir)).toBeFalse();
  });

  test("spawn errors clean config and do not echo token material", async () => {
    let dir = "";
    await expect(assertReadOnlyToken(config, repo, env, async (_bin, _args, opts) => {
      dir = inspectConfig(opts?.env); throw new Error(secret);
    })).rejects.toThrow(`${source}: GitLab read gate failed before map reads`);
    expect(existsSync(dir)).toBeFalse();
  });

  test("malformed HTTP/JSON and nonzero exits fail closed", async () => {
    for (const result of [{ code: 0, stdout: '{"scopes":["read_api"]}', stderr: "" },
      { code: 0, stdout: "HTTP/2.0 200 OK\n\nnot JSON", stderr: "" },
      response({ scopes: ["read_api"] }, 200, 1)]) {
      await expect(assertReadOnlyToken(config, repo, env, async () => result)).rejects.toThrow(source);
    }
  });

  test("unvalidated, copied and cross-project/host credentials cannot read", async () => {
    const { token } = await assertReadOnlyToken(config, repo, env, async () => response({ scopes: ["read_api"] }));
    expect(Object.isFrozen(token)).toBeTrue();
    let calls = 0;
    const runner: typeof runCmd = async () => { calls++; return response({}); };
    for (const [target, credential] of [[repo, { ...token }], [`gitlab:${host}/team/other`, token],
      ["gitlab:other.host/team/sub/project", token]] as const) {
      await expect(gitlabApiRead(target, credential, "user", runner)).rejects.toThrow(GateError);
      await expect(callGraph({ verb: "node", root: "1", repo: target, token: credential, opts: { runner } })).rejects.toThrow(GateError);
    }
    await expect(gitlabApiRead(repo, token, "https://other.host/api", runner)).rejects.toThrow(GateError);
    expect(calls).toBe(0);
  });

  test("graph and API failures clean the per-call directory", async () => {
    const { token } = await assertReadOnlyToken(config, repo, env, async () => response({ scopes: ["read_api"] }));
    for (const throws of [true, false]) {
      let dir = "";
      const runner: typeof runCmd = async (_bin, _args, opts) => {
        dir = inspectConfig(opts?.env);
        if (throws) throw new Error("spawn failed");
        return response({}, 401);
      };
      for (const read of [() => gitlabApiRead(repo, token, "user", runner),
        () => callGraph({ verb: "audit", root: "1", repo, token, opts: { runner } })]) {
        if (throws) await expect(read()).rejects.toThrow("spawn failed");
        else expect((await read()).code).toBe(1);
        expect(existsSync(dir)).toBeFalse();
      }
    }
  });

  test("one gate per tick; a fresh tick observes newly write-capable scopes", async () => {
    let scopes = ["read_api"];
    let calls = 0;
    const gate = (c: RangerConfig, r: string) => assertReadOnlyToken(c, r, env, async () => {
      calls++; return response({ scopes });
    });
    const batch = tokenBatch(config, gate);
    await Promise.all([batch(repo), batch(repo)]);
    expect(calls).toBe(2);
    scopes = ["api"];
    const next = tokenBatch(config, gate);
    await expect(next(repo)).rejects.toThrow(source);
    await expect(next(repo)).rejects.toThrow(source);
    expect(calls).toBe(3);
  });

  test("GitLab forge dispatch never invokes gh, even for copied or cross-project tokens", async () => {
    const { token } = await assertReadOnlyToken(config, repo, env, async () => response({ scopes: ["read_api"] }));
    const journal = new Journal(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "ranger-gitlab-budget-"));
    const calls = join(dir, "gh-called");
    const oldPath = process.env.PATH;
    writeFileSync(join(dir, "gh"), `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(calls)}, "called");\n`, { mode: 0o700 });
    process.env.PATH = `${dir}:${oldPath ?? ""}`;
    let reads = 0;
    const read = async () => { reads++; return "read"; };
    const policy = { floor: 1000, cooldownMs: 1 };
    try {
      expect(await budgetedRead(journal, repo, token, policy, new Date(), read)).toBe("read");
      await expect(budgetedRead(journal, repo, { ...token }, policy, new Date(), read)).rejects.toThrow(GateError);
      await expect(budgetedRead(journal, `gitlab:${host}/team/other`, token, policy, new Date(), read)).rejects.toThrow(GateError);
      expect(reads).toBe(1);
      expect(existsSync(calls)).toBeFalse();
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
      journal.close();
    }
  });

  test("GitLab throttles persist, defer without reading, back off and clear on success", async () => {
    const { token } = await assertReadOnlyToken(config, repo, env, async () => response({ scopes: ["read_api"] }));
    const journal = new Journal(":memory:");
    const policy = { floor: 1000, cooldownMs: 1000 };
    let reads = 0;
    const throttle = async () => { reads++; throw new RateLimitError("GitLab rate limit"); };
    const t0 = new Date("2026-10-07T10:00:00Z");
    try {
      await expect(budgetedRead(journal, repo, token, policy, t0, throttle)).rejects.toThrow(BudgetDeferral);
      expect(activeCooldown(journal, cooldownScope(repo, source), t0)).toMatchObject({ strikes: 1, reason: "GitLab rate limit, throttle 1 in a row" });
      await expect(budgetedRead(journal, repo, token, policy, t0, throttle)).rejects.toThrow(BudgetDeferral);
      expect(reads).toBe(1);
      const t1 = new Date(t0.getTime() + 1001);
      await expect(budgetedRead(journal, repo, token, policy, t1, throttle)).rejects.toThrow(BudgetDeferral);
      expect(activeCooldown(journal, cooldownScope(repo, source), t1)?.until.getTime()).toBe(t1.getTime() + 2000);
      const t2 = new Date(t1.getTime() + 2001);
      expect(await budgetedRead(journal, repo, token, policy, t2, async () => "ok")).toBe("ok");
      expect(activeCooldown(journal, cooldownScope(repo, source), t2)).toBeNull();
      await expect(budgetedRead(journal, repo, token, policy, t2, throttle)).rejects.toThrow(BudgetDeferral);
      expect(activeCooldown(journal, cooldownScope(repo, source), t2)?.strikes).toBe(1);
    } finally { journal.close(); }
  });
});

describe("principal keyring probe (stubbed only)", () => {
  test.each([401, 200, 403, 500])("exit zero only for unauthorized HTTP %i", async status => {
    let dir = "";
    const code = await probeGlabKeyring(host, async (bin, args, opts) => {
      expect(bin).toBe("glab");
      expect(args).toEqual(["api", "user", "--hostname", host, "--include"]);
      dir = inspectConfig(opts?.env, "");
      return response({}, status);
    });
    expect(code).toBe(status === 401 ? 0 : 1);
    expect(existsSync(dir)).toBeFalse();
  });

  test("unknown failures and spawn failures never pass", async () => {
    expect(await probeGlabKeyring(host, async () => ({ code: 1, stdout: "", stderr: "timeout" }))).toBe(1);
    await expect(probeGlabKeyring(host, async () => { throw new Error("missing glab"); })).rejects.toThrow("missing glab");
  });

  test("config helper strips inherited tokens even with an empty token", () => {
    const gated = glabConfigEnv(host, "", env);
    try { inspectConfig(gated.env, ""); } finally { gated.cleanup(); }
    expect(existsSync(gated.env.GLAB_CONFIG_DIR!)).toBeFalse();
  });

  test("config helper forwards only runtime variables from the parent", () => {
    const runtime = { PATH: "/bin", HOME: "/home/worker", TMPDIR: "/tmp", LANG: "en_US.UTF-8", LC_ALL: "C", TZ: "UTC" };
    const gated = glabConfigEnv(host, "", { ...env, ...runtime, NODE_OPTIONS: "--require injected.js", XDG_CONFIG_HOME: "/principal/config" });
    try {
      expect(gated.env).toEqual({ ...runtime, GLAB_CONFIG_DIR: gated.env.GLAB_CONFIG_DIR, SOMA_GRAPH_READONLY: "1" });
    } finally { gated.cleanup(); }
  });
});
