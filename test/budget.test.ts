import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetDeferral,
  MAX_THROTTLE_MS,
  activeCooldown,
  budgetedRead,
} from "../src/budget.ts";
import { readFrontier } from "../src/frontier-cache.ts";
import { graphFrontier, somaRepo } from "../src/graph.ts";
import { Journal } from "../src/journal.ts";
import { fixturesBin } from "./support.ts";

/**
 * The GitHub budget gate (src/budget.ts) and the frontier cache
 * (src/frontier-cache.ts), against the fake gh/soma. The fake soma logs every
 * call to FAKE_SOMA_CALLS, so "no GraphQL spent" is checked as "soma was not
 * called".
 */

const dataDir = join(import.meta.dir, "fixtures", "data");
const REPO = "acme/widgets";
const TOKEN = { token: "github_pat_readonly", source: "RANGER_RO_TEST" };
const POLICY = { floor: 1000, cooldownMs: 10 * 60_000 };
const HOUR = 60 * 60_000;

const ENV_KEYS = [
  "PATH",
  "FAKE_SOMA_DIR",
  "FAKE_SOMA_CALLS",
  "FAKE_GH_CALLS",
  "FAKE_SOMA_RATE_LIMITED",
  "FAKE_GH_GRAPHQL_REMAINING",
  "FAKE_GH_ISSUES_UPDATED",
  "FAKE_GH_EVENTS_LATEST",
  "FAKE_GH_SENTINEL_FAIL",
] as const;

let dir: string;
let calls: string;
let ghCalls: string;
let journal: Journal;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), "ranger-budget-"));
  calls = join(dir, "soma-calls.log");
  ghCalls = join(dir, "gh-calls.log");
  writeFileSync(calls, "");
  writeFileSync(ghCalls, "");
  process.env.PATH = `${fixturesBin}:${saved.PATH ?? ""}`;
  process.env.FAKE_SOMA_DIR = dataDir;
  process.env.FAKE_SOMA_CALLS = calls;
  process.env.FAKE_GH_CALLS = ghCalls;
  for (const k of ENV_KEYS.slice(4)) delete process.env[k];
  journal = new Journal(join(dir, "state.sqlite"));
});

afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const somaCalls = () =>
  readFileSync(calls, "utf8").split("\n").filter(Boolean).length;

const read = (now: Date, maxAgeMs = HOUR) =>
  readFrontier({
    journal,
    repo: REPO,
    root: 1,
    token: TOKEN,
    policy: POLICY,
    maxAgeMs,
    now,
  });

describe("somaRepo — the forge-qualified --repo (launchd runs from /)", () => {
  test("qualifies a bare owner/name and passes a qualified one through", () => {
    expect(somaRepo("jcfischer/seelite")).toBe(
      "github:github.com/jcfischer/seelite",
    );
    expect(somaRepo("github:github.com/a/b")).toBe("github:github.com/a/b");
  });
});

