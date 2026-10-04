import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openJournal, type Journal, type SubstrateReading } from "../src/journal.ts";
import {
 confirmCap,
 describeWorkerModel,
 detectClaudeCap,
 drainJsonLines,
 effectiveThreshold,
 extractClaudeResultText,
 freshReadings,
 isClaudeSignalLine,
 markSubstrateCapped,
 parseClaudeRateLimitEvent,
 parseCodexQuota,
 persistReading,
 type QuotaReading,
 workerOutputFor,
 workerCommandFor,
 workerModelFor,
 type ClaudeRateLimitEvent,
 type CodexRateLimitsResponse,
} from "../src/substrate.ts";
import {
 describeReadings,
 isEligible,
 selectForBuild,
 selectForReview,
 type SubstrateConfig,
} from "../src/substrate-policy.ts";
import { recordedReviews, reviewMarker } from "../src/implement.ts";
import { sageReview } from "../src/review.ts";
import { runCmd } from "../src/exec.ts";
import { baseConfigLines } from "./support.ts";

const SHA = "a".repeat(40);

const DEFAULT_CONFIG: SubstrateConfig = {
 fiveHourMaxUsedPct: 70,
 sevenDayMaxUsedPct: 80,
 claudeProbeMaxAgeMin: 15,
 codexReadMaxAgeMin: 5,
};

function reading(
 substrate: SubstrateReading["substrate"],
 over: Partial<SubstrateReading> = {},
): SubstrateReading {
 return {
  substrate,
  readAt: new Date().toISOString(),
  fiveHourUsedPct: 20,
  sevenDayUsedPct: 30,
  fiveHourResetsAt: null,
  sevenDayResetsAt: null,
  resetsAt: null,
  capped: false,
  cappedUntil: null,
  ...over,
 };
}

// ---- Codex quota parser ----

describe("parseCodexQuota", () => {
 test("parses the sample response with primary 7d window", () => {
  const resp: CodexRateLimitsResponse = {
   rateLimits: {
    primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1791647617 },
    secondary: null,
    rateLimitReachedType: null,
   },
  };
  const q = parseCodexQuota(resp);
  expect(q.substrate).toBe("codex");
  expect(q.capped).toBe(false);
  expect(q.windows).toEqual([
   { kind: "seven_day", usedPct: 2, resetsAt: 1791647617 },
  ]);
 });

 test("parses both windows", () => {
  const resp: CodexRateLimitsResponse = {
   rateLimits: {
    primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 100 },
    secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 200 },
    rateLimitReachedType: null,
   },
  };
  const q = parseCodexQuota(resp);
  expect(q.windows).toHaveLength(2);
  expect(q.windows[0].kind).toBe("five_hour");
  expect(q.windows[1].kind).toBe("seven_day");
 });

 test("marks capped when rateLimitReachedType is non-null", () => {
  const resp: CodexRateLimitsResponse = {
   rateLimits: {
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 999 },
    secondary: null,
    rateLimitReachedType: "primary",
   },
  };
  const q = parseCodexQuota(resp);
  expect(q.capped).toBe(true);
  expect(q.cappedUntil).toBe(999);
 });

 test("marks capped when ordinaryUsageAllowed is false", () => {
  const q = parseCodexQuota({
   ordinaryUsageAllowed: false,
   rateLimits: {
    primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1791647617 },
    secondary: null,
    rateLimitReachedType: null,
   },
  });
  expect(q.capped).toBe(true);
  expect(q.cappedUntil).toBe(1791647617);
 });

 test("handles null windows gracefully", () => {
  const resp: CodexRateLimitsResponse = {
   rateLimits: {
    primary: null,
    secondary: null,
    rateLimitReachedType: null,
   },
  };
  const q = parseCodexQuota(resp);
  expect(q.windows).toHaveLength(0);
  expect(q.capped).toBe(false);
 });

 test("a window of an unknown duration fails the read, so Codex stays ineligible", async () => {
  const resp: CodexRateLimitsResponse = {
   rateLimits: {
    primary: { usedPercent: 99, windowDurationMins: 1440, resetsAt: 1791647617 },
    secondary: null,
    rateLimitReachedType: null,
   },
  };
  expect(() => parseCodexQuota(resp)).toThrow("1440-minute window");

  await withJournal(async (journal) => {
   const now = new Date();
   const readings = await freshReadings(journal, DEFAULT_CONFIG, now, {
    codex: async () => parseCodexQuota(resp, now),
    claude: () => Promise.reject(new Error("unread")),
   });
   expect(readings.find((r) => r.substrate === "codex")).toBeUndefined();
   expect(selectForBuild({ readings, now, config: DEFAULT_CONFIG })).toBe("pi");
  });
 });
});

// ---- Claude quota parser ----

