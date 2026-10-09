import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerConfig } from "../src/config.ts";
import { Journal, type EventRow, type WorkerRow } from "../src/journal.ts";
import {
 CRASH_PARK_OUTCOME,
 crashParkOutcome,
 parseFailedProbes,
 policyBlockedOutcome,
 probesFailedOutcome,
 RESPAWNED_EVENT,
 respawnedEvent,
 reviewCapHeadMovedOutcome,
 reviewCapOutcome,
} from "../src/outcomes.ts";
import { assembleState, createHandler, DETAIL_CONCURRENCY, renderPage, ServeReader, servedMaps, stateFromJournal, type StateInputs } from "../src/serve.ts";
import {
 type ActionRunner,
 checkRunsFromPages,
 workflowRunsFromPages,
 ciState,
 classifyReason,
 mergeRefusal,
 MACHINE_FORGE_KEYS,
 needsYouEntries,
 awaitingMergeEntries,
 type NeedsYouInputs,
 type PrView,
 uncheckedNeedsEye,
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
  const r = row({ outcome: reviewCapHeadMovedOutcome({ repo: "acme/widgets", rounds: 2, pr: 50 }) });
  expect(classifyReason(r, [], null, 2).class).toBe("review cap");
 });

 test("review cap, head moved: the stop is the unreviewed head, never the earlier head's counts as current", () => {
  const r = row({ outcome: reviewCapHeadMovedOutcome({ repo: "acme/widgets", rounds: 5, pr: 687 }) });
  const events = [ev("parked", r.outcome as string), ev("reviewed", "round 5 @ 4b2109fa: commented, 0 blocker(s), 0 major(s) on claude")];
  const reason = classifyReason(r, events, null, 5);
  expect(reason.class).toBe("review cap");
  expect(reason.detail).not.toContain("still open after");
  expect(reason.detail).toContain("the current head is unreviewed");
  expect(reason.detail).toContain("round 5 read the earlier head 4b2109fa");
  // The entry says the round read an earlier head, so the card does not show its counts as current.
  const moved = greenPr({ headSha: "9".repeat(40) });
  const [e] = needsYouEntries(entryInputs({ workers: [r], events: () => events, prs: () => moved }));
  expect(e.sageOnHead).toBe(false);
  const [same] = needsYouEntries(entryInputs({ workers: [r], events: () => events }));
  expect(same.sageOnHead).toBe(true);
 });

 test("probes failed: the names from the run's FAILED: line, when the outcome kept it", () => {
  const outcome = probesFailedOutcome({ repo: "acme/widgets",
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
  // The retry's selection is not shown as the final run's failures.
  expect(reason.detail).not.toMatch(/^failed:/);
  expect(reason.detail).toMatch(/the first run failed .*the retry's own failures are not recorded/);
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

 test("transient: the detail names the match and keeps the outcome, never exonerating the node", () => {
  // A worker's own bug can carry ECONNRESET from another service; the text
  // match cannot tell, so the dashboard must not say it was GitHub's fault.
  const r = row({ nodeId: "54", repo: RANGER, status: "failed", outcome: "TypeError: fetch to the views server failed: ECONNRESET" });
  const reason = classifyReason(r, [], null, 5);
  expect(reason.class).toBe("transient");
  expect(reason.detail).toContain("TypeError: fetch to the views server failed: ECONNRESET");
  expect(reason.detail).not.toContain("not the node's fault");
  expect(reason.detail).not.toContain("GitHub-side");
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

 test("transient: an earlier attempt's error does not hide a permanent failure after the respawn", () => {
  const r = row({ nodeId: "663", status: "failed", outcome: "worker exited 1: TypeError: x is undefined\nstack" });
  const events = [
   ev("failed", "worker exited 1"),
   ev("worker-start", "implement lane resumes at phase review"),
   ev("sweep", respawnedEvent(2)),
   ev("transient", "GitHub-side transient error, left for the sweep to respawn (not counted): HTTP 502"),
   ev("worker-start", "implement lane starts"),
   ev("claimed", "claimed"),
  ];
  expect(classifyReason(r, events, null, 5)).toEqual({ class: "worker failed", detail: "worker exited 1: TypeError: x is undefined" });
 });

 test("transient: a crash park counts only its last attempt's transient error", () => {
  const r = row({ nodeId: "663", outcome: crashParkOutcome({ attempts: 2, released: false, assignees: ["ivy-agent"] }) });
  const events = [
   ev("parked", "crashed 2 times — parking; releasing the claim"),
   ev("worker-start", "implement lane resumes at phase review"),
   ev("sweep", respawnedEvent(2)),
   ev("transient", "GitHub-side transient error, left for the sweep to respawn (not counted): HTTP 502"),
   ev("claimed", "claimed"),
  ];
  expect(classifyReason(r, events, null, 5).class).toBe("other");
  // "respawn waits" and "respawn refused" start no new attempt.
  const waited = [events[0], ev("sweep", "respawn waits for the visual implement lane (held by #1)"), events[3], events[4]];
  expect(classifyReason(r, waited, null, 5).class).toBe("transient");
 });

 test("the sweep's builders and the classifier agree on the crash-park and respawn words", () => {
  expect(CRASH_PARK_OUTCOME.test(crashParkOutcome({ attempts: 2, released: true, assignees: [] }))).toBe(true);
  expect(CRASH_PARK_OUTCOME.test(crashParkOutcome({ attempts: 3, released: false, assignees: [] }))).toBe(true);
  expect(RESPAWNED_EVENT.test(respawnedEvent(4))).toBe(true);
  expect(RESPAWNED_EVENT.test("respawn refused (spawn cap or no respawn hook) — claim kept for the next tick")).toBe(false);
 });

 test("policy blocked: a hook stopped the worker before its first turn", () => {
  const outcome = policyBlockedOutcome({ pass: "fix pass 3", reason: "Runtime policy denied this action: security-disable-request.", log: "/x.log" });
  const r = row({ status: "parked", outcome });
  expect(classifyReason(r, [], null, 5)).toEqual({ class: "policy blocked", detail: outcome.split("\n")[0].slice(0, 200) });
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
  const outcome = reviewCapOutcome({ repo: "acme/widgets", blockers: 1, majors: 2, round: 3, pr: 9 });
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

describe("node #54 — CI, by the merge gate's rules", () => {
 const done = (conclusion: string) => ({ status: "completed", conclusion });
 test("all skipped or all neutral is not green: the close needs one success to cite", () => {
  expect(ciState([done("skipped"), done("skipped")])).toBe("no-success");
  expect(ciState([done("neutral")])).toBe("no-success");
  expect(mergeRefusal(greenPr({ ci: "no-success" }))).toMatch(/no check run concluded success/);
  expect(needsYouEntries(entryInputs({ prs: () => greenPr({ ci: "no-success" }) }))[0].actions.merge.offered).toBe(false);
 });
 test("success beside skipped is green; a failure or a running check is not", () => {
  expect(ciState([done("success"), done("skipped"), done("neutral")])).toBe("green");
  expect(ciState([done("success"), done("failure")])).toBe("failed");
  expect(ciState([done("success"), { status: "in_progress", conclusion: null }])).toBe("pending");
  expect(ciState([])).toBe("none");
 });
 test("every page of check runs counts: a failure on page two is not green", () => {
  const page1 = { check_runs: Array.from({ length: 100 }, () => done("success")) };
  const page2 = { check_runs: [done("failure")] };
  const runs = checkRunsFromPages([page1, page2]);
  expect(runs).toHaveLength(101);
  expect(ciState(runs ?? [])).toBe("failed");
 });
 test("an unreadable check-runs read refuses the merge and says so", () => {
  expect(mergeRefusal(greenPr({ ci: "unreadable" }))).toBe("the check runs could not be read");
 });
 test("a failed PR read is carried on the entry, not shown as merely unread", () => {
  const [e] = needsYouEntries(entryInputs({ prs: () => null, prError: () => "HTTP 502" }));
  expect(e.pr).toMatchObject({ number: 687, view: null, error: "HTTP 502" });
  expect(renderPage("token")).toContain("the read failed: ");
 });
 test("a malformed page makes the whole read unreadable rather than dropping it", () => {
  expect(checkRunsFromPages([{ check_runs: [done("success")] }, { message: "Bad gateway" }])).toBeNull();
  expect(checkRunsFromPages({ check_runs: [] })).toBeNull();
  expect(checkRunsFromPages(null)).toBeNull();
 });
 test("Actions-only green CI offers the merge: the action re-reads every check before it merges", () => {
  const view = { number: 7, url: "u", state: "open", merged: false, draft: false, headSha: "a".repeat(40), mergeable: true, ci: "green", readAt: "t" } as const;
  expect(mergeRefusal({ ...view, ciSource: "actions" })).toBeNull();
  expect(mergeRefusal({ ...view, ciSource: "actions", ci: "pending" })).toBe("CI is pending");
 });
 test("workflow runs stand in for check runs: latest per workflow and event, and only for the head asked about", () => {
  const sha = "a".repeat(40);
  const run = (id: number, workflow: number, conclusion: string | null, status = "completed", head = sha) =>
   ({ id, workflow_id: workflow, event: "pull_request", head_sha: head, status, conclusion });
  // workflow 10 failed, then a rerun passed; workflow 11 is still running
  expect(workflowRunsFromPages([{ total_count: 3, workflow_runs: [run(1, 10, "failure"), run(2, 10, "success"), run(3, 11, null, "in_progress")] }], sha))
   .toEqual([{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }]);
  expect(workflowRunsFromPages([{ workflow_runs: [run(1, 10, "success", "completed", "b".repeat(40))] }], sha)).toBeNull();
  expect(workflowRunsFromPages([{ message: "Resource not accessible by personal access token" }], sha)).toBeNull();
  expect(workflowRunsFromPages(null, sha)).toBeNull();
 });
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
  expect(why(greenPr({ mergeable: false }))).toMatch(/conflicts with its base/);
  expect(why(greenPr({ state: "closed" }))).toMatch(/closed/);
  expect(why(greenPr({ merged: true }))).toMatch(/merged/);
 });

 test("the session opens only in the principal's checkout, never the worker's worktree", () => {
  const session = (exists: (p: string) => boolean, maps: NeedsYouInputs["maps"] = [MAP]) =>
   needsYouEntries(entryInputs({ exists, maps }))[0].actions.session;
  // The worktree exists and is still not chosen: it is the machine-account clone's.
  expect(session(() => true)).toEqual({ offered: true, cwd: MAP.localCheckout });
  expect(session((p) => p === ROW_663.worktree)).toEqual({ offered: false, why: `${MAP.localCheckout} does not exist` });
  const noCheckout = session(() => true, [{ ...MAP, localCheckout: undefined }]);
  expect(noCheckout.offered).toBe(false);
  expect(noCheckout.offered ? "" : noCheckout.why).toMatch(/no localCheckout/);
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
  opts: {
   rows?: WorkerRow[];
   labels?: string[];
   live?: PrView | null;
   pr?: PrView | null;
   exists?: (p: string) => boolean;
   verifyChecks?: (repo: string, sha: string, env: Record<string, string>) => Promise<PrView["ci"] | null>;
  } = {},
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
    ...(opts.verifyChecks === undefined ? {} : { verifyChecks: opts.verifyChecks }),
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

 test("merge runs gh without the machine account's credential, pinned to the confirmed head", async () => {
  const { handler, runs } = setup();
  const res = await handler(post("/api/merge", { ...ok, sha: SHA }));
  expect(res.status).toBe(200);
  expect(runs).toHaveLength(3);
  expect(runs[0].argv).toEqual(["gh", "pr", "merge", "687", "--repo", SEELITE, "--squash", "--match-head-commit", SHA]);
  for (const key of MACHINE_FORGE_KEYS) expect(runs[0].env[key]).toBeUndefined();
  expect(Object.keys(runs[0].env).some((k) => /TOKEN/.test(k))).toBe(false);
  expect(runs[0].env.HOME).toBe("/Users/someone");
 });

 test("a merge runs the map's merge desk at once, so the close starts without waiting for a tick", async () => {
  const { handler, runs } = setup();
  const res = await handler(post("/api/merge", { ...ok, sha: SHA }));
  expect(await res.json()).toMatchObject({ ok: true, close: { ok: true, code: 0 } });
  expect(runs[1].argv).toEqual([expect.stringMatching(/\/bin\/ranger$/), "merge-desk", "--map", `${SEELITE}#1`, "-c", expect.stringMatching(/\/ranger\.yaml$/)]);
  expect(runs[1].detached).toBe(true);
  expect(Object.keys(runs[1].env).sort()).toEqual(["HOME", "PATH"]);
  // Then a second pass that first waits for GitHub to recompute the other PRs' mergeability.
  expect(runs[2].argv.slice(1)).toEqual(["merge-desk", "--map", `${SEELITE}#1`, "--settle", "-c", expect.stringMatching(/\/ranger\.yaml$/)]);
 });

 test("a merge refused because the PR now conflicts runs the merge desk, which sends it back for a base merge", async () => {
  const waiting = row({ status: "awaiting-merge" });
  const [e] = awaitingMergeEntries(entryInputs({ workers: [waiting], labels: () => [], prs: () => greenPr() }));
  const runs: string[][] = [];
  const handler = createHandler({
   port: PORT,
   token: TOKEN,
   getState: () => assembleState({ ...baseInputs(), awaitingMerge: [e] }),
   refresh: () => {},
   launch: () => {},
   verifyGrilling: async () => null,
   actions: {
    run: async (argv) => (runs.push(argv), { code: 0, stderr: "" }),
    env: MACHINE_ENV,
    rangerBin: "/r",
    configPath: "/c",
    readPr: async () => greenPr({ mergeable: false }),
    exists: () => true,
   },
  });
  const res = await handler(post("/api/merge", { ...ok, sha: SHA }));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toMatch(/conflicts with its base.*the merge desk ran now/);
  expect(runs).toEqual([["/r", "merge-desk", "--map", `${SEELITE}#1`, "-c", "/c"]]);
 });

 test("a dry-run merge names the desk it would run", async () => {
  const { handler, runs } = setup();
  const res = await handler(post("/api/merge", { ...ok, sha: SHA, dryRun: true }));
  expect(((await res.json()) as { closeArgv: string[] }).closeArgv).toEqual([expect.stringMatching(/\/bin\/ranger$/), "merge-desk", "--map", `${SEELITE}#1`, "-c", expect.stringMatching(/\/ranger\.yaml$/)]);
  expect(runs).toHaveLength(0);
 });

 test("a failed merge runs no desk; a failed row's merge runs none either (the desk does not watch it)", async () => {
  const failing = setup();
  const failRun: ActionRunner = async (argv, env, o) => {
   failing.runs.push({ argv, env, detached: o.detached });
   return { code: 1, stderr: "merge refused" };
  };
  const h = createHandler({
   port: PORT,
   token: TOKEN,
   getState: () => assembleState({ ...baseInputs(), needsYou: needsYouEntries(entryInputs({ prs: () => greenPr() })) }),
   refresh: () => {},
   launch: () => {},
   verifyGrilling: async () => null,
   actions: { run: failRun, env: MACHINE_ENV, rangerBin: "/r", configPath: "/c", readPr: async () => greenPr(), exists: () => true },
  });
  const res = await h(post("/api/merge", { ...ok, sha: SHA }));
  expect(((await res.json()) as { close?: unknown }).close).toBeUndefined();
  expect(failing.runs).toHaveLength(1);

  const { handler, runs } = setup({ rows: [row({ status: "failed", outcome: "worker exited 1" })] });
  await handler(post("/api/merge", { ...ok, sha: SHA }));
  expect(runs).toHaveLength(1);
  expect(runs[0].argv[0]).toBe("gh");
 });

 const mergeNow = (gateCode: number) => {
  const waiting = row({ status: "awaiting-merge" });
  const inputs = entryInputs({ workers: [waiting], labels: () => [], prs: () => greenPr() });
  const [e] = awaitingMergeEntries(inputs);
  const runs: string[][] = [];
  const handler = createHandler({
   port: PORT,
   token: TOKEN,
   getState: () => assembleState({ ...baseInputs(), awaitingMerge: [e] }),
   refresh: () => {},
   launch: () => {},
   verifyGrilling: async () => null,
   actions: {
    run: async (argv) => {
     runs.push(argv);
     return argv[1] === "merge-gate" && gateCode !== 0
      ? { code: gateCode, stderr: "merge gate fail (review-clean): sage verdict at 4b2109fa has 0 blocker(s) and 1 major(s)" }
      : { code: 0, stderr: "" };
    },
    env: MACHINE_ENV,
    rangerBin: "/r",
    configPath: "/c",
    readPr: async () => greenPr(),
    exists: () => true,
   },
  });
  return { inputs, e, runs, handler };
 };

 test("Merge now: a plain awaiting-merge row merges once the merge desk's gate passes at the confirmed head", async () => {
  const { inputs, e, runs, handler } = mergeNow(0);
  expect(needsYouEntries(inputs)).toHaveLength(0);
  expect(e.actions.merge).toEqual({ offered: true, headSha: SHA });
  const res = await handler(post("/api/merge", { ...ok, sha: SHA }));
  expect(res.status).toBe(200);
  expect(runs.map((a) => (a[0] === "gh" ? "gh" : a[1]))).toEqual(["merge-gate", "gh", "merge-desk", "merge-desk"]);
  expect(runs[3]).toContain("--settle");
  expect(runs[0]).toEqual(["/r", "merge-gate", "663", "--map", `${SEELITE}#1`, "--sha", SHA, "-c", "/c"]);
  const stale = await handler(post("/api/merge", { ...ok, sha: "f".repeat(40) }));
  expect(stale.status).toBe(409);
 });

 test("Merge now: the merge desk's gate holding it refuses the merge, with its reason, and gh never runs", async () => {
  const { runs, handler } = mergeNow(2);
  const res = await handler(post("/api/merge", { ...ok, sha: SHA }));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toMatch(/merge desk's gate holds it: merge gate fail \(review-clean\)/);
  expect(runs.map((a) => a[1])).toEqual(["merge-gate"]);
 });

 test("a parked row's merge is the principal's override: no merge desk gate", async () => {
  const { handler, runs } = setup();
  await handler(post("/api/merge", { ...ok, sha: SHA }));
  expect(runs.map((r) => r.argv[1])).not.toContain("merge-gate");
 });

 test("an Actions-only green PR merges once every check, read under the principal's login, is green", async () => {
  const seen: { repo: string; sha: string; env: Record<string, string> }[] = [];
  const actionsOnly = greenPr({ ciSource: "actions" });
  const { handler, runs } = setup({
   pr: actionsOnly,
   live: actionsOnly,
   verifyChecks: async (repo, sha, env) => {
    seen.push({ repo, sha, env });
    return "green";
   },
  });
  const res = await handler(post("/api/merge", { ...ok, sha: SHA }));
  expect(res.status).toBe(200);
  expect(runs).toHaveLength(3);
  expect(seen).toEqual([{ repo: SEELITE, sha: SHA, env: runs[0].env }]); // the merge's own environment
  for (const key of MACHINE_FORGE_KEYS) expect(seen[0].env[key]).toBeUndefined();
 });

 for (const [why, full, says] of [
  ["a failing external check", "failed", "every check, read under your login: CI is failed"],
  ["checks the principal cannot read either", null, "every check could not be read under your login"],
 ] as const) {
  test(`an Actions-only green PR is refused on ${why}`, async () => {
   const actionsOnly = greenPr({ ciSource: "actions" });
   const { handler, runs } = setup({ pr: actionsOnly, live: actionsOnly, verifyChecks: async () => full });
   const res = await handler(post("/api/merge", { ...ok, sha: SHA }));
   expect(res.status).toBe(409);
   expect(JSON.stringify(await res.json())).toContain(says);
   expect(runs).toHaveLength(0);
  });
 }

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
  ["a null body", "resume", post("/api/resume", null)],
  ["an array body", "merge", post("/api/merge", [ok])],
  ["a null body on the grilling launch", "grill", post("/api/grill", null)],
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

 test("a second action on the same node while the first runs is refused with 409", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => {
   release = done;
  });
  let runs = 0;
  const handler = createHandler({
   port: PORT,
   token: TOKEN,
   getState: () => assembleState({ ...baseInputs(), needsYou: needsYouEntries(entryInputs()) }),
   refresh: () => {},
   launch: () => {},
   verifyGrilling: async () => null,
   actions: {
    run: async () => {
     runs++;
     await gate;
     return { code: 0, stderr: "" };
    },
    rangerBin: "/bin/ranger",
    configPath: "/x/ranger.yaml",
    readPr: async () => greenPr(),
    exists: () => true,
   },
  });
  const first = handler(post("/api/resume", ok));
  await Bun.sleep(0);
  const second = await handler(post("/api/resume", ok));
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({ error: expect.stringContaining("already running") });
  release();
  expect((await first).status).toBe(200);
  expect(runs).toBe(1);
  // Released with the child: the next request is judged on the journal again.
  expect((await handler(post("/api/resume", ok))).status).toBe(200);
  expect(runs).toBe(2);
 });

 test("a timed-out action keeps the node held until its child really exits", async () => {
  let exit: () => void = () => {};
  const exited = new Promise<void>((done) => {
   exit = done;
  });
  let runs = 0;
  const handler = createHandler({
   port: PORT,
   token: TOKEN,
   getState: () => assembleState({ ...baseInputs(), needsYou: needsYouEntries(entryInputs()) }),
   refresh: () => {},
   launch: () => {},
   verifyGrilling: async () => null,
   actions: {
    // Answers like the runner's timeout: no exit code, child still running.
    run: async () => {
     runs++;
     return { code: null, stderr: "(no exit after 120 s; still running)", exited };
    },
    rangerBin: "/bin/ranger",
    configPath: "/x/ranger.yaml",
    readPr: async () => greenPr(),
    exists: () => true,
   },
  });
  expect((await handler(post("/api/resume", ok))).status).toBe(200);
  expect((await handler(post("/api/resume", ok))).status).toBe(409);
  expect(runs).toBe(1);
  exit();
  await exited;
  await Bun.sleep(0);
  expect((await handler(post("/api/resume", ok))).status).toBe(200);
  expect(runs).toBe(2);
 });

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

 test("the page puts Needs you above Needs your decision, and says to reload on a stale token", () => {
  const page = renderPage(TOKEN);
  expect(page.indexOf("<h2>Needs you</h2>")).toBeGreaterThan(0);
  expect(page.indexOf("<h2>Needs you</h2>")).toBeLessThan(page.indexOf("<h2>Needs your decision</h2>"));
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
   substrates: { fiveHourMaxUsedPct: 70, sevenDayMaxUsedPct: 80, claudeProbeMaxAgeMin: 15, codexReadMaxAgeMin: 5 },
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
  expect(reader.detailErrors.get(`pr:${SEELITE}#687`)).toMatch(/HTTP 502/);
  expect(reader.detailErrors.get(`issue:${SEELITE}#663`)).toMatch(/could not read the issue/);
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

 test("a failed label refresh makes the labels unknown, even when an earlier read cached them", async () => {
  const config = { state: { journalPath: "/nonexistent" } } as unknown as RangerConfig;
  let fail = false;
  const reader = new ServeReader(config, [], "/nonexistent", {
   issue: async () => {
    if (fail) throw new Error("HTTP 502");
    return { title: "t", labels: [] };
   },
   pr: async () => greenPr(),
  });
  reader.wantDetails([`${SEELITE}#433`], []);
  await reader.refreshDetails(true);
  expect(reader.labels.get(`${SEELITE}#433`)).toEqual([]);
  // The label may have been added since; a failed read must not keep the old answer.
  fail = true;
  await reader.refreshDetails(true);
  expect(reader.labels.has(`${SEELITE}#433`)).toBe(false);
  expect(reader.detailErrors.get(`issue:${SEELITE}#433`)).toMatch(/HTTP 502/);
  const inputs = entryInputs({
   workers: [row({ nodeId: "433", status: "awaiting-merge", outcome: null })],
   labels: (repo, id) => reader.labels.get(`${repo}#${id}`) ?? null,
  });
  expect(needsYouEntries(inputs)).toEqual([]);
  expect(uncheckedNeedsEye(inputs)).toEqual([`${SEELITE}#433`]);
 });

 test("the refresh reads details even when the frontier read fails", async () => {
  const config = {
   auth: { readOnlyTokens: {} },
   budget: { graphqlFloor: 1000, rateLimitCooldownMin: 10 },
   bot: { identity: "bot" },
   state: { journalPath: "/nonexistent" },
  } as unknown as RangerConfig;
  const maps = [{ key: `${SEELITE}#1`, repo: SEELITE, root: 1, walk: "none" as const, lane: "headless" as const, servedOnly: true }];
  const reads: string[] = [];
  const reader = new ServeReader(config, maps, "/nonexistent", {
   issue: async (_repo, id) => {
    reads.push(id);
    return { title: "t", labels: ["ranger:needs-eye"] };
   },
   pr: async () => greenPr(),
  });
  reader.wantDetails([`${SEELITE}#433`], [`${SEELITE}#687`]);
  // Read once, so nothing is left untried: only the timer's full refresh reads again.
  await reader.refreshDetails(true);
  expect(reads).toEqual(["433"]);
  reader.refresh();
  // The in-flight full read, when the refresh started one; else an untried-only read of nothing.
  await reader.refreshDetails();
  for (let i = 0; i < 50 && reader.refreshing; i++) await new Promise((r) => setTimeout(r, 1));
  // No read-only token for the map: the frontier read is refused...
  expect(reader.lastError).toMatch(/no read-only token mapping/);
  // ...and the labels are read again all the same.
  expect(reads).toEqual(["433", "433"]);
  expect(reader.labels.get(`${SEELITE}#433`)).toEqual(["ranger:needs-eye"]);
  expect(reader.prs.has(`${SEELITE}#687`)).toBe(true);
 });

 test("details for nodes no row wants any more are dropped", async () => {
  const config = { state: { journalPath: "/nonexistent" } } as unknown as RangerConfig;
  const reader = new ServeReader(config, [], "/nonexistent", {
   issue: async (_repo, id) => (id === "2" ? null : { title: id, labels: [] }),
   pr: async () => {
    throw new Error("HTTP 502");
   },
  });
  reader.wantDetails([`${SEELITE}#1`, `${SEELITE}#2`], [`${SEELITE}#700`]);
  await reader.refreshDetails(true);
  expect(reader.labels.has(`${SEELITE}#1`)).toBe(true);
  expect(reader.detailErrors.size).toBe(2);
  reader.wantDetails([], []);
  expect(reader.labels.size).toBe(0);
  expect(reader.prs.size).toBe(0);
  expect(reader.detailErrors.size).toBe(0);
  expect(reader.hasUnreadDetails()).toBe(false);
  // Wanted again, they are read afresh rather than skipped as already tried.
  reader.wantDetails([`${SEELITE}#1`], []);
  expect(reader.hasUnreadDetails()).toBe(true);
 });
});

describe("node #54 — details read a few at a time, and an unread label never reads as nothing waiting", () => {
 test("PR reads do not wait behind a slow issue, and no more than the limit run at once", async () => {
  const config = { state: { journalPath: "/nonexistent" } } as unknown as RangerConfig;
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];
  let releaseSlow: () => void = () => {};
  const slow = new Promise<void>((resolve) => (releaseSlow = resolve));
  const track = async <T>(name: string, wait: Promise<void> | null, value: T): Promise<T> => {
   started.push(name);
   inFlight += 1;
   peak = Math.max(peak, inFlight);
   await (wait ?? Promise.resolve());
   inFlight -= 1;
   return value;
  };
  const reader = new ServeReader(config, [], "/nonexistent", {
   issue: (repo, id) => track(`issue ${id}`, id === "1" ? slow : null, { title: id, labels: [] }),
   pr: (repo, n) => track(`pr ${n}`, null, greenPr({ number: n })),
  });
  const issues = Array.from({ length: 6 }, (_, i) => `${SEELITE}#${i + 1}`);
  reader.wantDetails(issues, [`${SEELITE}#700`, `${SEELITE}#701`]);
  const done = reader.refreshDetails();
  // Let every fast read finish while issue 1 is still held.
  for (let i = 0; i < 50; i++) await Promise.resolve();
  expect(started).toContain("pr 700");
  expect(started).toContain("pr 701");
  expect(reader.prs.has(`${SEELITE}#701`)).toBe(true);
  expect(reader.labels.has(`${SEELITE}#1`)).toBe(false);
  releaseSlow();
  await done;
  expect(reader.labels.has(`${SEELITE}#1`)).toBe(true);
  expect(peak).toBeLessThanOrEqual(DETAIL_CONCURRENCY);
  expect(peak).toBeGreaterThan(1);
 });

 test("an awaiting-merge row whose labels are unknown is named, never hidden behind 'nothing waits'", () => {
  const waiting = row({ nodeId: "433", status: "awaiting-merge", outcome: null });
  const known = row({ nodeId: "434", status: "awaiting-merge", outcome: null });
  const foreign = row({ nodeId: "435", status: "awaiting-merge", root: 99 });
  const inputs = entryInputs({
   workers: [waiting, known, foreign],
   labels: (_repo, id) => (id === "434" ? [] : null),
  });
  expect(needsYouEntries(inputs)).toEqual([]);
  expect(uncheckedNeedsEye(inputs)).toEqual([`${SEELITE}#433`]);
  const state = assembleState({
   maps: [{ ...MAP, walk: "full", lane: "visual", servedOnly: false }],
   reports: new Map(),
   titles: new Map(),
   workers: [waiting],
   laneHolders: { visual: null, headless: null },
   paused: false,
   spawnsToday: 0,
   spawnCap: 10,
   vetoed: () => false,
   pidAlive: () => true,
   refreshing: false,
   refreshError: null,
   now: new Date("2026-10-04T15:00:00Z"),
   needsYouUnchecked: [{ key: `${SEELITE}#433`, error: "HTTP 502" }],
  });
  expect(state.needsYouUnchecked).toEqual([{ key: `${SEELITE}#433`, error: "HTTP 502" }]);
  const page = renderPage("token");
  expect(page).toContain("not yet checked for needs-eye");
  expect(page).toContain("if (unchecked.length === 0) box.append(empty(\"Nothing is parked");
 });
});
