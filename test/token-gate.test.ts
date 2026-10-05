import { describe, expect, test } from "bun:test";
import {
  parseGhHeaders,
  matchTokenEnv,
  resolveReadOnlyToken,
  GateError,
  tokenBatch,
} from "../src/token-gate.ts";
import type { RangerConfig } from "../src/config.ts";

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
    workers: { spawnCapPerDay: 10, wallClockMin: 90, maxAttempts: 2, deadmanThreshold: 3, reviewRounds: 2, niceness: 10 },
  budget: { graphqlFloor: 1000, rateLimitCooldownMin: 10, frontierMaxAgeMin: 60 },
  substrates: { fiveHourMaxUsedPct: 70, sevenDayMaxUsedPct: 80, claudeProbeMaxAgeMin: 15, codexReadMaxAgeMin: 5, codex: { model: "gpt-6.1-sol", reasoningEffort: "high" }, pi: { provider: "spark", model: "longctx-think" } },
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