describe("parseClaudeRateLimitEvent", () => {
 test("parses the sample rate_limit_event", () => {
  const event: ClaudeRateLimitEvent = {
   type: "rate_limit_event",
   rate_limit_info: {
    status: "allowed",
    resetsAt: 1791055200,
    rateLimitType: "five_hour",
    unifiedWindows: {
     five_hour: { utilization: 0.28, resetsAt: 1791055200 },
     seven_day: { utilization: 0.75, resetsAt: 1791118800 },
    },
   },
  };
  const q = parseClaudeRateLimitEvent(event);
  expect(q.substrate).toBe("claude");
  expect(q.capped).toBe(false);
  expect(q.windows).toEqual([
   { kind: "five_hour", usedPct: 28, resetsAt: 1791055200 },
   { kind: "seven_day", usedPct: 75, resetsAt: 1791118800 },
  ]);
 });

 test("allowed_warning is a warning, not a cap", () => {
  const q = parseClaudeRateLimitEvent({
   type: "rate_limit_event",
   rate_limit_info: {
    status: "allowed_warning",
    resetsAt: 1791055200,
    unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: 1791055200 } },
   },
  });
  expect(q.capped).toBe(false);
  expect(q.cappedUntil).toBeNull();
  // The threshold, not the status, keeps a near-limit Claude out of selection.
  expect(q.windows[0].usedPct).toBe(90);
 });

 test("marks capped for any status it does not know (fail closed)", () => {
  const event: ClaudeRateLimitEvent = {
   type: "rate_limit_event",
   rate_limit_info: {
    status: "rate_limited",
    resetsAt: 1791055200,
    rateLimitType: "five_hour",
    unifiedWindows: {
     five_hour: { utilization: 1.0, resetsAt: 1791055200 },
    },
   },
  };
  const q = parseClaudeRateLimitEvent(event);
  expect(q.capped).toBe(true);
  expect(q.cappedUntil).toBe(1791055200);
 });

 test("handles missing unifiedWindows", () => {
  const event: ClaudeRateLimitEvent = {
   type: "rate_limit_event",
   rate_limit_info: {
    status: "allowed",
    resetsAt: 100,
    rateLimitType: "five_hour",
   },
  };
  const q = parseClaudeRateLimitEvent(event);
  expect(q.windows).toHaveLength(0);
  expect(q.capped).toBe(false);
 });

 test("a reported window without resetsAt persists with its fixed threshold", async () => {
  await withJournal((journal) => {
   const now = new Date();
   persistReading(journal, parseClaudeRateLimitEvent({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: { seven_day: { utilization: 0.75 } } },
   }, now));
   const r = journal.getSubstrateReading("claude")!;
   expect(r.sevenDayResetsAt).toBeNull();
   expect(effectiveThreshold("seven_day", r, now, DEFAULT_CONFIG)).toBe(80);
  });
 });

 test("persists each window's own reset instead of reusing the earliest", async () => {
  await withJournal((journal) => {
   const now = new Date("2026-10-04T12:00:00.000Z");
   const fiveHourReset = Math.floor(now.getTime() / 1000) + 3600;
   const sevenDayReset = Math.floor(now.getTime() / 1000) + 5 * 3600;
   persistReading(journal, parseClaudeRateLimitEvent({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: {
     five_hour: { utilization: 0.2, resetsAt: fiveHourReset },
     seven_day: { utilization: 0.85, resetsAt: sevenDayReset },
    } },
   }, now));
   const r = journal.getSubstrateReading("claude")!;
   expect(r.fiveHourResetsAt).toBe(new Date(fiveHourReset * 1000).toISOString());
   expect(r.sevenDayResetsAt).toBe(new Date(sevenDayReset * 1000).toISOString());
   expect(effectiveThreshold("five_hour", r, now, DEFAULT_CONFIG)).toBe(94);
   expect(effectiveThreshold("seven_day", r, now, DEFAULT_CONFIG)).toBeCloseTo(99.405, 2);
  });
 });
});

// ---- Claude result text extraction ----

describe("extractClaudeResultText", () => {
 test("extracts the result event text from stream-json", () => {
  const stdout = [
   '{"type":"init","session_id":"abc"}',
   '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
   '{"type":"assistant","message":"thinking..."}',
   '{"type":"result","result":"The implementation is complete.","subtype":"success"}',
  ].join("\n");
  expect(extractClaudeResultText(stdout.split("\n"), stdout)).toBe("The implementation is complete.");
 });

 test("falls back to raw stdout when no result event", () => {
  const stdout = "some raw output\n";
  expect(extractClaudeResultText(stdout.split("\n"), stdout)).toBe(stdout);
 });
});

// ---- selection policy ----

