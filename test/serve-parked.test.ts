import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerConfig } from "../src/config.ts";
import { Journal, type EventRow, type WorkerRow } from "../src/journal.ts";
import { parseFailedProbes, probesFailedOutcome, reviewCapOutcome } from "../src/outcomes.ts";
import { assembleState, createHandler, renderPage, ServeReader, servedMaps, stateFromJournal, type StateInputs } from "../src/serve.ts";
import {
 type ActionRunner,
 classifyReason,
 MACHINE_GH_KEYS,
 needsYouEntries,
 type NeedsYouInputs,
 type PrView,
} from "../src/serve-parked.ts";

/**
 * Node #54 — "Needs you": parked and failed rows, why ranger stopped them,
 * and the actions the principal may take. Fixtures are shaped like the
 * journal rows of 2026-10-03/04. Nothing here runs gh, osascript or ranger:
 * the runner and the PR reader are injected and recorded.
 */

const SEELITE = "jcfischer/seelite";
const RANGER = "the-metafactory/ranger";
const SHA = "4b2109fa".padEnd(40, "0");

let nextId = 1000;
const ev = (kind: string, detail: string, nodeId = "1", repo = SEELITE): EventRow => ({
 id: nextId--,
 at: "2026-10-04T14:00:00Z",
 nodeId,
 repo,
 kind,
 detail,
});

const row = (over: Partial<WorkerRow>): WorkerRow => ({
 nodeId: "663",
 root: 1,
 repo: SEELITE,
 pid: null,
 status: "parked",
 attempts: 0,
 worktree: "/srv/ranger-repos/jcfischer/seelite/.worktrees/node-663",
 startedAt: "2026-10-04T12:06:20Z",
 finishedAt: "2026-10-04T14:43:24.868Z",
 outcome: null,
 messageId: null,
 lane: "implement",
 generation: 3,
 workerPgid: null,
 phase: "review",
 prNumber: 687,
 researchBaseSha: null,
 reviewRound: 5,
 verdictSha: null,
 verdictBlockers: 0,
 mergeMessageId: null,
 substrate: "codex",
 ...over,
});

// #663, 2026-10-04: five sage rounds, one major left.
const ROW_663 = row({
 outcome: "0 blocker(s) and 1 major(s) remain after 5 sage round(s) on PR #687 — good-enough is the principal's call (design §4/§7)",
});
const EVENTS_663 = [
 ev("parked", ROW_663.outcome as string),
 ev("reviewed", "round 5 @ 4b2109fa: changes-requested, 0 blocker(s), 1 major(s) on claude (head by codex; claude 5h 38% < 96.2%)"),
 ev("pushed", "fix pass 4 @ 4b2109fa"),
 ev("reviewed", "round 4 @ 0b40f3b9: commented, 0 blocker(s), 1 major(s) on claude"),
 ev("worker-start", "implement lane resumes at phase implement"),
 ev("claimed", "claimed by ivy-agent"),
];

// #684, 2026-10-04: probes failed twice; the 400-character outcome lost the
// FAILED: line, so the names come from the narrowed retry.
const ROW_684 = row({
 nodeId: "684",
 prNumber: 686,
 reviewRound: 4,
 outcome:
  "browser probes failed twice at 3c32cb24 on PR #686 (exit 1): cking.mjs,probe-first-day.mjs,probe-hold.mjs: 74 of 86 probes were not run.\n     This is not a pass for the suite.",
});
const EVENTS_684 = [
 ev("parked", ROW_684.outcome as string, "684"),
 ev("reviewed", "probes FAILED at 3c32cb24 (all, 86 selected, 2 run(s))", "684"),
 ev("reviewed", "probe run 1 failed (exit 1) — retrying only probe-bounty.mjs, probe-hold.mjs, probe-sky.mjs", "684"),
 ev("worker-start", "implement lane resumes at phase review", "684"),
 ev("sweep", "resume-node by operator (was parked); run-node pid 96391", "684"),
 ev("reviewed", "probe run 1 failed (exit 1) — retrying only probe-old.mjs", "684"),
 ev("reviewed", "round 4 @ 3c32cb24: commented, 0 blocker(s), 0 major(s) on claude", "684"),
];

