import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerConfig } from "../src/config.ts";
import type { RunResult } from "../src/exec.ts";
import {
  activeCooldown,
  BudgetDeferral,
  budgetedRead,
  cooldownScope,
  setBudgetNoticeSink,
} from "../src/budget.ts";
import { frontierCacheKey, readFrontier } from "../src/frontier-cache.ts";
import { GraphError, graphFailure, RateLimitError } from "../src/graph.ts";
import { Journal } from "../src/journal.ts";
import { assertReadOnlyToken, type ResolvedToken } from "../src/token-gate.ts";
import { isGitLabRateLimit, isTransientGitHubError } from "../src/transient.ts";

/**
 * Node #130: a GitLab map has no GraphQL allowance gate and no frontier
 * sentinel cache, and a GitLab 429 cools the map down like a GitHub limit.
 */

const host = "gitlab.example.org";
const repo = `gitlab:${host}/team/sub/project`;
const source = "RANGER_RO_GITLAB";
const config = {
  auth: { readOnlyTokens: { [`gitlab:${host}/team/`]: source }, writeTokens: {} },
} as unknown as RangerConfig;
const env = { [source]: "read-token", PATH: process.env.PATH };
const policy = { floor: 1000, cooldownMs: 10 * 60_000 };
const HOUR = 60 * 60_000;

const scopes = (): RunResult => ({
  code: 0,
  stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ scopes: ["read_api"] })}`,
  stderr: "",
});

const FRONTIER = { repo, root: "1", frontier: [] };
const AUDIT = { repo, root: "1", nodes: 1, closedWithoutReceipt: [], openWithoutCheckpoint: [], openClaimed: [] };

let dir: string;
let ghCalled: string;
let oldPath: string | undefined;
let journal: Journal;
let token: ResolvedToken;
let notices: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ranger-gitlab-budget-"));
  ghCalled = join(dir, "gh-called");
  // Any gh call (an allowance read or a REST sentinel) leaves a mark.
  writeFileSync(join(dir, "gh"), `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(ghCalled)}, process.argv.slice(2).join(" ") + "\\n");\n`, { mode: 0o700 });
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  journal = new Journal(":memory:");
  ({ token } = await assertReadOnlyToken(config, repo, env, async () => scopes()));
  notices = [];
  setBudgetNoticeSink((line) => notices.push(line));
});

afterEach(() => {
  setBudgetNoticeSink();
  journal.close();
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
});

/** A stubbed soma: the verbs it ran, answering from `answer`. */
function soma(answer: (verb: string) => RunResult) {
  const verbs: string[] = [];
  const runner = async (_bin: string, args: string[]): Promise<RunResult> => {
    verbs.push(args[1]);
    return answer(args[1]);
  };
  return { verbs, runner };
}
const ok = (verb: string): RunResult => ({
  code: 0, stdout: JSON.stringify(verb === "audit" ? AUDIT : FRONTIER), stderr: "",
});

const read = (runner: ReturnType<typeof soma>["runner"], now = new Date()) =>
  readFrontier({ journal, repo, root: 1, token, policy, maxAgeMs: HOUR, now, runner });

describe("GitLab budget gate", () => {
  test("skips the GraphQL allowance read and floor, and says so once per process", async () => {
    let reads = 0;
    const read = async () => { reads++; return "read"; };
    expect(await budgetedRead(journal, repo, token, policy, new Date(), read)).toBe("read");
    expect(await budgetedRead(journal, repo, token, policy, new Date(), read)).toBe("read");
    expect(reads).toBe(2);
    expect(existsSync(ghCalled)).toBeFalse();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("GitLab");
  });
});

describe("GitLab frontier reads", () => {
  test("never take a sentinel or serve the cache: every scout reads fresh", async () => {
    const stub = soma(ok);
    const now = new Date();
    // A young entry under the map's key, the shape a GitHub hit would serve.
    const seeded = JSON.stringify({ sentinel: "x|1", fetchedAt: now.toISOString(), frontier: FRONTIER, briefs: [] });
    journal.setHealth(frontierCacheKey(repo, 1), seeded);
    expect((await read(stub.runner, now)).source).toBe("fresh");
    expect((await read(stub.runner, now)).source).toBe("fresh");
    expect(stub.verbs).toEqual(["frontier", "audit", "frontier", "audit"]);
    expect(existsSync(ghCalled)).toBeFalse();
    expect(journal.getHealth(frontierCacheKey(repo, 1))).toBe(seeded);
  });

  test("a soma 429 cools the map down per host and credential source", async () => {
    const t0 = new Date("2026-10-09T10:00:00Z");
    const limited = soma(() => ({
      code: 1,
      stdout: "",
      stderr: "glab api POST graphql failed (exit 1): glab: 429 Too Many Requests (HTTP 429)",
    }));
    await expect(read(limited.runner, t0)).rejects.toBeInstanceOf(BudgetDeferral);
    expect(activeCooldown(journal, cooldownScope(repo, source), t0)).toMatchObject({ kind: "throttled", strikes: 1 });
    // The same env var on another host, and a GitHub map, are not cooled.
    expect(activeCooldown(journal, cooldownScope(`gitlab:other.example.org/team/project`, source), t0)).toBeNull();
    expect(activeCooldown(journal, cooldownScope("acme/widgets", source), t0)).toBeNull();
    // The next read defers before calling soma.
    const next = soma(ok);
    await expect(read(next.runner, t0)).rejects.toBeInstanceOf(BudgetDeferral);
    expect(next.verbs).toEqual([]);
  });
});

describe("rate-limit classification", () => {
  const github = "acme/widgets";
  test.each([
    "glab: 429 Too Many Requests (HTTP 429)",
    "HTTP 429: Retry later",
    "HTTP/2 429",
    "Too Many Requests",
  ])("a GitLab error carrying %p is a RateLimitError", (stderr) => {
    expect(graphFailure("failed", stderr, repo)).toBeInstanceOf(RateLimitError);
    expect(isGitLabRateLimit(stderr)).toBeTrue();
  });

  test("a bare 429 that is not an HTTP status stays a GraphError", () => {
    const error = graphFailure("failed", "node team/sub/project#429 not found", repo);
    expect(error).toBeInstanceOf(GraphError);
    expect(error).not.toBeInstanceOf(RateLimitError);
  });

  test("GitHub classification is unchanged", () => {
    expect(graphFailure("failed", "API rate limit exceeded", github)).toBeInstanceOf(RateLimitError);
    expect(graphFailure("failed", "HTTP 429", github)).not.toBeInstanceOf(RateLimitError);
    expect(cooldownScope(github, source)).toBe(source);
  });

  test("a 429 is never a transient error to retry", () => {
    expect(isTransientGitHubError("glab: 429 Too Many Requests (HTTP 429)")).toBeFalse();
  });
});