describe("budgetedRead — the GraphQL floor and the rate-limit cooldown", () => {
  const frontier = (now: Date) =>
    budgetedRead(journal, REPO, TOKEN, POLICY, now, () =>
      graphFrontier(REPO, 1, TOKEN),
    );

  test("reads when the allowance is above the floor", async () => {
    const result = await frontier(new Date());
    expect(result.frontier.length).toBeGreaterThan(0);
    expect(somaCalls()).toBe(1);
  });

  test("defers under the floor without calling soma, and cools the token down", async () => {
    process.env.FAKE_GH_GRAPHQL_REMAINING = "200";
    const now = new Date();
    await expect(frontier(now)).rejects.toBeInstanceOf(BudgetDeferral);
    expect(somaCalls()).toBe(0);
    expect(activeCooldown(journal, TOKEN.source, now)).not.toBeNull();
  });

  test("a rate-limited read becomes a deferral; the next read defers without calling soma", async () => {
    process.env.FAKE_SOMA_RATE_LIMITED = "1";
    const now = new Date();
    await expect(frontier(now)).rejects.toBeInstanceOf(BudgetDeferral);
    expect(somaCalls()).toBe(1);

    // Secondary limit (allowance not spent) → policy cooldown, not the reset.
    const cooling = activeCooldown(journal, TOKEN.source, now);
    expect(cooling?.until.getTime()).toBe(now.getTime() + POLICY.cooldownMs);

    delete process.env.FAKE_SOMA_RATE_LIMITED;
    await expect(frontier(now)).rejects.toBeInstanceOf(BudgetDeferral);
    expect(somaCalls()).toBe(1);

    // Once the cooldown has passed, reads resume.
    const later = new Date(now.getTime() + POLICY.cooldownMs + 1);
    await frontier(later);
    expect(somaCalls()).toBe(2);
  });

  test("a cooldown is per token: another token still reads", async () => {
    process.env.FAKE_SOMA_RATE_LIMITED = "1";
    const now = new Date();
    await expect(frontier(now)).rejects.toBeInstanceOf(BudgetDeferral);
    delete process.env.FAKE_SOMA_RATE_LIMITED;
    const other = { token: "ghp_write", source: "write-token" };
    await budgetedRead(journal, REPO, other, POLICY, now, () =>
      graphFrontier(REPO, 1, other),
    );
    expect(somaCalls()).toBe(2);
  });
});

describe("readFrontier — skip GraphQL while the repo's sentinel is unchanged", () => {
  test("the second read with an unchanged sentinel is served from the cache", async () => {
    const now = new Date();
    expect((await read(now)).source).toBe("fresh");
    const second = await read(new Date(now.getTime() + 15 * 60_000));
    expect(second.source).toBe("cache");
    expect(second.frontier.frontier.length).toBeGreaterThan(0);
    expect(somaCalls()).toBe(1);
  });

  test("an issue edit (newer updated_at) re-reads", async () => {
    const now = new Date();
    await read(now);
    process.env.FAKE_GH_ISSUES_UPDATED = "2026-01-02T00:00:00Z";
    expect((await read(now)).source).toBe("fresh");
    expect(somaCalls()).toBe(2);
  });

  test("a new blocked-by edge (newer issue event, same updated_at) re-reads", async () => {
    // Measured 2026-10-03: adding a blocked-by edge or a sub-issue does not
    // bump updated_at on either issue; only the repo issue-events feed moves.
    const now = new Date();
    await read(now);
    process.env.FAKE_GH_EVENTS_LATEST = "1001";
    expect((await read(now)).source).toBe("fresh");
    expect(somaCalls()).toBe(2);
  });

  test("a cached read older than the max age re-reads", async () => {
    const now = new Date();
    await read(now, HOUR);
    expect((await read(new Date(now.getTime() + HOUR), HOUR)).source).toBe(
      "fresh",
    );
    expect(somaCalls()).toBe(2);
  });

  test("an unreadable sentinel always reads fresh and never writes the cache", async () => {
    process.env.FAKE_GH_SENTINEL_FAIL = "1";
    const now = new Date();
    expect((await read(now)).source).toBe("fresh");
    delete process.env.FAKE_GH_SENTINEL_FAIL;
    expect((await read(now)).source).toBe("fresh");
    expect(somaCalls()).toBe(2);
  });

  test("under the floor a valid cache is still served; a stale one defers", async () => {
    const now = new Date();
    await read(now);
    process.env.FAKE_GH_GRAPHQL_REMAINING = "10";
    expect((await read(now)).source).toBe("cache");
    process.env.FAKE_GH_EVENTS_LATEST = "1002";
    await expect(read(now)).rejects.toBeInstanceOf(BudgetDeferral);
    expect(activeCooldown(journal, TOKEN.source, now)?.kind).toBe("floor");
    // REST is a separate bucket: during the floor cooldown, a map whose
    // sentinel matches again is still served from the cache.
    delete process.env.FAKE_GH_EVENTS_LATEST;
    expect((await read(now)).source).toBe("cache");
    expect(somaCalls()).toBe(1);
  });
});

