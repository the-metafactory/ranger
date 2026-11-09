import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, type SubstrateReading } from "../src/journal.ts";
import type { RangerConfig, RangerMapConfig } from "../src/config.ts";
import { defaultNodeSelector } from "../src/node-dependency.ts";
import { buildQuotaSubstrates, freshReadings, persistReading, readOpenRouterCredit, selectSubstrate } from "../src/substrate.ts";
import { isEligible, QUOTA_SUBSTRATES, selectForBuild, selectForReview, type SubstrateConfig } from "../src/substrate-policy.ts";

const CONFIG: SubstrateConfig = {
 fiveHourMaxUsedPct: 70,
 sevenDayMaxUsedPct: 80,
 claudeProbeMaxAgeMin: 15,
 codexReadMaxAgeMin: 5,
};
const NOW = new Date("2026-11-09T12:00:00Z");

function keyResponse(data: Record<string, unknown>, status = 200): typeof fetch {
 return (async () => new Response(JSON.stringify({ data }), { status })) as unknown as typeof fetch;
}

function reading(substrate: SubstrateReading["substrate"], over: Partial<SubstrateReading> = {}): SubstrateReading {
 return {
  substrate,
  readAt: NOW.toISOString(),
  fiveHourUsedPct: null,
  sevenDayUsedPct: 30,
  fiveHourResetsAt: null,
  sevenDayResetsAt: null,
  resetsAt: null,
  capped: false,
  cappedUntil: null,
  ...over,
 };
}

describe("readOpenRouterCredit", () => {
 test("reads the monthly allowance as used% resetting at the next UTC month", async () => {
  const r = await readOpenRouterCredit("sk-or-test", keyResponse({ limit: 50, limit_remaining: 40, limit_reset: "monthly" }), NOW);
  expect(r).toEqual({
   substrate: "pi",
   readAt: NOW,
   windows: [{ kind: "seven_day", usedPct: 20, resetsAt: Date.UTC(2026, 11, 1) / 1000 }],
   capped: false,
   cappedUntil: null,
  });
 });

 test("an exhausted allowance is capped until the month resets", async () => {
  const r = await readOpenRouterCredit("sk-or-test", keyResponse({ limit: 50, limit_remaining: -0.2, limit_reset: "monthly" }), NOW);
  expect(r.capped).toBe(true);
  expect(r.cappedUntil).toBe(Date.UTC(2026, 11, 1) / 1000);
  expect(r.windows[0].usedPct).toBe(100);
 });

 test("no key, no limit, a non-monthly limit or an HTTP error fails the read", async () => {
  const ok = keyResponse({ limit: 50, limit_remaining: 40, limit_reset: "monthly" });
  await expect(readOpenRouterCredit(undefined, ok, NOW)).rejects.toThrow("OPENROUTER_API_KEY");
  await expect(readOpenRouterCredit("k", keyResponse({ limit: null, limit_remaining: null, limit_reset: null }), NOW)).rejects.toThrow();
  await expect(readOpenRouterCredit("k", keyResponse({ limit: 50, limit_remaining: 40, limit_reset: "weekly" }), NOW)).rejects.toThrow();
  await expect(readOpenRouterCredit("k", keyResponse({}, 401), NOW)).rejects.toThrow("HTTP 401");
 });
});

