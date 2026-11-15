import { describe, expect, test } from "bun:test";
import {
  parseGhHeaders,
  matchTokenEnv,
  resolveReadOnlyToken,
  GateError,
  tokenBatch,
  assertReadOnlyToken,
  ReadOnlyTokenCache,
  TOKEN_GATE_CACHE_MS,
} from "../src/token-gate.ts";
import type { RangerConfig } from "../src/config.ts";
import type { runCmd, RunResult } from "../src/exec.ts";
import { GitHubCoreCooldown, meteredGh } from "../src/github-usage.ts";

describe("assertReadOnlyToken — bounded GitHub reuse", () => {
  const config = { auth: { readOnlyTokens: { "*": "RO" }, writeTokens: {} } } as unknown as RangerConfig;
  const response = (options: { scopes?: string; remaining?: number; reset?: number; code?: number; resource?: string; stderr?: string } = {}): RunResult => ({
    code: options.code ?? 0,
    stdout: [
      `HTTP/2.0 ${options.code ? 403 : 200} Status`,
      `X-OAuth-Scopes: ${options.scopes ?? "read:org"}`,
      `X-RateLimit-Remaining: ${options.remaining ?? 100}`,
      `X-RateLimit-Resource: ${options.resource ?? "core"}`,
      ...(options.reset === undefined ? [] : [`X-RateLimit-Reset: ${options.reset}`]),
      "", '{"login":"scout"}',
    ].join("\r\n"),
    stderr: options.stderr ?? "",
  });

  function harness() {
    let now = Date.parse("2026-11-15T10:00:00Z");
    const cooldown = new GitHubCoreCooldown(() => now);
    const cache = new ReadOnlyTokenCache(() => now, cooldown);
    const calls: { endpoint: string; token: string | undefined }[] = [];
    let respond = (_endpoint: string): RunResult | Promise<RunResult> => response();
    const runner: typeof runCmd = async (_bin, args, opts) => {
      expect(args).toContain("-i");
      expect(opts?.env?.GH_CONFIG_DIR).toBeTruthy();
      calls.push({ endpoint: args[1], token: opts?.env?.GH_TOKEN });
      return respond(args[1]);
    };
    return {
      calls,
      cooldown,
      gate: (repo = "acme/a", token = "fixture-token") => assertReadOnlyToken(config, repo, { RO: token }, runner, cache),
      advance: (ms: number) => { now += ms; },
      reset: () => now / 1000 + 3600,
      respond: (fn: typeof respond) => { respond = fn; },
    };
  }

  test("fresh batches share introspection across repos and reuse successful repo checks", async () => {
    const h = harness();
    const first = await h.gate();
    const nextBatch = tokenBatch(config, (_config, repo) => h.gate(repo));
    await nextBatch("github:github.com/Acme/A");
    await h.gate("acme/b");
    h.advance(TOKEN_GATE_CACHE_MS - 1);
    expect((await h.gate()).info).toEqual(first.info);
    expect(h.calls.map(call => call.endpoint)).toEqual(["/user", "repos/acme/a", "repos/acme/b"]);
  });

  test("expiry refreshes the gate and refuses a newly added write scope", async () => {
    const h = harness();
    await h.gate();
    h.respond(() => response({ scopes: "read:org, repo" }));
    h.advance(TOKEN_GATE_CACHE_MS - 1);
    await h.gate();
    expect(h.calls).toHaveLength(2);
    h.advance(1);
    await expect(h.gate()).rejects.toThrow(/write-capable/);
    await expect(h.gate()).rejects.toThrow(/write-capable/);
    expect(h.calls.map(call => call.endpoint)).toEqual(["/user", "repos/acme/a", "/user", "/user"]);
    h.respond(() => response());
    await h.gate();
    expect(h.calls.slice(-2).map(call => call.endpoint)).toEqual(["/user", "repos/acme/a"]);
  });

  test("repo access expires independently of refreshed introspection", async () => {
    const h = harness();
    await h.gate();
    h.advance(TOKEN_GATE_CACHE_MS - 1);
    await h.gate("acme/b");
    h.advance(1);
    await h.gate("acme/b");
    await h.gate();
    expect(h.calls.map(call => call.endpoint)).toEqual(["/user", "repos/acme/a", "repos/acme/b", "/user", "repos/acme/a"]);
  });

  test("rotated tokens require fresh checks; aliases of a token share checks", async () => {
    const h = harness();
    await h.gate();
    await h.gate("acme/a", "replacement");
    expect(h.calls.map(call => call.token)).toEqual(["fixture-token", "fixture-token", "replacement", "replacement"]);
    const alias = { auth: { readOnlyTokens: { "*": "ALIAS" }, writeTokens: {} } } as unknown as RangerConfig;
    const cache = new ReadOnlyTokenCache();
    let calls = 0;
    const runner: typeof runCmd = async () => { calls++; return response(); };
    await assertReadOnlyToken(config, "acme/a", { RO: "same" }, runner, cache);
    await assertReadOnlyToken(alias, "acme/a", { ALIAS: "same" }, runner, cache);
    expect(calls).toBe(2);
  });

  test.each(["/user", "repos/acme/a"])("an empty core window from %s blocks every repo until reset", async endpoint => {
    const h = harness();
    const reset = h.reset();
    h.respond(path => path === endpoint ? response({ remaining: 0, reset, code: 1, stderr: "rate limit exceeded" }) : response());
    await expect(h.gate()).rejects.toMatchObject({ transient: true });
    const calls = h.calls.length;
    h.advance(3_600_000 - 1);
    await expect(h.gate()).rejects.toMatchObject({ transient: true });
    await expect(h.gate("acme/b")).rejects.toMatchObject({ transient: true });
    expect(h.calls).toHaveLength(calls);
    h.respond(() => response());
    await h.gate("acme/a", "other-token");
    expect(h.calls).toHaveLength(calls + 2);
    h.advance(1);
    await h.gate();
    expect(h.calls.slice(-2).map(call => call.endpoint)).toEqual(["/user", "repos/acme/a"]);
  });

  test("a successful last core call stops requests and overrides cached passes", async () => {
    const h = harness();
    await h.gate();
    h.respond(() => response({ remaining: 0, reset: h.reset() }));
    await h.gate("acme/b");
    await expect(h.gate()).rejects.toMatchObject({ transient: true });
    await expect(h.gate("acme/c")).rejects.toMatchObject({ transient: true });
    expect(h.calls).toHaveLength(3);
    const firstCall = harness();
    firstCall.respond(() => response({ remaining: 0, reset: firstCall.reset() }));
    await expect(firstCall.gate()).rejects.toMatchObject({ transient: true });
    expect(firstCall.calls.map(call => call.endpoint)).toEqual(["/user"]);
  });

  test.each(["/user", "repos/acme/a"])("other refusals at %s cache neither introspection nor access", async endpoint => {
    const h = harness();
    h.respond(path => path === endpoint ? response({ code: 1, stderr: "access denied" }) : response());
    await expect(h.gate()).rejects.toMatchObject({ transient: false });
    const before = h.calls.length;
    h.respond(() => response());
    await h.gate();
    expect(h.calls.length - before).toBe(2);
  });

  test("network failures remain transient and are retried", async () => {
    const h = harness();
    h.respond(() => response({ code: 1, stderr: "error connecting to api.github.com" }));
    await expect(h.gate()).rejects.toMatchObject({ transient: true });
    await expect(h.gate()).rejects.toMatchObject({ transient: true });
    expect(h.calls).toHaveLength(2);
  });

  test.each([
    { remaining: 0 }, { remaining: 0, reset: 1 },
    { remaining: 1, reset: 9999999999 }, { remaining: 0, reset: 9999999999, resource: "graphql" },
  ])("unusable or non-core reset evidence does not create a cooldown: %j", async evidence => {
    const h = harness();
    h.respond(() => response({ ...evidence, code: 1, stderr: "access denied" }));
    await expect(h.gate()).rejects.toThrow(GateError);
    await expect(h.gate()).rejects.toThrow(GateError);
    expect(h.calls).toHaveLength(2);
  });

  test("concurrent gates share successful checks across repos", async () => {
    const h = harness();
    await Promise.all([h.gate(), h.gate(), h.gate("acme/b"), h.gate("acme/b")]);
    expect(h.calls.map(call => call.endpoint)).toEqual(["/user", "repos/acme/a", "repos/acme/b"]);
  });

  test("different repos start together while duplicate checks share one request", async () => {
    const h = harness();
    await h.gate();
    h.advance(TOKEN_GATE_CACHE_MS);
    const user = Promise.withResolvers<RunResult>();
    const a = Promise.withResolvers<RunResult>();
    const b = Promise.withResolvers<RunResult>();
    h.respond(path => path === "/user" ? user.promise : path === "repos/acme/a" ? a.promise : b.promise);
    const gates = Promise.all([h.gate(), h.gate(), h.gate("acme/b"), h.gate("acme/b")]);
    expect(h.calls.slice(2).map(call => call.endpoint)).toEqual(["/user"]);
    user.resolve(response());
    await Bun.sleep(0);
    const started = h.calls.slice(2).map(call => call.endpoint);
    a.resolve(response());
    b.resolve(response());
    await gates;
    expect(started).toEqual(["/user", "repos/acme/a", "repos/acme/b"]);
  });

  test("a late repo success cannot restore authorization after another repo refuses", async () => {
    const h = harness();
    const late = Promise.withResolvers<RunResult>();
    h.respond(path => path === "repos/acme/b" ? late.promise : response({ code: path === "repos/acme/a" ? 1 : 0, stderr: "access denied" }));
    const failed = h.gate();
    const pending = h.gate("acme/b");
    await expect(failed).rejects.toMatchObject({ transient: false });
    late.resolve(response());
    await pending;
    const before = h.calls.length;
    h.respond(() => response());
    await h.gate("acme/b");
    expect(h.calls.slice(before).map(call => call.endpoint)).toEqual(["/user", "repos/acme/b"]);
  });

  test("other metered callers share the gate's cooldown in both directions", async () => {
    const h = harness();
    await h.gate();
    let calls = 0;
    const runner: typeof runCmd = async () => {
      calls++;
      return response({ remaining: 0, reset: h.reset() });
    };
    const other = meteredGh({ component: "forge-port", source: "alias" }, runner, h.cooldown);
    await other("gh", ["api", "repos/acme/a/issues"], { env: { GH_TOKEN: "fixture-token" } });
    await expect(h.gate()).rejects.toMatchObject({ transient: true });
    expect(h.calls).toHaveLength(2);
    await other("gh", ["api", "repos/acme/b/issues"], { env: { GH_TOKEN: "fixture-token" } });
    expect(calls).toBe(1);

    const gateFirst = harness();
    gateFirst.respond(() => response({ remaining: 0, reset: gateFirst.reset(), code: 1 }));
    await expect(gateFirst.gate()).rejects.toMatchObject({ transient: true });
    const blocked = meteredGh({ component: "forge-port", source: "alias" }, runner, gateFirst.cooldown);
    expect((await blocked("gh", ["api", "repos/acme/a"], { env: { GH_TOKEN: "fixture-token" } })).code).toBe(1);
    expect(calls).toBe(1);
  });

  test("the default gate cache survives across fresh batches", async () => {
    let calls = 0;
    const runner: typeof runCmd = async () => { calls++; return response(); };
    const gate = (c: RangerConfig, repo: string) => assertReadOnlyToken(c, repo, { RO: "default-cache-fixture" }, runner);
    await tokenBatch(config, gate)("acme/default-cache");
    await tokenBatch(config, gate)("acme/default-cache");
    expect(calls).toBe(2);
  });

  test("an empty window observed by one gate holds all queued gates", async () => {
    const h = harness();
    h.respond(() => response({ remaining: 0, reset: h.reset(), code: 1 }));
    const results = await Promise.allSettled([h.gate(), h.gate(), h.gate("acme/b")]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ transient: true });
    }
    expect(h.calls).toHaveLength(1);
  });

  test("mutating returned introspection does not affect the cached authorization", async () => {
    const h = harness();
    const result = await h.gate();
    result.info.scopes.push("repo");
    expect((await h.gate()).info.scopes).toEqual(["read:org"]);
    expect(h.calls).toHaveLength(2);
  });

  test("one hour of refresh batches spends at most one check per token and repo each lifetime", async () => {
    const h = harness();
    for (let second = 0; second < 3600; second += 15) {
      const tokens = tokenBatch(config, (_config, repo) => h.gate(repo, repo.startsWith("other/") ? "second" : "first"));
      await Promise.all([tokens("acme/a"), tokens("acme/a"), tokens("acme/b"), tokens("other/c")]);
      h.advance(15_000);
    }
    expect(h.calls.filter(call => call.endpoint === "/user")).toHaveLength(8);
    for (const endpoint of ["repos/acme/a", "repos/acme/b", "repos/other/c"]) {
      expect(h.calls.filter(call => call.endpoint === endpoint)).toHaveLength(4);
    }
    expect(h.calls).toHaveLength(20);
  });
});