describe("throttled — no GitHub call at all, and a backoff that spans ticks", () => {
  const ghCallCount = () =>
    readFileSync(ghCalls, "utf8").split("\n").filter(Boolean).length;

  test("a throttled token makes no gh or soma call, not even the sentinel", async () => {
    const now = new Date();
    await read(now); // cache populated
    process.env.FAKE_GH_EVENTS_LATEST = "2000";
    process.env.FAKE_SOMA_RATE_LIMITED = "1";
    await expect(read(now)).rejects.toBeInstanceOf(BudgetDeferral);
    expect(activeCooldown(journal, TOKEN.source, now)?.kind).toBe("throttled");

    delete process.env.FAKE_SOMA_RATE_LIMITED;
    writeFileSync(ghCalls, "");
    const before = somaCalls();
    // Even a cache that WOULD match is not consulted: checking it costs REST.
    delete process.env.FAKE_GH_EVENTS_LATEST;
    await expect(read(new Date(now.getTime() + 60_000))).rejects.toBeInstanceOf(
      BudgetDeferral,
    );
    expect(ghCallCount()).toBe(0);
    expect(somaCalls()).toBe(before);
  });

  test("consecutive throttles double the cooldown; a good read resets it", async () => {
    process.env.FAKE_SOMA_RATE_LIMITED = "1";
    const t0 = new Date("2026-10-03T12:00:00Z");
    await expect(read(t0)).rejects.toBeInstanceOf(BudgetDeferral);
    expect(activeCooldown(journal, TOKEN.source, t0)?.until.getTime()).toBe(
      t0.getTime() + POLICY.cooldownMs,
    );

    // The next tick after it passes: throttled again → 20 minutes.
    const t1 = new Date(t0.getTime() + 15 * 60_000);
    await expect(read(t1)).rejects.toBeInstanceOf(BudgetDeferral);
    const c1 = activeCooldown(journal, TOKEN.source, t1);
    expect(c1?.strikes).toBe(2);
    expect(c1?.until.getTime()).toBe(t1.getTime() + 2 * POLICY.cooldownMs);

    // A 20-minute cooldown spans the next 15-minute tick.
    const t2 = new Date(t1.getTime() + 15 * 60_000);
    await expect(read(t2)).rejects.toBeInstanceOf(BudgetDeferral);
    expect(activeCooldown(journal, TOKEN.source, t2)?.strikes).toBe(2);

    // Throttle lifts: a good read clears the strikes, so the next throttle
    // starts at 10 minutes again.
    delete process.env.FAKE_SOMA_RATE_LIMITED;
    const t3 = new Date(t1.getTime() + 21 * 60_000);
    expect((await read(t3)).source).toBe("fresh");
    expect(activeCooldown(journal, TOKEN.source, t3)).toBeNull();
    process.env.FAKE_SOMA_RATE_LIMITED = "1";
    process.env.FAKE_GH_EVENTS_LATEST = "3000";
    await expect(read(t3)).rejects.toBeInstanceOf(BudgetDeferral);
    expect(activeCooldown(journal, TOKEN.source, t3)?.strikes).toBe(1);
  });

  test("the backoff is capped at an hour", async () => {
    process.env.FAKE_SOMA_RATE_LIMITED = "1";
    let t = new Date("2026-10-03T12:00:00Z");
    for (let i = 0; i < 6; i++) {
      await expect(read(t)).rejects.toBeInstanceOf(BudgetDeferral);
      const c = activeCooldown(journal, TOKEN.source, t);
      expect(c!.until.getTime() - t.getTime()).toBeLessThanOrEqual(
        MAX_THROTTLE_MS,
      );
      t = new Date(c!.until.getTime() + 1);
    }
    expect(activeCooldown(journal, TOKEN.source, new Date(t.getTime() - 2))?.strikes).toBe(6);
  });
});