describe("effectiveThreshold", () => {
 const now = new Date("2026-10-04T12:00:00.000Z");
 const resetIn = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
 const cases = [
  { name: "7d, six days left", window: "seven_day", hours: 144, threshold: 82.857 },
  { name: "7d, one day left", window: "seven_day", hours: 24, threshold: 97.143 },
  { name: "7d, five hours left", window: "seven_day", hours: 5, threshold: 99.405 },
  { name: "7d, at reset", window: "seven_day", hours: 0, threshold: 100 },
  { name: "5h, half its window left", window: "five_hour", hours: 2.5, threshold: 85 },
  { name: "5h, full window left", window: "five_hour", hours: 5, threshold: 70 },
  { name: "7d, reset in the past", window: "seven_day", hours: -1, threshold: 100 },
 ] as const;
 for (const c of cases) {
  test(c.name, () => {
   const field = c.window === "five_hour" ? "fiveHourResetsAt" : "sevenDayResetsAt";
   const r = reading("claude", { [field]: resetIn(c.hours) });
   expect(effectiveThreshold(c.window, r, now, DEFAULT_CONFIG)).toBeCloseTo(c.threshold, 2);
  });
 }

 test("missing reset keeps its fixed threshold", () => {
  const r = reading("claude");
  expect(effectiveThreshold("five_hour", r, now, DEFAULT_CONFIG)).toBe(70);
  expect(effectiveThreshold("seven_day", r, now, DEFAULT_CONFIG)).toBe(80);
 });

 test("Codex with only its 7d duration uses that window", async () => {
  await withJournal((journal) => {
   persistReading(journal, parseCodexQuota({ rateLimits: {
    primary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: Math.floor((now.getTime() + 5 * 3_600_000) / 1000) },
    secondary: null,
    rateLimitReachedType: null,
   } }, now));
   const r = journal.getSubstrateReading("codex")!;
   expect(r.fiveHourUsedPct).toBeNull();
   expect(r.sevenDayResetsAt).toBe(resetIn(5));
   expect(effectiveThreshold("seven_day", r, now, DEFAULT_CONFIG)).toBeCloseTo(99.405, 2);
   expect(selectForBuild({ readings: [r], now, config: DEFAULT_CONFIG })).toBe("codex");
  });
 });
});

describe("isEligible", () => {
 const now = new Date();
 const fresh = now.toISOString();
 const stale = new Date(now.getTime() - 30 * 60_000).toISOString();

 test("eligible when fresh, under threshold, not capped", () => {
  const r = reading("claude", { readAt: fresh, fiveHourUsedPct: 40, sevenDayUsedPct: 50 });
  const e = isEligible(r, DEFAULT_CONFIG, now);
  expect(e).not.toBeNull();
  expect(e!.name).toBe("claude");
  expect(e!.headroom).toBe(30); // min(70-40, 80-50)
 });

 test("ineligible when stale", () => {
  const r = reading("claude", { readAt: stale, fiveHourUsedPct: 10 });
  expect(isEligible(r, DEFAULT_CONFIG, now)).toBeNull();
 });

 test("ineligible when capped", () => {
  const r = reading("claude", {
   readAt: fresh,
   capped: true,
   cappedUntil: new Date(now.getTime() + 60_000).toISOString(),
  });
  expect(isEligible(r, DEFAULT_CONFIG, now)).toBeNull();
 });

 test("ineligible while capped-until is in the future, even on an uncapped reading", () => {
  const r = reading("codex", {
   readAt: fresh,
   capped: false,
   cappedUntil: new Date(now.getTime() + 60_000).toISOString(),
  });
  expect(isEligible(r, DEFAULT_CONFIG, now)).toBeNull();
  const past = reading("codex", { readAt: fresh, cappedUntil: new Date(now.getTime() - 60_000).toISOString() });
  expect(isEligible(past, DEFAULT_CONFIG, now)).not.toBeNull();
 });

 test("ineligible when 5h window over threshold", () => {
  const r = reading("codex", { readAt: fresh, fiveHourUsedPct: 75, sevenDayUsedPct: 30 });
  expect(isEligible(r, DEFAULT_CONFIG, now)).toBeNull();
 });

 test("ineligible when 7d window over threshold", () => {
  const r = reading("claude", { readAt: fresh, fiveHourUsedPct: 30, sevenDayUsedPct: 85 });
  expect(isEligible(r, DEFAULT_CONFIG, now)).toBeNull();
 });

 test("null reading is ineligible", () => {
  expect(isEligible(null, DEFAULT_CONFIG, now)).toBeNull();
 });

 test("pi is never eligible as a strong substrate", () => {
  const r = reading("pi", { readAt: fresh });
  expect(isEligible(r, DEFAULT_CONFIG, now)).toBeNull();
 });

 test("eligible with only one window reported", () => {
  const r = reading("codex", { readAt: fresh, fiveHourUsedPct: null, sevenDayUsedPct: 50 });
  const e = isEligible(r, DEFAULT_CONFIG, now);
  expect(e).not.toBeNull();
  expect(e!.headroom).toBe(30); // 80-50
 });

 test("ineligible with no windows reported (fail closed)", () => {
  for (const name of ["claude", "codex"] as const) {
   const r = reading(name, { readAt: fresh, fiveHourUsedPct: null, sevenDayUsedPct: null });
   expect(isEligible(r, DEFAULT_CONFIG, now)).toBeNull();
  }
 });
});