describe("node #54 — the reason class, by ranger's own rules", () => {
 test("review cap: the majors still open after the last sage round", () => {
  const reason = classifyReason(ROW_663, EVENTS_663, null, 5);
  expect(reason.class).toBe("review cap");
  expect(reason.detail).toBe("1 major(s) and 0 blocker(s) still open after 5 sage round(s) (cap 5)");
 });

 test("review cap: the head-moved variant too", () => {
  const r = row({ outcome: "review cap reached: 2 sage round(s) on PR #50 and the head moved since the last one — a further round is the principal's call (design §4)" });
  expect(classifyReason(r, [], null, 2).class).toBe("review cap");
 });

 test("probes failed: the names from the run's FAILED: line, when the outcome kept it", () => {
  const outcome = probesFailedOutcome({
   sha: "3c32cb24aa",
   pr: 686,
   exit: 1,
   failed: ["probe-hold.mjs", "probe-sky.mjs"],
   tail: "x".repeat(600),
  });
  // The journal keeps 400 characters; the names sit ahead of the tail.
  const kept = outcome.slice(0, 400);
  expect(parseFailedProbes(kept)).toEqual(["probe-hold.mjs", "probe-sky.mjs"]);
  const reason = classifyReason(row({ outcome: kept }), [], null, 5);
  expect(reason).toMatchObject({ class: "probes failed", probes: ["probe-hold.mjs", "probe-sky.mjs"] });
 });

 test("probes failed: a cut outcome takes the names from this run's retry, not an earlier run's", () => {
  const reason = classifyReason(ROW_684, EVENTS_684, null, 5);
  expect(reason.class).toBe("probes failed");
  expect(reason.probes).toEqual(["probe-bounty.mjs", "probe-hold.mjs", "probe-sky.mjs"]);
 });

 test("needs-eye: an awaiting-merge row with the label", () => {
  const r = row({ nodeId: "433", status: "awaiting-merge", outcome: null });
  expect(classifyReason(r, [], ["ranger:needs-eye"], 5).class).toBe("needs-eye");
 });

 test("transient: a GitHub-side error in the outcome (#45, 2026-10-03)", () => {
  const r = row({
   nodeId: "45",
   repo: RANGER,
   status: "failed",
   outcome: "sage review the-metafactory/ranger#50 exited 1: gh: We couldn't respond to your request in time. Sorry about that.",
  });
  expect(classifyReason(r, [], null, 5).class).toBe("transient");
 });

 test("transient: a crash park after a transient event in this run", () => {
  const r = row({ nodeId: "663", outcome: "parked after 2 crash(es); release refused: ivy-agent" });
  const events = [
   ev("parked", "crashed 2 times — parking; releasing the claim"),
   ev("transient", "GitHub-side transient error, left for the sweep to respawn (not counted): HTTP 502"),
   ev("worker-start", "implement lane resumes at phase review"),
   ev("claimed", "claimed"),
  ];
  expect(classifyReason(r, events, null, 5).class).toBe("transient");
  // A transient error before the row was last put in motion says nothing now.
  const older = [events[0], ev("claimed", "claimed"), events[1]];
  expect(classifyReason(r, older, null, 5).class).toBe("other");
 });

 test("substrate capped", () => {
  const r = row({ status: "failed", outcome: "sage review round 3 on claude hit its rate limit: 429" });
  expect(classifyReason(r, [], null, 5).class).toBe("substrate capped");
  const w = row({ status: "failed", outcome: "substrate codex hit its rate limit (worker log: /x)" });
  expect(classifyReason(w, [], null, 5).class).toBe("substrate capped");
 });

 test("worker failed: a failed row with no other class", () => {
  const r = row({ status: "failed", outcome: "worker exited -1: Ignoring 51 permissions.allow entries\nmore" });
  expect(classifyReason(r, [], null, 5)).toEqual({ class: "worker failed", detail: "worker exited -1: Ignoring 51 permissions.allow entries" });
 });

 test("other: the outcome's first line (#52, merge gate CI failure)", () => {
  const r = row({ nodeId: "52", repo: RANGER, outcome: "merge gate failed (ci-green): CI failed: test=failure\nsecond line" });
  expect(classifyReason(r, [], null, 5)).toEqual({ class: "other", detail: "merge gate failed (ci-green): CI failed: test=failure" });
 });

 test("the builder and the classifier agree on the review-cap words", () => {
  const outcome = reviewCapOutcome({ blockers: 1, majors: 2, round: 3, pr: 9 });
  expect(classifyReason(row({ outcome }), [], null, 3).class).toBe("review cap");
 });
});

