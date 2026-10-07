import { githubCiVerdict } from "../src/github-ci.ts";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.ts";
import { openJournal } from "../src/journal.ts";
import { mergeGateNow, runMergeDesk } from "../src/merge-desk.ts";
import { probeMarker, type ForgePort } from "../src/implement.ts";
import type { IssueComment, ChangeRequest } from "../src/forge.ts";
import type { CheckRun } from "../src/github.ts";
import { mergeGateFailedOutcome, reviewCapOutcome } from "../src/outcomes.ts";

const GAME = "acme/seelite";
const BOT = "ivy-bot";
const CERTIFIED = "a".repeat(40);
const MOVED = "b".repeat(40);
const CI_PARK = mergeGateFailedOutcome({ check: "ci-green", reason: "CI failed: deploy=cancelled" });

const review = (sha: string, blockers = 0, majors = 0, round = 3): IssueComment => ({
 id: 10 + round, author: BOT, body: `<!-- ranger:review round=${round} sha=${sha} blockers=${blockers} majors=${majors} nits=0 -->`,
});
const probes = (sha: string): IssueComment => ({
 id: 2, author: BOT, body: probeMarker({ sha, passed: true, selected: "2", mode: "semantic" }),
});

/** A forge with only the calls the merge desk may make; anything else throws. */
function fakeGitHub(opts: { head?: string; comments: IssueComment[]; ci: CheckRun[]; labels?: string[]; merged?: boolean; onGetPr?: () => void }) {
 const calls: string[] = [];
 const merges: { n: number; sha: string }[] = [];
 const forbidden = (name: string) => async () => { throw new Error(`unexpected GitHub call: ${name}`); };
 const github: ForgePort = {
  findPrByHead: forbidden("findPrByHead"),
  createDraftPr: forbidden("createDraftPr"),
  updatePrBody: forbidden("updatePrBody"),
  markReady: forbidden("markReady"),
  postComment: forbidden("postComment"),
  getPr: async (_repo, number) => {
   calls.push("getPr");
   opts.onGetPr?.();
   return {
    iid: number, state: opts.merged ? "merged" : "open", draft: false, title: "Repair the deploy step (node #96)",
    headRef: "node/96", headSha: opts.head ?? CERTIFIED, baseRef: "main",
    mergeState: "mergeable", mergeCommitSha: null, mergedBy: null, webUrl: "", author: BOT,
   } satisfies ChangeRequest;
  },
  listComments: async () => { calls.push("listComments"); return opts.comments; },
  ciVerdictFor: async () => { calls.push("ciVerdictFor"); return githubCiVerdict(opts.ci); },
  issueLabels: async () => { calls.push("issueLabels"); return opts.labels ?? []; },
  mergePr: async (_repo, n, sha) => { calls.push("mergePr"); merges.push({ n, sha }); },
 };
 return { github, calls, merges };
}

const GREEN: CheckRun[] = [{ id: 7, name: "deploy", status: "completed", conclusion: "success" } as CheckRun];