describe("parseGhHeaders", () => {
  test("classic token scopes are parsed from the header block", () => {
    const output = [
      "HTTP/2.0 200 OK",
      "content-type: application/json",
      "x-oauth-scopes: repo, read:org, workflow",
      "",
      '{"login":"jcfischer","id":1}',
    ].join("\n");
    const parsed = parseGhHeaders(output);
    expect(parsed.scopes).toEqual(["repo", "read:org", "workflow"]);
    expect(parsed.login).toBe("jcfischer");
  });

  test("fine-grained token (empty/absent scopes header) → empty scopes", () => {
    const output = [
      "HTTP/2.0 200 OK",
      "content-type: application/json",
      "x-oauth-scopes: ",
      "",
      '{"login":"scout-test"}',
    ].join("\n");
    expect(parseGhHeaders(output).scopes).toEqual([]);
  });

  test("missing header entirely → empty scopes", () => {
    expect(parseGhHeaders("HTTP/2.0 200 OK\n\n{}").scopes).toEqual([]);
  });
});

describe("matchTokenEnv — longest-prefix matching", () => {
  const auth = {
    readOnlyTokens: {
      "*": "RANGER_READONLY_GH_TOKEN",
      "the-metafactory/*": "RANGER_READONLY_GH_TOKEN_METAFACTORY",
      "jcfischer/seekolous": "RANGER_READONLY_GH_TOKEN_SEEKOLOUS",
    },
    writeTokens: {},
  };

  test("exact repo prefix beats wildcard", () => {
    expect(matchTokenEnv(auth, "jcfischer/seekolous")).toBe(
      "RANGER_READONLY_GH_TOKEN_SEEKOLOUS",
    );
  });

  test("org wildcard beats global wildcard", () => {
    expect(matchTokenEnv(auth, "the-metafactory/ranger")).toBe(
      "RANGER_READONLY_GH_TOKEN_METAFACTORY",
    );
  });

  test("unmatched repo falls to global wildcard", () => {
    expect(matchTokenEnv(auth, "someone/else")).toBe(
      "RANGER_READONLY_GH_TOKEN",
    );
  });
});