describe("selectForBuild", () => {
 const now = new Date();
 const fresh = now.toISOString();

 test("picks the substrate with the most headroom", () => {
  const readings = [
   reading("claude", { readAt: fresh, fiveHourUsedPct: 60, sevenDayUsedPct: 30 }),
   reading("codex", { readAt: fresh, fiveHourUsedPct: 20, sevenDayUsedPct: 30 }),
  ];
  expect(selectForBuild({ readings, now, config: DEFAULT_CONFIG })).toBe("codex");
 });

 test("falls back to Pi when neither is eligible", () => {
  const readings = [
   reading("claude", { readAt: fresh, fiveHourUsedPct: 80, sevenDayUsedPct: 30 }),
   reading("codex", { readAt: fresh, fiveHourUsedPct: 80, sevenDayUsedPct: 30 }),
  ];
  expect(selectForBuild({ readings, now, config: DEFAULT_CONFIG })).toBe("pi");
 });

 test("falls back to Pi when no readings exist", () => {
  expect(selectForBuild({ readings: [], now, config: DEFAULT_CONFIG })).toBe("pi");
 });

 test("85% on 7d flips from Pi to Claude as reset approaches", () => {
  const early = reading("claude", { readAt: fresh, fiveHourUsedPct: 20, sevenDayUsedPct: 85,
   sevenDayResetsAt: new Date(now.getTime() + 6 * 24 * 3_600_000).toISOString() });
  const near = { ...early, sevenDayResetsAt: new Date(now.getTime() + 5 * 3_600_000).toISOString() };
  expect(selectForBuild({ readings: [early], now, config: DEFAULT_CONFIG })).toBe("pi");
  expect(selectForBuild({ readings: [near], now, config: DEFAULT_CONFIG })).toBe("claude");
  expect(isEligible(near, DEFAULT_CONFIG, now)?.headroom).toBeCloseTo(14.405, 2);
 });

 test("stale readings are treated as capped", () => {
  const stale = new Date(now.getTime() - 30 * 60_000).toISOString();
  const readings = [
   reading("claude", { readAt: stale, fiveHourUsedPct: 10 }),
   reading("codex", { readAt: stale, fiveHourUsedPct: 10 }),
  ];
  expect(selectForBuild({ readings, now, config: DEFAULT_CONFIG })).toBe("pi");
 });
});

describe("selectForReview — cross-model selection", () => {
 const now = new Date();
 const fresh = now.toISOString();
 const bothEligible = [
  reading("claude", { readAt: fresh, fiveHourUsedPct: 20, sevenDayUsedPct: 30 }),
  reading("codex", { readAt: fresh, fiveHourUsedPct: 20, sevenDayUsedPct: 30 }),
 ];

 test("Claude-written → Codex for review", () => {
  expect(
   selectForReview({ readings: bothEligible, now, config: DEFAULT_CONFIG }, "claude"),
  ).toBe("codex");
 });

 test("Codex-written → Claude for review", () => {
  expect(
   selectForReview({ readings: bothEligible, now, config: DEFAULT_CONFIG }, "codex"),
  ).toBe("claude");
 });

 test("Pi-written → the eligible strong substrate with most headroom", () => {
  expect(
   selectForReview({ readings: bothEligible, now, config: DEFAULT_CONFIG }, "pi"),
  ).not.toBe("pi");
 });

 test("no other substrate eligible → author's substrate if eligible", () => {
  const onlyClaude = [
   reading("claude", { readAt: fresh, fiveHourUsedPct: 20, sevenDayUsedPct: 30 }),
   reading("codex", { readAt: fresh, fiveHourUsedPct: 80 }), // over threshold
  ];
  expect(
   selectForReview({ readings: onlyClaude, now, config: DEFAULT_CONFIG }, "claude"),
  ).toBe("claude");
 });

 test("nothing eligible → Pi", () => {
  const noneEligible = [
   reading("claude", { readAt: fresh, fiveHourUsedPct: 80 }),
   reading("codex", { readAt: fresh, fiveHourUsedPct: 80 }),
  ];
  expect(
   selectForReview({ readings: noneEligible, now, config: DEFAULT_CONFIG }, "claude"),
  ).toBe("pi");
 });

 test("a near-reset Claude reading becomes eligible for review", () => {
  const early = reading("claude", { readAt: fresh, fiveHourUsedPct: null, sevenDayUsedPct: 85,
   sevenDayResetsAt: new Date(now.getTime() + 6 * 24 * 3_600_000).toISOString() });
  const near = { ...early, sevenDayResetsAt: new Date(now.getTime() + 5 * 3_600_000).toISOString() };
  expect(selectForReview({ readings: [early], now, config: DEFAULT_CONFIG }, "codex")).toBe("pi");
  expect(selectForReview({ readings: [near], now, config: DEFAULT_CONFIG }, "codex")).toBe("claude");
 });
});

// ---- review marker with substrate ----