function rig(map: { autoMerge?: boolean; probe?: boolean } = {}) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-merge-desk-"));
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, stringify({
  version: 1,
  maps: [{
   repo: GAME, root: 460, walk: "full", autoMerge: map.autoMerge ?? true,
   commands: { test: "bun test", ...(map.probe === true ? { probe: "npm run probe:gpu" } : {}) },
   discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1234567890" },
  }],
  bot: { identity: BOT },
  auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST" },
  state: { journalPath: join(dir, "state.sqlite") },
 }));
 const config = loadConfig(configPath).config;
 const journal = openJournal(config);
 journal.upsertWorker({
  root: 460, nodeId: "96", repo: GAME, lane: "implement", status: "parked", phase: "awaiting-merge",
  prNumber: 709, verdictSha: CERTIFIED, verdictBlockers: 0, outcome: CI_PARK,
 });
 const posts: string[] = [];
 const spawned: string[] = [];
 const desk = (github: ForgePort) => runMergeDesk({
  config, journal, map: config.maps[0], token: "unused", botIdentity: BOT, github,
  post: async (content) => { posts.push(content); return `msg-${posts.length}`; },
  spawn: async (id) => { spawned.push(id); return 4242; },
 });
 const events = (kind: string) => journal.listNodeEvents(GAME, "96").filter((e) => e.kind === kind);
 return { config, journal, desk, posts, spawned, events, close() { journal.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("node #104 — ci-only-park-merges-without-lane: a CI-only park merges once CI recovers at the certified head", () => {
 for (const laneHeld of [false, true]) {
  test(`green exact-head CI merges and resumes the close, no worker session (lane held=${laneHeld})`, async () => {
   const r = rig({ probe: true });
   try {
    if (laneHeld) r.journal.upsertWorker({ root: 460, nodeId: "64", repo: GAME, lane: "implement", status: "running", phase: "review" });
    const before = r.journal.spawnsToday();
    const gh = fakeGitHub({ comments: [review(CERTIFIED), probes(CERTIFIED)], ci: GREEN });
    const result = await r.desk(gh.github);
    expect(result).toMatchObject({ merged: ["96"], resumed: ["96"], parked: [], errors: [] });
    expect(gh.merges).toEqual([{ n: 709, sha: CERTIFIED }]);
    expect(r.spawned).toEqual(["96"]);
    expect(r.journal.getWorker("96", GAME)).toMatchObject({ status: "running", phase: "close", outcome: null, finishedAt: null });
    expect(r.journal.spawnsToday()).toBe(before);
    if (laneHeld) expect(r.journal.getWorker("64", GAME)?.status).toBe("running");
    expect(r.events("sweep").map((e) => e.detail)).toContainEqual(expect.stringContaining("CI-only park returns to awaiting-merge"));
   } finally { r.close(); }
  });
 }

 test("on a manual map the recovered row returns to awaiting-merge and gets its merge card", async () => {
  const r = rig({ autoMerge: false });
  try {
   const gh = fakeGitHub({ comments: [review(CERTIFIED)], ci: GREEN });
   const result = await r.desk(gh.github);
   expect(result).toMatchObject({ cards: ["96"], merged: [], parked: [] });
   expect(gh.merges).toEqual([]);
   expect(r.spawned).toEqual([]);
   expect(r.journal.getWorker("96", GAME)).toMatchObject({ status: "awaiting-merge", mergeMessageId: "msg-1" });
  } finally { r.close(); }
 });

 const stays: [string, Parameters<typeof fakeGitHub>[0], Parameters<typeof rig>[0]?][] = [
  ["the head moved since certification", { head: MOVED, comments: [review(CERTIFIED)], ci: GREEN }],
  ["CI cancelled again", { comments: [review(CERTIFIED)], ci: [{ id: 8, name: "deploy", status: "completed", conclusion: "cancelled" } as CheckRun] }],
  ["CI failing", { comments: [review(CERTIFIED)], ci: [{ id: 9, name: "build", status: "completed", conclusion: "failure" } as CheckRun] }],
  ["CI rerun still running", { comments: [review(CERTIFIED)], ci: [{ id: 10, name: "deploy", status: "in_progress", conclusion: null } as CheckRun] }],
  ["the node is labelled ranger:needs-eye", { comments: [review(CERTIFIED)], ci: GREEN, labels: ["ranger:needs-eye"] }],
  ["the node is labelled ranger:needs-eye on a manual map", { comments: [review(CERTIFIED)], ci: GREEN, labels: ["ranger:needs-eye"] }, { autoMerge: false }],
  ["no review recorded at the head", { comments: [], ci: GREEN }],
  ["the review at the head still has a major", { comments: [review(CERTIFIED, 0, 1)], ci: GREEN }],
  ["no probe certification at the head", { comments: [review(CERTIFIED)], ci: GREEN }, { probe: true }],
 ];
 for (const [why, forge, map] of stays) {
  test(`stays parked, quietly, when ${why}`, async () => {
   const r = rig(map);
   try {
    const gh = fakeGitHub(forge);
    const result = await r.desk(gh.github);
    expect(result).toMatchObject({ cards: [], merged: [], resumed: [], parked: [], pending: [], errors: [] });
    expect(gh.merges).toEqual([]);
    expect(r.spawned).toEqual([]);
    expect(r.posts).toEqual([]);
    expect(r.journal.getWorker("96", GAME)).toMatchObject({ status: "parked", outcome: CI_PARK });
    expect(r.journal.spawnsToday()).toBe(0);
    expect(r.events("parked")).toEqual([]);
    expect(r.events("sweep")).toEqual([]);
   } finally { r.close(); }
  });
 }

 for (const autoMerge of [true, false]) test(`a failed label read leaves the row parked and reports the error (autoMerge=${autoMerge})`, async () => {
  const r = rig({ autoMerge });
  try {
   const gh = fakeGitHub({ comments: [review(CERTIFIED)], ci: GREEN });
   gh.github.issueLabels = async () => { throw new Error("502 from GitHub"); };
   const result = await r.desk(gh.github);
   expect(result.errors).toEqual(["#96: 502 from GitHub"]);
   expect(gh.merges).toEqual([]);
   expect(r.journal.getWorker("96", GAME)?.status).toBe("parked");
  } finally { r.close(); }
 });

 const otherParks = [
  reviewCapOutcome({ blockers: 1, majors: 0, round: 7, pr: 709 }),
  mergeGateFailedOutcome({ check: "probes", reason: "no passing probe run recorded at head aaaaaaaa" }),
  mergeGateFailedOutcome({ check: "review-clean", reason: "no sage verdict recorded for head aaaaaaaa" }),
  mergeGateFailedOutcome({ check: "mergeable", reason: "mergeable=false, state=dirty (conflicts with main)" }),
 ];
 for (const outcome of otherParks) {
  test(`a park for any other reason is untouched: ${outcome.slice(0, 40)}…`, async () => {
   const r = rig();
   try {
    r.journal.updateWorker("96", GAME, { outcome });
    const gh = fakeGitHub({ comments: [review(CERTIFIED)], ci: GREEN });
    const result = await r.desk(gh.github);
    expect(result).toMatchObject({ cards: [], merged: [], resumed: [], parked: [], pending: [], errors: [] });
    expect(gh.calls).toEqual(["getPr"]);
    expect(r.journal.getWorker("96", GAME)).toMatchObject({ status: "parked", outcome });
   } finally { r.close(); }
  });
 }

 test("a CI park outside the awaiting-merge phase is untouched", async () => {
  const r = rig();
  try {
   r.journal.updateWorker("96", GAME, { phase: "review" });
   const gh = fakeGitHub({ comments: [review(CERTIFIED)], ci: GREEN });
   await r.desk(gh.github);
   expect(gh.calls).toEqual(["getPr"]);
   expect(r.journal.getWorker("96", GAME)?.status).toBe("parked");
  } finally { r.close(); }
 });

 test("an awaiting-merge row whose CI fails still parks with the CI outcome", async () => {
  const r = rig();
  try {
   r.journal.updateWorker("96", GAME, { status: "awaiting-merge", outcome: null });
   const gh = fakeGitHub({ comments: [review(CERTIFIED)], ci: [{ id: 8, name: "deploy", status: "completed", conclusion: "cancelled" } as CheckRun] });
   const result = await r.desk(gh.github);
   expect(result.parked).toEqual(["96"]);
   expect(r.journal.getWorker("96", GAME)).toMatchObject({ status: "parked", outcome: CI_PARK });
  } finally { r.close(); }
 });
});

describe("node #106 — newest-same-head-review-wins: the desk reads the newest review at the head", () => {
 const SET_ASIDE = `sage round 12 (0 blocker(s), 1 major(s)) at ${CERTIFIED.slice(0, 8)} superseded by the clean round 13 at the same head (no code change between them)`;
 test("a CI-only park whose round 12 had a major and round 13 is clean goes ready on round 13, auto-merge held for the principal", async () => {
  const r = rig();
  try {
   const gh = fakeGitHub({ comments: [review(CERTIFIED, 0, 1, 12), review(CERTIFIED, 0, 0, 13)], ci: GREEN });
   const result = await r.desk(gh.github);
   expect(result).toMatchObject({ cards: ["96"], merged: [], parked: [], errors: [] });
   expect(gh.merges).toEqual([]);
   expect(r.spawned).toEqual([]);
   expect(r.journal.getWorker("96", GAME)?.status).toBe("awaiting-merge");
   // The set-aside major is named on the card, before any merge.
   expect(r.posts).toHaveLength(1);
   expect(r.posts[0]).toContain(`Note: ${SET_ASIDE}; the reviewer may have missed it, check before you merge. Auto-merge is held on this head for that reason.`);
   expect(r.posts[0]).toContain("it does not merge this one itself");
   expect(r.events("merge-card").map((e) => e.detail)).toContainEqual(expect.stringContaining(SET_ASIDE));
   expect(r.events("merged")).toEqual([]);
  } finally { r.close(); }
 });

 test("on a manual map the merge card names the major the clean round set aside", async () => {
  const r = rig({ autoMerge: false });
  try {
   const gh = fakeGitHub({ comments: [review(CERTIFIED, 0, 1, 12), review(CERTIFIED, 0, 0, 13)], ci: GREEN });
   const result = await r.desk(gh.github);
   expect(result).toMatchObject({ cards: ["96"], merged: [] });
   expect(r.posts).toHaveLength(1);
   expect(r.posts[0]).toContain(`Note: ${SET_ASIDE}; the reviewer may have missed it, check before you merge.`);
   expect(r.posts[0]).not.toContain("Auto-merge is held");
   expect(r.posts[0]).toContain("it never merges itself");
   expect(r.events("merge-card").map((e) => e.detail)).toContainEqual(expect.stringContaining(SET_ASIDE));
  } finally { r.close(); }
 });

 test("a merge on a single clean round carries no superseded note", async () => {
  const r = rig();
  try {
   const gh = fakeGitHub({ comments: [review(CERTIFIED, 0, 0, 13)], ci: GREEN });
   expect((await r.desk(gh.github)).merged).toEqual(["96"]);
   expect(r.posts.join("\n")).not.toContain("superseded");
   expect(r.events("merged").map((e) => e.detail).join("\n")).not.toContain("superseded");
  } finally { r.close(); }
 });

 test("a CI-only park whose newest round at the head has a major stays parked", async () => {
  const r = rig();
  try {
   const gh = fakeGitHub({ comments: [review(CERTIFIED, 0, 0, 12), review(CERTIFIED, 0, 1, 13)], ci: GREEN });
   const result = await r.desk(gh.github);
   expect(result).toMatchObject({ cards: [], merged: [], resumed: [], parked: [] });
   expect(gh.merges).toEqual([]);
   expect(r.spawned).toEqual([]);
   expect(r.journal.getWorker("96", GAME)?.status).toBe("parked");
  } finally { r.close(); }
 });

 for (const [why, newestMajors, sentBack] of [
  ["is not sent back when round 13 cleared round 12's major (a card, auto-merge held)", 0, false],
  ["is still sent back when round 13 has a major", 1, true],
 ] as const) {
  test(`an awaiting-merge row ${why}`, async () => {
   const r = rig();
   try {
    r.journal.updateWorker("96", GAME, { status: "awaiting-merge", outcome: null });
    const gh = fakeGitHub({ comments: [review(CERTIFIED, 0, 1 - newestMajors, 12), review(CERTIFIED, 0, newestMajors, 13)], ci: GREEN });
    const result = await r.desk(gh.github);
    // A send-back spawns the rework run; a set-aside major holds the merge
    // for the principal's card, with no run spawned.
    expect(result.merged).toEqual([]);
    expect(gh.merges).toEqual([]);
    expect(result.cards).toEqual(sentBack ? [] : ["96"]);
    expect(r.spawned).toEqual(sentBack ? ["96"] : []);
    expect(r.journal.getWorker("96", GAME)?.status).toBe(sentBack ? "running" : "awaiting-merge");
    if (sentBack) expect(r.journal.getWorker("96", GAME)?.phase).toBe("review");
   } finally { r.close(); }
  });
 }
});

describe("one merge, one close: two desk passes on the same merged PR", () => {
 test("a merged PR spawns its close", async () => {
  const r = rig();
  try {
   r.journal.updateWorker("96", GAME, { status: "awaiting-merge", outcome: null });
   const gh = fakeGitHub({ comments: [], ci: GREEN, merged: true });
   await r.desk(gh.github);
   expect(r.spawned).toEqual(["96"]);
   expect(r.journal.getWorker("96", GAME)).toMatchObject({ status: "running", phase: "close" });
  } finally { r.close(); }
 });

 test("a close another pass started while this one read the PR is not spawned again", async () => {
  const r = rig();
  try {
   r.journal.updateWorker("96", GAME, { status: "awaiting-merge", outcome: null });
   // The other pass (the tick's, or the dashboard's merge-desk) wins the race.
   const gh = fakeGitHub({
    comments: [], ci: GREEN, merged: true,
    onGetPr: () => r.journal.updateWorker("96", GAME, { status: "running", phase: "close", pid: 999 }),
   });
   const result = await r.desk(gh.github);
   expect(r.spawned).toEqual([]);
   expect(result.errors).toEqual([]);
   expect(r.journal.getWorker("96", GAME)).toMatchObject({ status: "running", phase: "close", pid: 999 });
  } finally { r.close(); }
 });
});

describe("mergeGateNow — the desk's gate, for a dashboard merge", () => {
 test("unknown merge state parks an auto-merge row without merging", async () => {
  const r = rig();
  try {
   r.journal.updateWorker("96", GAME, { status: "awaiting-merge", outcome: null });
   const gh = fakeGitHub({ comments: [review(CERTIFIED)], ci: GREEN });
   const getPr = gh.github.getPr;
   gh.github.getPr = async (...args) => ({ ...await getPr(...args), mergeState: "unknown" });
   expect(await r.desk(gh.github)).toMatchObject({ parked: ["96"], merged: [], errors: [] });
   expect(gh.merges).toEqual([]);
   expect(r.spawned).toEqual([]);
   expect(r.journal.getWorker("96", GAME)?.outcome).toContain("merge state is unknown");
  } finally { r.close(); }
 });

 test("passes at the head with a clean review, a passing probe run and green CI", async () => {
  const r = rig({ probe: true });
  try {
   const gh = fakeGitHub({ comments: [review(CERTIFIED), probes(CERTIFIED)], ci: GREEN });
   expect(await mergeGateNow(gh.github, r.config.maps[0], 709, "t", BOT)).toMatchObject({ status: "pass", headSha: CERTIFIED });
   expect(gh.merges).toEqual([]);
  } finally { r.close(); }
 });

 for (const [why, comments, check] of [
  ["a major at the head", [review(CERTIFIED, 0, 1), probes(CERTIFIED)], "review-clean"],
  ["the review read an earlier head", [review(MOVED), probes(CERTIFIED)], "review-clean"],
  ["no passing probe run at the head", [review(CERTIFIED)], "probes"],
 ] as const) {
  test(`holds it: ${why}`, async () => {
   const r = rig({ probe: true });
   try {
    const gh = fakeGitHub({ comments: [...comments], ci: GREEN });
    expect(await mergeGateNow(gh.github, r.config.maps[0], 709, "t", BOT)).toMatchObject({ status: "fail", check });
   } finally { r.close(); }
  });
 }
});