const greenPr = (over: Partial<PrView> = {}): PrView => ({
 number: 687,
 url: "https://github.com/jcfischer/seelite/pull/687",
 state: "open",
 merged: false,
 draft: false,
 headSha: SHA,
 mergeable: true,
 ci: "green",
 readAt: "2026-10-04T15:00:00Z",
 ...over,
});

const MAP = { key: `${SEELITE}#1`, repo: SEELITE, root: 1, localCheckout: "/Users/someone/seelite" };

const entryInputs = (over: Partial<NeedsYouInputs> = {}): NeedsYouInputs => ({
 maps: [MAP],
 workers: [ROW_663],
 events: (_repo, nodeId) => (nodeId === "663" ? EVENTS_663 : nodeId === "684" ? EVENTS_684 : []),
 labels: () => null,
 prs: () => greenPr(),
 titleOf: (_repo, id) => `Stations are solid ${id}`,
 reviewRounds: 5,
 exists: () => true,
 ...over,
});

describe("node #54 — the entries", () => {
 test("a parked row carries its PR, last sage round, last probe and actions", () => {
  const [e] = needsYouEntries(entryInputs({ workers: [ROW_684], prs: () => greenPr({ number: 686 }) }));
  expect(e).toMatchObject({
   key: `${SEELITE}#1`,
   nodeId: "684",
   title: "Stations are solid 684",
   url: "https://github.com/jcfischer/seelite/issues/684",
   status: "parked",
   pr: { number: 686 },
   sage: { round: 4, blockers: 0, majors: 0 },
   probe: { passed: false, sha: "3c32cb24" },
   actions: { resume: true, merge: { offered: true, headSha: SHA } },
  });
 });

 test("only parked, failed and needs-eye rows, and only on a map the dashboard reads", () => {
  const rows = [
   ROW_663,
   row({ nodeId: "1", status: "running" }),
   row({ nodeId: "2", status: "success" }),
   row({ nodeId: "3", status: "awaiting-merge" }),
   row({ nodeId: "4", status: "awaiting-merge" }),
   row({ nodeId: "5", status: "failed", outcome: "worker exited 1" }),
   row({ nodeId: "6", root: 460 }),
  ];
  const ids = needsYouEntries(
   entryInputs({ workers: rows, labels: (_r, id) => (id === "4" ? ["ranger:needs-eye"] : []) }),
  ).map((e) => e.nodeId);
  expect(ids.sort()).toEqual(["4", "5", "663"]);
 });

 test("a needs-eye row offers merge, never resume", () => {
  const [e] = needsYouEntries(
   entryInputs({ workers: [row({ nodeId: "4", status: "awaiting-merge" })], labels: () => ["ranger:needs-eye"] }),
  );
  expect(e.actions.resume).toBe(false);
  expect(e.actions.merge.offered).toBe(true);
 });

 test("merge is offered only for an open, ready, mergeable PR with CI green", () => {
  const why = (pr: PrView | null) => {
   const m = needsYouEntries(entryInputs({ prs: () => pr }))[0].actions.merge;
   return m.offered ? null : m.why;
  };
  expect(why(greenPr())).toBeNull();
  expect(why(null)).toMatch(/not been read/);
  expect(why(greenPr({ ci: "pending" }))).toMatch(/CI is pending/);
  expect(why(greenPr({ ci: "failed" }))).toMatch(/CI is failed/);
  expect(why(greenPr({ draft: true }))).toMatch(/draft/);
  expect(why(greenPr({ mergeable: false }))).toMatch(/not mergeable/);
  expect(why(greenPr({ state: "closed" }))).toMatch(/closed/);
  expect(why(greenPr({ merged: true }))).toMatch(/merged/);
 });

 test("the session opens in the worktree, else the map's checkout, else not at all", () => {
  const cwd = (exists: (p: string) => boolean) => needsYouEntries(entryInputs({ exists }))[0].actions.session;
  expect(cwd(() => true)).toEqual({ offered: true, cwd: ROW_663.worktree as string });
  expect(cwd((p) => p === MAP.localCheckout)).toEqual({ offered: true, cwd: MAP.localCheckout });
  expect(cwd(() => false).offered).toBe(false);
 });
});