describe("review marker with substrate (node #45)", () => {
 const verdict = {
  verdict: "approved",
  summary: "",
  commitId: SHA,
  blockers: 0,
  majors: 1,
  nits: 2,
  body: "review text",
 };

 test("marker includes substrate when provided", () => {
  const marker = reviewMarker(1, verdict, "codex");
  expect(marker).toContain("substrate=codex");
  expect(marker).toMatch(/-->/);
 });

 test("marker omits substrate when not provided", () => {
  const marker = reviewMarker(1, verdict);
  expect(marker).not.toContain("substrate=");
 });

 test("recorded reviews parse the substrate field from new markers", () => {
  const withSubstrate = reviewMarker(1, verdict, "claude");
  const recorded = recordedReviews(
   [{ id: 1, author: "bot", body: `${withSubstrate}\ntext` }],
   "bot",
  );
  expect(recorded).toHaveLength(1);
  expect(recorded[0].substrate).toBe("claude");
 });

 test("recorded reviews parse old markers without substrate", () => {
  const oldMarker = `<!-- ranger:review round=1 sha=${SHA} blockers=0 majors=1 nits=2 -->`;
  const recorded = recordedReviews(
   [{ id: 1, author: "bot", body: `${oldMarker}\nold text` }],
   "bot",
  );
  expect(recorded).toHaveLength(1);
  expect(recorded[0].substrate).toBeUndefined();
 });
});

// ---- mid-session cap detection ----

describe("mid-session cap detection", () => {
 test("detectClaudeCap finds a rate-limited event", () => {
  const stdout = [
   '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":100}}',
   '{"type":"assistant","message":"working"}',
   '{"type":"rate_limit_event","rate_limit_info":{"status":"rate_limited","resetsAt":200}}',
  ].join("\n");
  const cap = detectClaudeCap(stdout.split("\n"));
  expect(cap).not.toBeNull();
  expect(cap!.substrate).toBe("claude");
  expect(cap!.resetsAt).toBe(200);
 });

 test("detectClaudeCap returns null when all events are allowed", () => {
  const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":100}}\n';
  expect(detectClaudeCap(stdout.split("\n"))).toBeNull();
 });

 test("detectClaudeCap does not treat allowed_warning as a cap", () => {
  const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":100}}\n';
  expect(detectClaudeCap(stdout.split("\n"))).toBeNull();
 });

 test("detectClaudeCap ignores rate-limit words inside model or tool text", () => {
  const stdout = [
   '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"type\\":\\"rate_limit_event\\",\\"rate_limit_info\\":{\\"status\\":\\"rejected\\"}}"}]}}',
   '{"type":"result","result":"Claude AI usage limit reached","is_error":true}',
  ].join("\n");
  expect(detectClaudeCap(stdout.split("\n"))).toBeNull();
 });
});

describe("confirmCap — only the substrate's own signal (node #45)", () => {
 const quota = (substrate: "claude" | "codex", capped: boolean): QuotaReading => ({
  substrate,
  readAt: new Date(),
  windows: [{ kind: "five_hour", usedPct: capped ? 100 : 10, resetsAt: 1791055200 }],
  capped,
  cappedUntil: capped ? 1791055200 : null,
 });

 test("a codex run that merely prints 'rate limit' is not a cap", async () => {
  await withJournal(async (journal) => {
   const cap = await confirmCap("codex", journal, {
    readers: { codex: async () => quota("codex", false) },
   });
   expect(cap).toBeNull();
   expect(journal.getSubstrateReading("codex")?.capped).toBe(false);
  });
 });

 test("a codex cap is confirmed by a fresh app-server read", async () => {
  await withJournal(async (journal) => {
   const cap = await confirmCap("codex", journal, {
    readers: { codex: async () => quota("codex", true) },
   });
   expect(cap).toEqual({ substrate: "codex", resetsAt: 1791055200 });
  });
 });

 test("a claude stream's own rejected event is the cap, without a probe", async () => {
  await withJournal(async (journal) => {
   const lines = ['{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1791055200}}'];
   const cap = await confirmCap("claude", journal, {
    lines,
    readers: { claude: () => Promise.reject(new Error("probe must not run")) },
   });
   expect(cap).toEqual({ substrate: "claude", resetsAt: 1791055200 });
  });
 });

 test("a failed claude run that only warned is an ordinary failure", async () => {
  await withJournal(async (journal) => {
   const lines = ['{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1791055200}}'];
   const cap = await confirmCap("claude", journal, {
    lines,
    readers: { claude: async () => quota("claude", false) },
   });
   expect(cap).toBeNull();
  });
 });

 test("an unreadable substrate is an ordinary failure, and pi never caps", async () => {
  await withJournal(async (journal) => {
   const fails = { claude: () => Promise.reject(new Error("down")) };
   expect(await confirmCap("claude", journal, { lines: [], readers: fails })).toBeNull();
   expect(await confirmCap("pi", journal, {})).toBeNull();
  });
 });
});