describe("resolveReadOnlyToken", () => {
  const config: RangerConfig = {
    version: 1,
    maps: [],
    auth: {
      readOnlyTokens: { "acme/*": "RANGER_RO_ACME" },
      writeTokens: {},
    },
    bot: {},
    principal: { login: "jcfischer" },
    state: { journalPath: ":memory:", canonicalRoot: "/tmp/ranger-repos", legacyMapRoots: {} },
    workers: { spawnCapPerDay: 10, laneSlots: { visual: 1, headless: 1 }, jobSlots: { visual: 1, headless: 1 }, wallClockMin: 90, maxAttempts: 2, probeRequeues: 2, deadmanThreshold: 3, reviewRounds: 2, maxBehindBase: 20, noCiGraceMin: 30, niceness: 10 },
  budget: { graphqlFloor: 1000, rateLimitCooldownMin: 10, frontierMaxAgeMin: 60 },
  ratify: { readsPerTick: 10 },
  intake: { model: "haiku" },
  substrates: { fiveHourMaxUsedPct: 70, sevenDayMaxUsedPct: 80, claudeProbeMaxAgeMin: 15, codexReadMaxAgeMin: 5, claude: { model: "claude-sonnet-5-5" }, codex: { model: "gpt-6.1-sol", reasoningEffort: "high" }, pi: { provider: "spark", model: "longctx-think", reviewEvery: 0 } },
  };

  test("resolves from env when set", () => {
    const resolved = resolveReadOnlyToken(config, "acme/widgets", {
      RANGER_RO_ACME: "github_pat_x",
    });
    expect(resolved).toEqual({
      token: "github_pat_x",
      source: "RANGER_RO_ACME",
    });
  });

  test("unset env → GateError (no keyring fallback)", () => {
    expect(() => resolveReadOnlyToken(config, "acme/widgets", {})).toThrow(
      GateError,
    );
    expect(() => resolveReadOnlyToken(config, "acme/widgets", {})).toThrow(
      /refusing to fall back to the gh keyring/,
    );
  });

  test("no mapping → GateError naming the config fix", () => {
    expect(() => resolveReadOnlyToken(config, "other/repo", {})).toThrow(
      /no read-only token mapping/,
    );
  });
});

