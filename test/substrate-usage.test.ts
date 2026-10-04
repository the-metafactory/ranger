import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FencedError, Journal, type SubstrateReading, type SubstrateSessionRow, type WorkerRow } from "../src/journal.ts";
import { assembleState } from "../src/serve.ts";
import { SUBSTRATE_NAMES } from "../src/store/schema.ts";
import { isEligible, selectForBuild, type SubstrateConfig } from "../src/substrate-policy.ts";
import {
 failedSessionOutcome,
 liveSession,
 recordSession,
 substrateUsageViews,
 type UsageInputs,
} from "../src/substrate-usage.ts";

/**
 * Node #56 — every substrate's limits and sessions on `ranger serve`: the
 * session table, its recording, and the panel rows built from it.
 */

const CONFIG: SubstrateConfig = {
 fiveHourMaxUsedPct: 70,
 sevenDayMaxUsedPct: 80,
 claudeProbeMaxAgeMin: 15,
 codexReadMaxAgeMin: 5,
};

const NOW = new Date("2026-10-04T10:00:00Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function reading(substrate: SubstrateReading["substrate"], over: Partial<SubstrateReading> = {}): SubstrateReading {
 return {
  substrate,
  readAt: ago(MIN),
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

/** Give a node an occupant at `generation`, as a claim + run-node start would. */
function occupy(j: Journal, nodeId: string, generation = 1, repo = "acme/widgets"): void {
 j.upsertWorker({ root: 1, nodeId, repo, status: "claimed" });
 while ((j.getWorker(nodeId, repo)?.generation ?? 0) < generation) j.beginGeneration(nodeId, repo);
}

let nextId = 1;
function session(over: Partial<SubstrateSessionRow>): SubstrateSessionRow {
 return {
  id: nextId++,
  substrate: "claude",
  kind: "worker",
  repo: "acme/widgets",
  nodeId: "20",
  generation: 1,
  startedAt: ago(MIN),
  endedAt: ago(0),
  outcome: "ok",
  ...over,
 };
}

function views(over: Partial<UsageInputs> = {}) {
 return substrateUsageViews({
  readings: [],
  sessions: [],
  lastSession: () => null,
  live: () => true,
  config: CONFIG,
  now: NOW,
  ...over,
 });
}

const view = (name: string, over: Partial<UsageInputs> = {}) => views(over).find((v) => v.substrate === name)!;

describe("the substrate_sessions migration", () => {
 test("a fresh journal has the table and its indexes; a row round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-usage-"));
  try {
   const path = join(dir, "state.sqlite");
   const j = new Journal(path);
   occupy(j, "7", 3);
   const id = j.startSubstrateSession({ substrate: "codex", kind: "review", repo: "acme/widgets", nodeId: "7", generation: 3 }, NOW);
   j.endSubstrateSession(id, "capped", new Date(NOW.getTime() + 5 * MIN));
   j.close();

   const sqlite = new Database(path, { readonly: true });
   const names = sqlite
    .query("SELECT name FROM sqlite_master WHERE tbl_name = 'substrate_sessions' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);
   expect(names).toEqual([
    "substrate_sessions",
    "substrate_sessions_ended_at_idx",
    "substrate_sessions_node_open_idx",
    "substrate_sessions_started_at_idx",
    "substrate_sessions_substrate_started_idx",
   ]);
   sqlite.close();

   const reader = Journal.openReadOnly(path)!;
   expect(reader.listSubstrateSessions(new Date(NOW.getTime() - 60 * MIN))).toEqual([
    {
     id,
     substrate: "codex",
     kind: "review",
     repo: "acme/widgets",
     nodeId: "7",
     generation: 3,
     startedAt: NOW.toISOString(),
     endedAt: new Date(NOW.getTime() + 5 * MIN).toISOString(),
     outcome: "capped",
    },
   ]);
   reader.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });

 test("serve reading a journal no migration has reached has no history to count, not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-usage-"));
  try {
   const path = join(dir, "state.sqlite");
   new Journal(path).close();
   const sqlite = new Database(path);
   sqlite.run("DROP TABLE substrate_sessions");
   sqlite.close();
   const reader = Journal.openReadOnly(path)!;
   expect(reader.listSubstrateSessions(new Date(0))).toBeNull();
   expect(reader.lastSubstrateSession("claude")).toBeNull();
   reader.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

describe("recording sessions", () => {
 test("a new session of a node closes the dead supervisor's open row as failed; its late end is ignored", () => {
  const j = new Journal(":memory:");
  const scope = { substrate: "claude" as const, kind: "worker" as const, repo: "acme/widgets", nodeId: "20", generation: 1 };
  occupy(j, "20");
  occupy(j, "21");
  const orphan = j.startSubstrateSession(scope, new Date(NOW.getTime() - 30 * MIN));
  const other = j.startSubstrateSession({ ...scope, nodeId: "21" }, new Date(NOW.getTime() - 20 * MIN));
  const next = j.startSubstrateSession({ ...scope, substrate: "codex" }, NOW);
  j.endSubstrateSession(orphan, "ok", NOW);
  const rows = j.listSubstrateSessions(new Date(NOW.getTime() - 60 * MIN))!;
  expect(rows.find((r) => r.id === orphan)).toMatchObject({ outcome: "failed", endedAt: NOW.toISOString() });
  expect(rows.find((r) => r.id === other)).toMatchObject({ outcome: null, endedAt: null });
  expect(rows.find((r) => r.id === next)).toMatchObject({ outcome: null, substrate: "codex" });
  j.close();
 });

 test("rows past the retention window are pruned; the last session is found beyond 7 days", () => {
  const j = new Journal(":memory:");
  const scope = { substrate: "codex" as const, kind: "review" as const, repo: "acme/widgets", generation: 1 };
  occupy(j, "1");
  occupy(j, "2");
  j.endSubstrateSession(j.startSubstrateSession({ ...scope, nodeId: "1" }, new Date(NOW.getTime() - 41 * 24 * 60 * MIN)), "ok");
  const tenDays = j.startSubstrateSession({ ...scope, nodeId: "2" }, new Date(NOW.getTime() - 10 * 24 * 60 * MIN));
  j.endSubstrateSession(tenDays, "ok");
  // The 10-day-old insert pruned the 41-day-old row.
  expect(j.listSubstrateSessions(new Date(0))?.map((r) => r.nodeId)).toEqual(["2"]);
  expect(j.listSubstrateSessions(new Date(NOW.getTime() - 7 * 24 * 60 * MIN))).toEqual([]);
  expect(j.lastSubstrateSession("codex")?.nodeId).toBe("2");
  expect(j.lastSubstrateSession("pi")).toBeNull();
  j.close();
 });

 test("recordSession ends the row with the judged outcome, and a thrown error as failed or transient", async () => {
  const j = new Journal(":memory:");
  const scope = { substrate: "pi" as const, kind: "fix-pass" as const, repo: "acme/widgets", nodeId: "20", generation: 1 };
  for (const node of ["20", "21", "22"]) occupy(j, node);
  expect(await recordSession(j, scope, async (open) => { open(); return 42; }, () => "ok")).toBe(42);
  await expect(
   recordSession(j, { ...scope, nodeId: "21" }, async (open) => { open(); throw new Error("HTTP 502 from GitHub"); }, () => "ok"),
  ).rejects.toThrow("HTTP 502");
  await expect(
   recordSession(j, { ...scope, nodeId: "22" }, async (open) => { open(); throw new Error("git safety"); }, () => "ok"),
  ).rejects.toThrow("git safety");
  const rows = j.listSubstrateSessions(new Date(0))!;
  expect(rows.map((r) => [r.nodeId, r.outcome, r.endedAt !== null])).toEqual([
   ["20", "ok", true],
   ["21", "transient", true],
   ["22", "failed", true],
  ]);
  j.close();
 });

 test("a superseded supervisor opens no row and leaves its replacement's open row alone", () => {
  const j = new Journal(":memory:");
  occupy(j, "20", 2);
  const scope = { substrate: "claude" as const, kind: "worker" as const, repo: "acme/widgets", nodeId: "20" };
  const current = j.startSubstrateSession({ ...scope, generation: 2 }, NOW);
  expect(() => j.startSubstrateSession({ ...scope, kind: "review", generation: 1 }, NOW)).toThrow(FencedError);
  expect(() => j.startSubstrateSession({ ...scope, nodeId: "99", generation: 1 }, NOW)).toThrow(FencedError);
  expect(j.listSubstrateSessions(new Date(0))).toEqual([
   expect.objectContaining({ id: current, generation: 2, endedAt: null, outcome: null }),
  ]);
  j.close();
 });

 test("an attempt that never reaches its spawn records no session", async () => {
  const j = new Journal(":memory:");
  occupy(j, "20");
  const scope = { substrate: "codex" as const, kind: "worker" as const, repo: "acme/widgets", nodeId: "20", generation: 1 };
  // Superseded during the awaits before the spawn: open() is fenced.
  j.beginGeneration("20", "acme/widgets");
  await expect(recordSession(j, scope, async (open) => { open(); return 1; }, () => "ok")).rejects.toThrow(FencedError);
  // Failed before the spawn point: open() was never reached.
  await expect(
   recordSession(j, { ...scope, generation: 2 }, async () => { throw new Error("worktree missing"); }, () => "ok"),
  ).rejects.toThrow("worktree missing");
  expect(j.listSubstrateSessions(new Date(0))).toEqual([]);
  j.close();
 });

 test("failed outcomes: capped only on a cap signal, transient on a GitHub-side error", () => {
  expect(failedSessionOutcome("worker exited 1", { substrate: "claude", resetsAt: null })).toBe("capped");
  expect(failedSessionOutcome("rate limit reached", null)).toBe("failed");
  expect(failedSessionOutcome("ECONNRESET while reading the PR")).toBe("transient");
  expect(failedSessionOutcome("tests failed")).toBe("failed");
 });
});

describe("the panel: one row per known substrate", () => {
 test("every substrate in SUBSTRATE_NAMES has a row, read or not", () => {
  expect(views().map((v) => v.substrate)).toEqual([...SUBSTRATE_NAMES]);
 });

 test("a strong substrate with no reading is treated as capped", () => {
  expect(view("codex")).toMatchObject({
   quota: "unread",
   fiveHour: null,
   sevenDay: null,
   readAt: null,
   eligible: { state: "no", reason: "no reading: treated as capped" },
  });
 });

 test("Pi has no quota and is always eligible", () => {
  expect(view("pi", { readings: [reading("pi")] })).toMatchObject({
   quota: "none",
   fiveHour: null,
   sevenDay: null,
   maxAgeMin: null,
   capped: false,
   eligible: { state: "yes", reason: "no quota (always eligible)" },
  });
 });

 test("each window carries its own reset and time to reset, and the time-scaled threshold", () => {
  const claude = view("claude", {
   readings: [
    reading("claude", {
     fiveHourUsedPct: 12,
     sevenDayUsedPct: 85,
     fiveHourResetsAt: ahead(20 * MIN),
     sevenDayResetsAt: ahead(5 * 60 * MIN),
     resetsAt: ahead(20 * MIN),
    }),
   ],
  });
  expect(claude.fiveHour).toEqual({
   usedPct: 12,
   threshold: expect.closeTo(100 - 30 * (20 / 300), 5),
   resetsAt: ahead(20 * MIN),
   resetInMin: 20,
  });
  // 85% of 7d with 5h left is usable (node #55): the threshold has decayed.
  expect(claude.sevenDay).toEqual({
   usedPct: 85,
   threshold: expect.closeTo(99.405, 2),
   resetsAt: ahead(5 * 60 * MIN),
   resetInMin: 300,
  });
  expect(claude.eligible.state).toBe("yes");
  expect(claude).toMatchObject({ ageMin: 1, maxAgeMin: 15, fresh: true });
 });

 test("a stale reading is shown stale, not ineligible: selection re-reads first", () => {
  const codex = view("codex", {
   readings: [reading("codex", { readAt: ago(12 * MIN), fiveHourUsedPct: 2, sevenDayUsedPct: null })],
  });
  expect(codex.fresh).toBe(false);
  expect(codex.eligible).toEqual({ state: "stale", reason: "stale (12m): re-read at next selection" });
  // The last values are still there, for the greyed display.
  expect(codex.fiveHour?.usedPct).toBe(2);
 });

 test("a capped-until still ahead binds even on a stale reading; a lapsed one is not shown", () => {
  const capped = view("claude", { readings: [reading("claude", { readAt: ago(60 * MIN), cappedUntil: ahead(30 * MIN) })] });
  expect(capped).toMatchObject({ capped: true, cappedUntil: ahead(30 * MIN), eligible: { state: "no" } });
  const lapsed = view("claude", { readings: [reading("claude", { cappedUntil: ago(30 * MIN) })] });
  expect(lapsed).toMatchObject({ capped: false, cappedUntil: null, eligible: { state: "yes" } });
 });

 test("eligibility shown equals what the selector returns for the same reading", () => {
  const cases: SubstrateReading[] = [
   reading("claude"),
   reading("codex"),
   reading("claude", { fiveHourUsedPct: 75 }),
   reading("codex", { sevenDayUsedPct: 80 }),
   reading("claude", { capped: true }),
   reading("codex", { cappedUntil: ahead(10 * MIN) }),
   reading("claude", { fiveHourUsedPct: null, sevenDayUsedPct: null }),
   reading("codex", { sevenDayUsedPct: 85, sevenDayResetsAt: ahead(5 * 60 * MIN) }),
   reading("claude", { fiveHourUsedPct: 69, fiveHourResetsAt: ahead(4 * 60 * MIN) }),
  ];
  for (const r of cases) {
   const shown = view(r.substrate, { readings: [r] }).eligible.state;
   const selector = isEligible(r, CONFIG, NOW) !== null;
   expect(shown === "yes").toBe(selector);
   expect(selectForBuild({ readings: [r], now: NOW, config: CONFIG }) === r.substrate).toBe(selector);
  }
 });
});

describe("the panel: sessions", () => {
 test("counts over running now, the last 24 h and the last 7 d, split by kind with failed/capped/transient", () => {
  const H = 60 * MIN;
  const sessions = [
   session({ kind: "worker", startedAt: ago(2 * H), outcome: "ok" }),
   session({ kind: "worker", startedAt: ago(3 * H), outcome: "capped" }),
   session({ kind: "fix-pass", startedAt: ago(5 * H), outcome: "failed" }),
   session({ kind: "review", startedAt: ago(30 * H), outcome: "transient" }),
   session({ kind: "review", startedAt: ago(6 * 24 * H), outcome: "ok" }),
   // Open: one running, one whose supervisor died.
   session({ kind: "review", nodeId: "30", startedAt: ago(10 * MIN), endedAt: null, outcome: null }),
   session({ kind: "worker", nodeId: "31", startedAt: ago(9 * 24 * H), endedAt: null, outcome: null }),
   // Another substrate's session is not counted here.
   session({ substrate: "codex", kind: "worker", startedAt: ago(H) }),
  ];
  const claude = view("claude", { sessions, live: (s) => s.nodeId === "30" });
  expect(claude.sessions?.running).toEqual({ worker: 0, "fix-pass": 0, review: 1 });
  expect(claude.sessions?.day).toEqual({
   worker: { sessions: 2, failed: 0, capped: 1, transient: 0 },
   "fix-pass": { sessions: 1, failed: 1, capped: 0, transient: 0 },
   review: { sessions: 1, failed: 0, capped: 0, transient: 0 },
   total: { sessions: 4, failed: 1, capped: 1, transient: 0 },
  });
  expect(claude.sessions?.week).toEqual({
   worker: { sessions: 2, failed: 0, capped: 1, transient: 0 },
   "fix-pass": { sessions: 1, failed: 1, capped: 0, transient: 0 },
   review: { sessions: 3, failed: 0, capped: 0, transient: 1 },
   total: { sessions: 6, failed: 1, capped: 1, transient: 1 },
  });
  expect(view("codex", { sessions }).sessions?.day.total.sessions).toBe(1);
 });

 test("the last session: node, kind and when", () => {
  const last = session({ substrate: "pi", kind: "fix-pass", nodeId: "44", startedAt: ago(9 * 24 * 60 * MIN) });
  expect(view("pi", { lastSession: (s) => (s === "pi" ? last : null) }).lastSession).toEqual({
   repo: "acme/widgets",
   nodeId: "44",
   kind: "fix-pass",
   startedAt: last.startedAt,
   endedAt: last.endedAt,
   outcome: "ok",
  });
  expect(view("claude").lastSession).toBeNull();
 });

 test("an open session runs while the supervisor that opened it is alive", () => {
  const worker = (over: Partial<WorkerRow>) =>
   ({ repo: "acme/widgets", nodeId: "20", generation: 1, status: "running", pid: 7, ...over }) as WorkerRow;
  const open = session({ endedAt: null, outcome: null });
  expect(liveSession([worker({})], () => true)(open)).toBe(true);
  expect(liveSession([worker({})], () => false)(open)).toBe(false);
  expect(liveSession([worker({ status: "awaiting-merge", pid: null })], () => true)(open)).toBe(false);
  expect(liveSession([worker({ nodeId: "21" })], () => true)(open)).toBe(false);
  // A replacement supervisor holds the node: the orphan of generation 1 is not running.
  expect(liveSession([worker({ generation: 2, pid: 8 })], () => true)(open)).toBe(false);
 });

 test("a journal with no session history shows no counts rather than zero", () => {
  const v = view("codex", { sessions: null });
  expect(v.sessions).toBeNull();
  expect(v.lastSession).toBeNull();
  expect(view("codex").sessions?.week.total.sessions).toBe(0);
 });

 test("the dashboard state carries the rows it is given", () => {
  const substrates = views();
  const state = assembleState({
   maps: [],
   reports: new Map(),
   titles: new Map(),
   workers: [],
   laneHolders: { visual: null, headless: null },
   paused: false,
   spawnsToday: 0,
   spawnCap: 10,
   vetoed: () => false,
   pidAlive: () => true,
   refreshing: false,
   refreshError: null,
   now: NOW,
   substrates,
  });
  expect(state.substrates.map((s) => s.substrate)).toEqual(["claude", "codex", "pi"]);
 });
});