describe("drainJsonLines — codex app-server framing", () => {
 // Captured from `codex app-server` (codex-cli 0.159.0) on 2026-10-04.
 const live = [
  '{"id":1,"result":{"userAgent":"ranger/0.159.0","platformOs":"macos"}}',
  '{"method":"remoteControl/status/changed","params":{"status":"disabled"},"emittedAtMs":1791095837650}',
  '{"method":"account/updated","params":{"authMode":"chatgpt","planType":"prolite"},"emittedAtMs":1791095838760}',
  '{"id":3,"result":{"ordinaryUsageAllowed":true,"rateLimits":{"limitId":"codex","primary":{"usedPercent":2,"windowDurationMins":10080,"resetsAt":1791647617},"secondary":null,"rateLimitReachedType":null}}}',
  "",
 ].join("\n");

 test("parses notifications and the id=3 reply, across a mid-line chunk split", () => {
  const cut = live.indexOf("usedPercent");
  const first = drainJsonLines(live.slice(0, cut));
  expect(first.messages).toHaveLength(3);
  const second = drainJsonLines(first.rest + live.slice(cut));
  expect(second.rest).toBe("");
  const reply = second.messages[0] as { id: number; result: Parameters<typeof parseCodexQuota>[0] };
  expect(reply.id).toBe(3);
  const q = parseCodexQuota(reply.result);
  expect(q.windows).toEqual([{ kind: "seven_day", usedPct: 2, resetsAt: 1791647617 }]);
  expect(q.capped).toBe(false);
 });

 test("skips non-JSON log lines", () => {
  expect(drainJsonLines("WARN starting\n{\"id\":1}\n").messages).toEqual([{ id: 1 }]);
 });
});

// ---- per-substrate command builder ----

describe("workerCommandFor", () => {
 const config = loadConfig(
  join(import.meta.dir, "..", "ranger.example.yaml"),
 ).config;

 test("claude: stream-json verbose", () => {
  const cmd = workerCommandFor("claude", config);
  expect(cmd).toEqual(["claude", "-p", "--output-format", "stream-json", "--verbose"]);
 });

 test("codex: a writable workspace sandbox, plus the common git dir a worktree commits into", () => {
  expect(workerCommandFor("codex", config)).toEqual([
   "codex",
   "exec",
   "--sandbox",
   "workspace-write",
   "--model",
   "gpt-6.1-sol",
   "-c",
   'model_reasoning_effort="high"',
  ]);
  expect(workerCommandFor("codex", config, { writableGitDir: "/c/acme/widgets/.git" })).toEqual([
   "codex",
   "exec",
   "--sandbox",
   "workspace-write",
   "--add-dir",
   "/c/acme/widgets/.git",
   "--model",
   "gpt-6.1-sol",
   "-c",
   'model_reasoning_effort="high"',
  ]);
  // Never the read-only default, never the unsandboxed escape hatch.
  expect(workerCommandFor("codex", config)).not.toContain("--dangerously-bypass-approvals-and-sandbox");
 });

 test("codex: the model pin defaults apply to a config without a codex block (node #60)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-codex-"));
  try {
   const path = join(dir, "ranger.yaml");
   writeFileSync(path, baseConfigLines(dir).join("\n"));
   const bare = loadConfig(path).config;
   expect(bare.substrates.codex).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "high" });
   const cmd = workerCommandFor("codex", bare, { writableGitDir: "/c/.git" });
   expect(cmd.slice(cmd.indexOf("--model"), cmd.indexOf("--model") + 2)).toEqual(["--model", "gpt-6.1-sol"]);
   expect(cmd).toContain('model_reasoning_effort="high"');
   expect(cmd).toContain("workspace-write");
   expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
   expect(workerModelFor("codex", bare)).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "high" });
   expect(describeWorkerModel(workerModelFor("codex", bare)!)).toBe("gpt-6.1-sol, high");
   expect(workerModelFor("claude", bare)).toBeNull();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });

 test("codex: the configured model and effort reach the argv (node #60)", () => {
  const pinned = {
   ...config,
   substrates: { ...config.substrates, codex: { model: "gpt-5.5-codex", reasoningEffort: "low" as const } },
  };
  const cmd = workerCommandFor("codex", pinned, { writableGitDir: "/c/.git" });
  expect(cmd).toEqual([
   "codex",
   "exec",
   "--sandbox",
   "workspace-write",
   "--add-dir",
   "/c/.git",
   "--model",
   "gpt-5.5-codex",
   "-c",
   'model_reasoning_effort="low"',
  ]);
  expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
 });

 test("pi: provider and model from config", () => {
  const cmd = workerCommandFor("pi", config);
  expect(cmd).toContain("--provider");
  expect(cmd).toContain("spark");
  expect(cmd).toContain("--model");
  expect(cmd).toContain("longctx-think");
 });
});

// ---- substrate reading persistence (journal integration) ----

async function withJournal(fn: (journal: Journal) => Promise<void> | void): Promise<void> {
 const dir = mkdtempSync(join(tmpdir(), "ranger-sub-"));
 const path = join(dir, "ranger.yaml");
 writeFileSync(path, baseConfigLines(dir).join("\n"));
 const journal = openJournal(loadConfig(path).config);
 try {
  await fn(journal);
 } finally {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
 }
}