describe("tokenBatch — the gate once per repo per batch (node #54)", () => {
  const config = {} as RangerConfig;

  test("same repo: one gate run; another repo: its own", async () => {
    const gated: string[] = [];
    const tokens = tokenBatch(config, async (_c, repo) => {
      gated.push(repo);
      return { token: { token: `t-${repo}`, source: "RANGER_RO" } };
    });
    const [a, b, c] = await Promise.all([tokens("acme/a"), tokens("acme/a"), tokens("acme/b")]);
    expect(a.token).toBe("t-acme/a");
    expect(b).toBe(a);
    expect(c.token).toBe("t-acme/b");
    expect(gated).toEqual(["acme/a", "acme/b"]);
  });

  test("a refusal is shared within the batch; a new batch runs the gate again", async () => {
    let runs = 0;
    const gate = async (): Promise<{ token: { token: string; source: string } }> => {
      runs += 1;
      throw new GateError("write-capable token");
    };
    const tokens = tokenBatch(config, gate);
    await expect(tokens("acme/a")).rejects.toThrow(/write-capable/);
    await expect(tokens("acme/a")).rejects.toThrow(/write-capable/);
    expect(runs).toBe(1);
    await expect(tokenBatch(config, gate)("acme/a")).rejects.toThrow(GateError);
    expect(runs).toBe(2);
  });
});