describe("node #54 — the actions and their guards", () => {
 const PORT = 7311;
 const TOKEN = "t".repeat(48);
 const MACHINE_ENV = {
  PATH: "/usr/bin",
  HOME: "/Users/someone",
  GH_TOKEN: "ghp_machine",
  GITHUB_TOKEN: "ghp_other",
  GH_CONFIG_DIR: "/Users/someone/.config/ranger/gh-config",
  RANGER_WRITE_GH_TOKEN_PERSONAL: "ghp_machine",
 };
 const baseInputs = (): StateInputs => ({
  maps: [{ ...MAP, walk: "full", lane: "visual", servedOnly: false }],
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
  now: new Date("2026-10-04T15:00:00Z"),
 });
 const setup = (
  opts: { rows?: WorkerRow[]; labels?: string[]; live?: PrView | null; pr?: PrView | null; exists?: (p: string) => boolean } = {},
 ) => {
  const runs: { argv: string[]; env: Record<string, string>; detached: boolean }[] = [];
  const run: ActionRunner = async (argv, env, o) => {
   runs.push({ argv, env, detached: o.detached });
   return { code: 0, stderr: "" };
  };
  const after: string[] = [];
  const handler = createHandler({
   port: PORT,
   token: TOKEN,
   getState: () =>
    assembleState({
     ...baseInputs(),
     needsYou: needsYouEntries(
      entryInputs({
       workers: opts.rows ?? [ROW_663],
       labels: () => opts.labels ?? null,
       prs: () => (opts.pr === undefined ? greenPr() : opts.pr),
       exists: opts.exists ?? (() => true),
      }),
     ),
    }),
   refresh: () => {},
   launch: () => {
    throw new Error("the grilling launch must not run");
   },
   verifyGrilling: async () => null,
   actions: {
    run,
    env: MACHINE_ENV,
    rangerBin: "/Users/someone/bin/ranger",
    configPath: "/Users/someone/ranger/ranger.yaml",
    readPr: async () => (opts.live === undefined ? greenPr() : opts.live),
    exists: opts.exists ?? (() => true),
    after: (e) => after.push(e.nodeId),
   },
  });
  return { handler, runs, after };
 };
 const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:${PORT}${path}`, {
   method: "POST",
   headers: {
    host: `127.0.0.1:${PORT}`,
    origin: `http://127.0.0.1:${PORT}`,
    "x-ranger-token": TOKEN,
    "content-type": "application/json",
    ...headers,
   },
   body: JSON.stringify(body),
  });
 const ok = { key: `${SEELITE}#1`, id: "663" };

 test("resume runs the CLI verb for that map, detached, with no ambient credential", async () => {
  const { handler, runs, after } = setup();
  const res = await handler(post("/api/resume", ok));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, code: 0 });
  expect(runs).toHaveLength(1);
  expect(runs[0].argv).toEqual([
   "/Users/someone/bin/ranger",
   "resume-node",
   "663",
   "--map",
   `${SEELITE}#1`,
   "-c",
   "/Users/someone/ranger/ranger.yaml",
  ]);
  expect(runs[0].detached).toBe(true);
  expect(Object.keys(runs[0].env).sort()).toEqual(["HOME", "PATH"]);
  expect(after).toEqual(["663"]);
 });

 test("resume adds --force only when the principal ticks it", async () => {
  const { handler, runs } = setup();
  await handler(post("/api/resume", { ...ok, force: true }));
  await handler(post("/api/resume", { ...ok, force: "yes" }));
  expect(runs[0].argv.at(-1)).toBe("--force");
  expect(runs[1].argv).not.toContain("--force");
 });

 test("merge runs gh under the principal's login, pinned to the confirmed head", async () => {
  const { handler, runs } = setup();
  const res = await handler(post("/api/merge", { ...ok, sha: SHA }));
  expect(res.status).toBe(200);
  expect(runs).toHaveLength(1);
  expect(runs[0].argv).toEqual(["gh", "pr", "merge", "687", "--repo", SEELITE, "--squash", "--match-head-commit", SHA]);
  for (const key of MACHINE_GH_KEYS) expect(runs[0].env[key]).toBeUndefined();
  expect(Object.keys(runs[0].env).some((k) => /TOKEN/.test(k))).toBe(false);
  expect(runs[0].env.HOME).toBe("/Users/someone");
 });

 test("the session prompt carries the repo, the id and the reason class only", async () => {
  const { handler, runs } = setup();
  const res = await handler(post("/api/session", { ...ok, dryRun: true }));
  expect(res.status).toBe(200);
  const script = ((await res.json()) as { argv: string[] }).argv.join(" ");
  expect(script).toContain("iTerm2");
  expect(script).toContain("#663");
  expect(script).toContain(SEELITE);
  expect(script).toContain("review cap");
  expect(script).not.toContain("good-enough");
  expect(script).not.toContain("Stations are solid");
  expect(runs).toHaveLength(0);
  await handler(post("/api/session", ok));
  expect(runs[0].argv[0]).toBe("osascript");
  expect(Object.keys(runs[0].env).sort()).toEqual(["HOME", "PATH"]);
 });

 const refusals: [string, string, Request, Parameters<typeof setup>[0]?][] = [
  ["no token", "resume", post("/api/resume", ok, { "x-ranger-token": "" })],
  ["wrong token", "resume", post("/api/resume", ok, { "x-ranger-token": "x".repeat(48) })],
  ["wrong token on merge", "merge", post("/api/merge", { ...ok, sha: SHA }, { "x-ranger-token": "x".repeat(48) })],
  ["foreign origin", "merge", post("/api/merge", { ...ok, sha: SHA }, { origin: "https://evil.example" })],
  ["foreign origin on session", "session", post("/api/session", ok, { origin: "https://evil.example" })],
  ["rebound host", "resume", post("/api/resume", ok, { host: `evil.example:${PORT}` })],
  ["non-numeric id", "resume", post("/api/resume", { ...ok, id: "663; rm -rf /" })],
  ["non-numeric id on merge", "merge", post("/api/merge", { ...ok, id: "663 --admin", sha: SHA })],
  ["unknown map", "resume", post("/api/resume", { key: "other/repo#1", id: "663" })],
  ["a row that is not parked or failed", "resume", post("/api/resume", ok), { rows: [row({ status: "running" })] }],
  ["a merged row", "session", post("/api/session", ok), { rows: [row({ status: "success" })] }],
  ["resume of a needs-eye merge", "resume", post("/api/resume", ok), { rows: [row({ status: "awaiting-merge" })], labels: ["ranger:needs-eye"] }],
  ["an awaiting-merge row without the label", "merge", post("/api/merge", { ...ok, sha: SHA }), { rows: [row({ status: "awaiting-merge" })], labels: [] }],
  ["merge with CI pending", "merge", post("/api/merge", { ...ok, sha: SHA }), { pr: greenPr({ ci: "pending" }) }],
  ["merge of a SHA the page did not show", "merge", post("/api/merge", { ...ok, sha: "f".repeat(40) })],
  ["merge with no SHA", "merge", post("/api/merge", ok)],
  ["merge whose head moved when read live", "merge", post("/api/merge", { ...ok, sha: SHA }), { live: greenPr({ headSha: "e".repeat(40) }) }],
  ["merge whose CI failed when read live", "merge", post("/api/merge", { ...ok, sha: SHA }), { live: greenPr({ ci: "failed" }) }],
  ["merge when the PR cannot be read live", "merge", post("/api/merge", { ...ok, sha: SHA }), { live: null }],
  ["session with no directory", "session", post("/api/session", ok), { exists: () => false }],
 ];
 for (const [name, , req, opts] of refusals) {
  test(`refuses: ${name}`, async () => {
   const { handler, runs, after } = setup(opts);
   const res = await handler(req);
   expect(res.status).toBeGreaterThanOrEqual(400);
   expect(runs).toHaveLength(0);
   expect(after).toHaveLength(0);
  });
 }

 test("a failing action shows its exit code and stderr tail", async () => {
  const handler = createHandler({
   port: PORT,
   token: TOKEN,
   getState: () => assembleState({ ...baseInputs(), needsYou: needsYouEntries(entryInputs()) }),
   refresh: () => {},
   launch: () => {},
   verifyGrilling: async () => null,
   actions: {
    run: async () => ({ code: 1, stderr: "ranger resume-node: the visual implement lane is held by #700" }),
    rangerBin: "/bin/ranger",
    configPath: "/x/ranger.yaml",
    readPr: async () => greenPr(),
    exists: () => true,
   },
  });
  const res = await handler(post("/api/resume", ok));
  expect(await res.json()).toMatchObject({ ok: false, code: 1, stderr: expect.stringContaining("lane is held by #700") });
 });

 test("the page puts Needs you above Open grillings, and says to reload on a stale token", () => {
  const page = renderPage(TOKEN);
  expect(page.indexOf("<h2>Needs you</h2>")).toBeGreaterThan(0);
  expect(page.indexOf("<h2>Needs you</h2>")).toBeLessThan(page.indexOf("<h2>Open grillings</h2>"));
  expect(page).toContain("reload the page");
  const script = page.split("<script>")[1].split("</script>")[0];
  expect(() => new Function(script)).not.toThrow();
 });
});