describe("window-less readings never bypass the reserve", () => {
 test("codex null/null and claude without unifiedWindows route to Pi", async () => {
  await withJournal((journal) => {
   const now = new Date();
   persistReading(
    journal,
    parseCodexQuota(
     { rateLimits: { primary: null, secondary: null, rateLimitReachedType: null } },
     now,
    ),
   );
   persistReading(
    journal,
    parseClaudeRateLimitEvent(
     { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 100 } },
     now,
    ),
   );
   const readings = journal.listSubstrateReadings();
   expect(readings).toHaveLength(2);
   expect(selectForBuild({ readings, now, config: DEFAULT_CONFIG })).toBe("pi");
   expect(selectForReview({ readings, now, config: DEFAULT_CONFIG }, "claude")).toBe("pi");
  });
 });
});

describe("markSubstrateCapped", () => {
 test("marks a substrate as capped until its reported reset", async () => {
  await withJournal((journal) => {
   const now = new Date(1791000000 * 1000);
   markSubstrateCapped(journal, "claude", 1791055200, now);
   const r = journal.getSubstrateReading("claude");
   expect(r?.capped).toBe(true);
   expect(r?.cappedUntil).toBe(new Date(1791055200 * 1000).toISOString());
  });
 });

 test("a reset already past (or unknown) caps for 30 minutes, so a resume cannot re-pick it", async () => {
  await withJournal((journal) => {
   const now = new Date(1791000000 * 1000);
   markSubstrateCapped(journal, "codex", 1790000000, now);
   expect(journal.getSubstrateReading("codex")?.cappedUntil).toBe(
    new Date(now.getTime() + 30 * 60_000).toISOString(),
   );
  });
 });

 test("a fresh uncapped reading keeps a capped-until still in the future", async () => {
  await withJournal((journal) => {
   const now = new Date();
   const until = Math.floor(now.getTime() / 1000) + 3600;
   markSubstrateCapped(journal, "codex", until, now);
   persistReading(journal, {
    substrate: "codex",
    readAt: now,
    windows: [{ kind: "seven_day", usedPct: 10, resetsAt: until + 100 }],
    capped: false,
    cappedUntil: null,
   });
   const r = journal.getSubstrateReading("codex");
   expect(r?.capped).toBe(false);
   expect(r?.cappedUntil).toBe(new Date(until * 1000).toISOString());
   expect(isEligible(r, DEFAULT_CONFIG, now)).toBeNull();
  });
 });
});

describe("head author substrate (node #45)", () => {
 test("records which substrate wrote a pushed SHA; unknown SHAs read null", async () => {
  await withJournal((journal) => {
   journal.recordHeadSubstrate({ sha: SHA, repo: "acme/widgets", nodeId: "9", substrate: "codex" });
   expect(journal.headSubstrate("acme/widgets", SHA)).toBe("codex");
   expect(journal.headSubstrate("acme/widgets", "b".repeat(40))).toBeNull();
  });
 });

 test("the same SHA in two repos keeps two authors", async () => {
  await withJournal((journal) => {
   journal.recordHeadSubstrate({ sha: SHA, repo: "acme/widgets", nodeId: "9", substrate: "codex" });
   journal.recordHeadSubstrate({ sha: SHA, repo: "acme/fork", nodeId: "3", substrate: "claude" });
   expect(journal.headSubstrate("acme/widgets", SHA)).toBe("codex");
   expect(journal.headSubstrate("acme/fork", SHA)).toBe("claude");
  });
 });

 test("head records past the retention window are pruned", async () => {
  await withJournal((journal) => {
   journal.recordHeadSubstrate({ sha: SHA, repo: "acme/widgets", nodeId: "9", substrate: "codex" });
   journal.pruneHeadSubstrates(new Date(Date.now() + 31 * 86_400_000));
   expect(journal.headSubstrate("acme/widgets", SHA)).toBeNull();
  });
 });
});

describe("describeReadings", () => {
 test("names each strong substrate's windows, age and cap", () => {
  const now = new Date();
  const text = describeReadings(
   [reading("claude", { readAt: new Date(now.getTime() - 3 * 60_000).toISOString(), capped: true })],
   now,
   DEFAULT_CONFIG,
  );
  expect(text).toBe("claude 5h 20% < 70.0% (reset unknown) 7d 30% < 80.0% (reset unknown) read 3m ago CAPPED; codex unread");
 });

 test("names the threshold and time to reset used for selection", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");
  const r = reading("claude", { readAt: now.toISOString(), fiveHourUsedPct: null, sevenDayUsedPct: 85,
   sevenDayResetsAt: new Date(now.getTime() + 5 * 3_600_000).toISOString() });
  expect(describeReadings([r], now, DEFAULT_CONFIG)).toContain("claude 7d 85% < 99.4% (5h to reset)");
 });
});