describe("Pi in the build share", () => {
 test("Pi takes builds in proportion to its allowance headroom", () => {
  const readings = [
   reading("claude", { sevenDayUsedPct: 70 }),
   reading("codex", { sevenDayUsedPct: 60 }),
   reading("pi", { sevenDayUsedPct: 50 }),
  ];
  expect(readings.map((r) => isEligible(r, CONFIG, NOW)?.headroom)).toEqual([10, 20, 30]);
  const recentBuilds = { claude: 0, codex: 0, pi: 0 };
  for (let i = 0; i < 60; i++) recentBuilds[selectForBuild({ readings, now: NOW, config: CONFIG, recentBuilds })] += 1;
  expect(recentBuilds).toEqual({ claude: 10, codex: 20, pi: 30 });
 });

 test("Pi past its reserve gets no share while claude or codex has room, and stays the fallback", () => {
  const pi = reading("pi", { sevenDayUsedPct: 90 });
  expect(selectForBuild({ readings: [reading("codex"), pi], now: NOW, config: CONFIG, recentBuilds: { codex: 99 } })).toBe("codex");
  expect(selectForBuild({ readings: [reading("codex", { sevenDayUsedPct: 95 }), pi], now: NOW, config: CONFIG })).toBe("pi");
 });

 test("a stale Pi reading gets no share", () => {
  const stale = reading("pi", { readAt: new Date(NOW.getTime() - 11 * 60_000).toISOString(), sevenDayUsedPct: 0 });
  expect(selectForBuild({ readings: [reading("codex"), stale], now: NOW, config: CONFIG, recentBuilds: { codex: 99 } })).toBe("codex");
 });

 test("reviews never go to Pi, whatever its allowance", () => {
  const readings = [reading("pi", { sevenDayUsedPct: 0 }), reading("codex", { sevenDayUsedPct: 95 })];
  expect(selectForReview({ readings, now: NOW, config: CONFIG }, "claude")).toBeNull();
 });

 test("freshReadings stores Pi's credit from its reader and asks no network when none is injected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-pi-credit-"));
  try {
   const journal = new Journal(join(dir, "state.sqlite"));
   const failing = () => Promise.reject(new Error("no read"));
   expect((await freshReadings(journal, CONFIG, NOW, { claude: failing, codex: failing })).map((r) => r.substrate)).toEqual([]);
   const credit = () => readOpenRouterCredit("k", keyResponse({ limit: 50, limit_remaining: 25, limit_reset: "monthly" }), NOW);
   const stored = await freshReadings(journal, CONFIG, NOW, { claude: failing, codex: failing, pi: credit }, QUOTA_SUBSTRATES);
   expect(stored.map((r) => [r.substrate, r.sevenDayUsedPct])).toEqual([["pi", 50]]);
   journal.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

describe("what a selection reads", () => {
 const rangerConfig = (provider: string) => ({ substrates: { ...CONFIG, pi: { provider, model: "m", reviewEvery: 0 } } }) as unknown as RangerConfig;
 const quota = (substrate: "claude" | "codex" | "pi") => async () => ({
  substrate,
  readAt: new Date(),
  windows: [{ kind: "five_hour" as const, usedPct: 10, resetsAt: Math.floor(Date.now() / 1000) + 5 * 3600 }],
  capped: false,
  cappedUntil: null,
 });

 function withJournal(run: (journal: Journal) => Promise<void>): () => Promise<void> {
  return async () => {
   const dir = mkdtempSync(join(tmpdir(), "ranger-pi-credit-"));
   const journal = new Journal(join(dir, "state.sqlite"));
   try {
    await run(journal);
   } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
   }
  };
 }

 test("Pi's OpenRouter credit is read for builds only while Pi runs on OpenRouter", () => {
  expect(buildQuotaSubstrates(rangerConfig("openrouter"))).toEqual(["claude", "codex", "pi"]);
  expect(buildQuotaSubstrates(rangerConfig("spark"))).toEqual(["claude", "codex"]);
 });

 test("a review selection never waits on Pi's credit", withJournal(async (journal) => {
  let piReads = 0;
  const readers = { claude: quota("claude"), codex: quota("codex"), pi: async () => { piReads++; return quota("pi")(); } };
  const { substrate } = await selectSubstrate(journal, { config: CONFIG, excluded: new Set(), readers, pick: (input) => selectForReview(input, "claude") });
  expect(substrate).toBe("codex");
  expect(piReads).toBe(0);
 }));

 test("a cached OpenRouter credit gives Pi no share once Pi runs elsewhere", withJournal(async (journal) => {
  persistReading(journal, await readOpenRouterCredit("k", keyResponse({ limit: 50, limit_remaining: 50, limit_reset: "monthly" })));
  const tired = (substrate: "claude" | "codex") => async () => ({ ...(await quota(substrate)()), windows: [{ kind: "five_hour" as const, usedPct: 60, resetsAt: Math.floor(Date.now() / 1000) + 5 * 3600 }] });
  const readers = { claude: tired("claude"), codex: tired("codex") };
  const select = defaultNodeSelector(rangerConfig("spark"), journal, readers);
  const picks = new Set<string>();
  for (let i = 0; i < 4; i++) picks.add(await select({} as RangerMapConfig, "implement"));
  expect(picks).toEqual(new Set(["claude", "codex"]));
  const { substrate } = await selectSubstrate(journal, { config: CONFIG, excluded: new Set(), readers, pick: selectForBuild, refresh: buildQuotaSubstrates(rangerConfig("spark")) });
  expect(substrate).not.toBe("pi");
 }));

 test("a dispatch pass counts each build once, though its sessions start mid-pass", withJournal(async (journal) => {
  journal.upsertWorker({ root: 1, nodeId: "7", repo: "acme/widgets", status: "claimed" });
  const generation = journal.getWorker("7", "acme/widgets")!.generation;
  const select = defaultNodeSelector(rangerConfig("spark"), journal, { claude: quota("claude"), codex: quota("codex") });
  const picks = { claude: 0, codex: 0, pi: 0 };
  for (let i = 0; i < 10; i++) {
   const substrate = await select({} as RangerMapConfig, "implement");
   picks[substrate] += 1;
   journal.startSubstrateSession({ substrate, kind: "worker", repo: "acme/widgets", nodeId: "7", generation });
  }
  expect(picks).toEqual({ claude: 5, codex: 5, pi: 0 });
 }));
});
