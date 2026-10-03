import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openJournal, type SubstrateReading } from "../src/journal.ts";
import {
 detectClaudeCap,
 detectCodexCap,
 extractClaudeResultText,
 isEligible,
 markSubstrateCapped,
 parseClaudeRateLimitEvent,
 parseCodexQuota,
 selectForBuild,
 selectForReview,
 workerCommandFor,
 type ClaudeRateLimitEvent,
 type CodexRateLimitsResponse,
 type SubstrateConfig,
} from "../src/substrate.ts";
import { recordedReviews, reviewMarker } from "../src/implement.ts";
import { baseConfigLines } from "./support.ts";

const SHA = "a".repeat(40);

const DEFAULT_CONFIG: SubstrateConfig = {
 fiveHourMaxUsedPct: 70,
 sevenDayMaxUsedPct: 80,
 claudeProbeMaxAgeMin: 15,
 codexReadMaxAgeMin: 5,
};

function reading(
 substrate: string,
 over: Partial<SubstrateReading> = {},
): SubstrateReading {
 return {
  substrate,
  readAt: new Date().toISOString(),
  fiveHourUsedPct: 20,
  sevenDayUsedPct: 30,
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

 test("marks capped when status !== allowed", () => {
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
  expect(extractClaudeResultText(stdout)).toBe("The implementation is complete.");
 });

 test("falls back to raw stdout when no result event", () => {
  const stdout = "some raw output\n";
  expect(extractClaudeResultText(stdout)).toBe(stdout);
 });
});

// ---- selection policy ----

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

 test("eligible with no windows = minimum headroom", () => {
  const r = reading("claude", { readAt: fresh, fiveHourUsedPct: null, sevenDayUsedPct: null });
  const e = isEligible(r, DEFAULT_CONFIG, now);
  expect(e).not.toBeNull();
  expect(e!.headroom).toBe(1);
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
});

// ---- review marker with substrate ----

describe("review marker with substrate (node #44)", () => {
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
  const cap = detectClaudeCap({ code: 1, stdout, stderr: "" });
  expect(cap).not.toBeNull();
  expect(cap!.substrate).toBe("claude");
  expect(cap!.resetsAt).toBe(200);
 });

 test("detectClaudeCap returns null when all events are allowed", () => {
  const stdout = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":100}}\n';
  expect(detectClaudeCap({ code: 0, stdout, stderr: "" })).toBeNull();
 });

 test("detectCodexCap finds rate limit text", () => {
  const result = { code: 1, stdout: "", stderr: "Error: rate limit reached" };
  expect(detectCodexCap(result)).not.toBeNull();
 });

 test("detectCodexCap returns null for other errors", () => {
  const result = { code: 1, stdout: "", stderr: "Error: something else" };
  expect(detectCodexCap(result)).toBeNull();
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

 test("codex: exec", () => {
  expect(workerCommandFor("codex", config)).toEqual(["codex", "exec"]);
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

describe("markSubstrateCapped", () => {
 test("marks a substrate as capped in the journal", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-sub-"));
  try {
   const path = join(dir, "ranger.yaml");
   writeFileSync(path, baseConfigLines(dir).join("\n"));
   const journal = openJournal(loadConfig(path).config);
   const now = new Date();
   markSubstrateCapped(journal, "claude", 1791055200, now);
   const r = journal.getSubstrateReading("claude");
   expect(r).not.toBeNull();
   expect(r!.capped).toBe(true);
   expect(r!.cappedUntil).not.toBeNull();
   journal.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

// ---- mid-session cap path does not touch attempts or deadman ----

describe("mid-session cap path does not touch attempts or deadman (node #44)", () => {
 test("a substrate cap detected in the worker result does not increment the deadman count", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-cap-"));
  try {
   const path = join(dir, "ranger.yaml");
   writeFileSync(path, baseConfigLines(dir).join("\n"));
   const journal = openJournal(loadConfig(path).config);
   const now = new Date();

   // Seed a worker row.
   journal.upsertWorker({
    nodeId: "99",
    repo: "acme/widgets",
    status: "running",
    attempts: 0,
    substrate: "claude",
   });
   const deadmanBefore = journal.deadmanCount();

   // Simulate what runImplementNode does when outcome.substrateCapped is set:
   // mark capped, record event, do NOT call countFailure.
   markSubstrateCapped(journal, "claude", 1791055200, now);
   journal.recordEvent("substrate-capped", {
    nodeId: "99",
    repo: "acme/widgets",
    detail: "claude capped; node will resume on next eligible substrate",
   });
   journal.updateWorker("99", { pid: null, workerPgid: null });

   // The deadman count must NOT have incremented.
   expect(journal.deadmanCount()).toBe(deadmanBefore);

   // The worker row is NOT in a terminal state (not failed, not parked).
   const row = journal.getWorker("99");
   expect(row).not.toBeNull();
   expect(row!.status).toBe("running");

   // The substrate is marked capped.
   const r = journal.getSubstrateReading("claude");
   expect(r).not.toBeNull();
   expect(r!.capped).toBe(true);

   journal.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});