describe("isClaudeSignalLine — what a Claude worker run keeps", () => {
 test("keeps rate_limit_events and the result event, drops the rest", () => {
  const lines = [
   '{"type":"system","subtype":"init"}',
   '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
   '{"type":"assistant","message":{"content":[{"type":"text","text":"say \\"type\\":\\"result\\""}]}}',
   '{"type":"user","message":{"content":[{"type":"tool_result","content":"big output"}]}}',
   '{"type":"result","subtype":"success","result":"done"}',
  ];
  expect(lines.filter(isClaudeSignalLine)).toEqual([lines[1], lines[4]]);
 });

 test("runCmd keeps only the accepted lines as they stream, partial last line included", async () => {
  const r = await runCmd(
   "bash",
   ["-c", `printf 'noise\\n{"type":"result","result":"ok"}\\nmore noise\\n{"type":"rate_limit_event"}'`],
   { keepStdoutLine: isClaudeSignalLine },
  );
  expect(r.stdout).toBe('{"type":"result","result":"ok"}\n{"type":"rate_limit_event"}\n');
 });
});

describe("runCmd stdout tail beside a filtered stream", () => {
 test("keeps the last unfiltered lines, each cut to a bounded length", async () => {
  const r = await runCmd(
   "bash",
   ["-c", `for i in $(seq 1 60); do echo "line $i"; done; head -c 5000 /dev/zero | tr '\\0' x; echo`],
   { keepStdoutLine: isClaudeSignalLine },
  );
  expect(r.stdout).toBe("");
  const tail = (r.stdoutTail ?? "").split("\n");
  expect(tail).toHaveLength(50);
  expect(tail[0]).toBe("line 12");
  expect(tail[49]).toBe(`${"x".repeat(2000)}…`);
 });

 test("a line streamed over many chunks is joined whole", async () => {
  const big = "y".repeat(300_000);
  const r = await runCmd(
   "bash",
   ["-c", `printf '{"type":"result","result":"%s"}\n' "$(head -c 300000 /dev/zero | tr '\\0' y)"`],
   { keepStdoutLine: isClaudeSignalLine },
  );
  expect(r.stdout).toBe(`{"type":"result","result":"${big}"}\n`);
 });
});

describe("workerOutputFor — reading a run on its substrate's format", () => {
 test("claude: the result event is the summary and the rate_limit_event is cached", async () => {
  await withJournal((journal) => {
   const stdout = [
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.28,"resetsAt":1791055200}}}}',
    '{"type":"result","subtype":"success","result":"All done."}',
    "",
   ].join("\n");
   const { result, lines } = workerOutputFor("claude").read({ code: 0, stdout, stderr: "" }, journal);
   expect(result.stdout).toBe("All done.");
   expect(lines).toHaveLength(3);
   expect(journal.getSubstrateReading("claude")?.fiveHourUsedPct).toBe(28);
  });
 });

 test("claude: a crash before the result event logs the unfiltered tail", async () => {
  await withJournal((journal) => {
   const { result } = workerOutputFor("claude").read(
    { code: 1, stdout: "", stderr: "boom", stdoutTail: "panic: out of memory" },
    journal,
   );
   expect(result.stdout).toBe("panic: out of memory");
  });
 });

 test("pi, codex and an unlabelled run read as plain text", async () => {
  await withJournal((journal) => {
   for (const substrate of ["pi", "codex", undefined] as const) {
    const out = workerOutputFor(substrate);
    expect(out.runOptions).toEqual({});
    const raw = { code: 0, stdout: '{"type":"result","result":"x"}', stderr: "" };
    expect(out.read(raw, journal)).toEqual({ result: raw });
   }
  });
 });
});

describe("sageReview passes the chosen substrate (sage src/cli/index.ts --substrate)", () => {
 test("argv carries --substrate <name>", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-sage-"));
  const out = join(dir, "argv");
  const fake = join(dir, "sage");
  writeFileSync(
   fake,
   `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$SAGE_ARGV_OUT"\nexec ${join(import.meta.dir, "fixtures", "bin", "fake-sage")} "$@"\n`,
   { mode: 0o755 },
  );
  process.env.SAGE_ARGV_OUT = out;
  try {
   const verdict = await sageReview("acme/widgets", 7, "ghp_readonly", { command: fake, substrate: "codex" });
   expect(verdict.verdict).toBe("approved");
   expect(readFileSync(out, "utf8").trim().split("\n")).toEqual([
    "review",
    "acme/widgets#7",
    "--emit-verdict-block",
    "--substrate",
    "codex",
   ]);
   // The fake holds sage's argv contract: a substrate sage does not know is
   // an ordinary review failure.
   await expect(
    sageReview("acme/widgets", 7, "ghp_readonly", { command: fake, substrate: "gemini" as never }),
   ).rejects.toThrow("unknown substrate 'gemini'");
  } finally {
   delete process.env.SAGE_ARGV_OUT;
   rmSync(dir, { recursive: true, force: true });
  }
 });
});