describe("node #54 — the journal feeds the section, with no GitHub call from a state read", () => {
 test("a parked row and its events become an entry; details come only from the reader's cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-serve-parked-"));
  const path = join(dir, "state.sqlite");
  const writer = new Journal(path);
  writer.upsertWorker({ ...ROW_663, status: "parked" });
  writer.recordEvent("claimed", { nodeId: "663", repo: SEELITE, detail: "claimed" });
  writer.recordEvent("reviewed", {
   nodeId: "663",
   repo: SEELITE,
   detail: "round 5 @ 4b2109fa: changes-requested, 0 blocker(s), 1 major(s) on claude",
  });
  writer.recordEvent("parked", { nodeId: "663", repo: SEELITE, detail: ROW_663.outcome as string });
  writer.close();
  const config = {
   version: 1,
   maps: [{ repo: SEELITE, root: 1, walk: "full", skip: [], commands: {}, autoMerge: true, base: "main" }],
   auth: { readOnlyTokens: {}, writeTokens: {} },
   bot: { identity: "bot" },
   principal: {},
   state: { journalPath: path, canonicalRoot: "/srv/ranger-repos" },
   workers: { spawnCapPerDay: 10, wallClockMin: 90, maxAttempts: 2, deadmanThreshold: 3, reviewRounds: 5 },
   budget: { graphqlFloor: 1000, rateLimitCooldownMin: 10, frontierMaxAgeMin: 60 },
  } as unknown as RangerConfig;
  const maps = servedMaps(config);
  const reads: string[] = [];
  const reader = new ServeReader(config, maps, path, {
   issue: async (repo, id) => {
    reads.push(`${repo}#${id}`);
    return { title: "stations are solid", labels: [] };
   },
   pr: async () => {
    reads.push("pr");
    return greenPr();
   },
  });
  const state = stateFromJournal(config, maps, reader);
  expect(reads).toEqual([]);
  expect(state.needsYou).toHaveLength(1);
  expect(state.needsYou[0]).toMatchObject({
   nodeId: "663",
   status: "parked",
   reason: { class: "review cap" },
   sage: { round: 5, majors: 1 },
   pr: { number: 687, view: null },
   actions: { merge: { offered: false } },
  });
  expect(reader.hasUnreadDetails()).toBe(true);
  rmSync(dir, { recursive: true });
 });

 test("a detail read that fails is not retried on every state read, only on the timer", async () => {
  const config = { state: { journalPath: "/nonexistent" } } as unknown as RangerConfig;
  const calls: string[] = [];
  const reader = new ServeReader(config, [], "/nonexistent", {
   issue: async (repo, id) => {
    calls.push(`issue ${repo}#${id}`);
    return null;
   },
   pr: async () => {
    calls.push("pr");
    throw new Error("HTTP 502");
   },
  });
  reader.wantDetails([`${SEELITE}#663`], [`${SEELITE}#687`]);
  expect(reader.hasUnreadDetails()).toBe(true);
  await reader.refreshDetails();
  expect(calls).toEqual([`issue ${SEELITE}#663`, "pr"]);
  expect(reader.detailError).toMatch(/HTTP 502/);
  expect(reader.lastError).toBeNull();
  // The next state read finds nothing untried: no second round of REST.
  expect(reader.hasUnreadDetails()).toBe(false);
  await reader.refreshDetails();
  expect(calls).toHaveLength(2);
  // The timer reads everything wanted again.
  await reader.refreshDetails(true);
  expect(calls).toHaveLength(4);
  // An action forgets its entry, so that entry is read once more at once.
  reader.forget(`${SEELITE}#663`, `${SEELITE}#687`);
  expect(reader.hasUnreadDetails()).toBe(true);
 });
});
