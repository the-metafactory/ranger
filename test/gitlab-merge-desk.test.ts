import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.ts";
import { openJournal } from "../src/journal.ts";
import { deskPort, runMergeDesk } from "../src/merge-desk.ts";
import { realGitHub } from "../src/implement.ts";
import type { ChangeRequest, CiVerdict, ForgePort, IssueComment, MergeOutcome, MergeState, RebaseOutcome } from "../src/forge.ts";

const REPO = "gitlab:gitlab.example.test/claw/sim";
const BOT = "project_1_bot_a1b2";
const GATED = "a".repeat(40);
const REBASED = "b".repeat(40);
const GREEN: CiVerdict = { state: "green", runId: 31, runUrl: "https://gitlab.example.test/p/31", runName: "pipeline 31", snapshot: "31" };
const RUNNING: CiVerdict = { state: "pending", reason: "pipeline 32 is running" };

const review = (sha: string, round: number): IssueComment => ({
 id: 10 + round, author: BOT, body: `<!-- ranger:review round=${round} sha=${sha} blockers=0 majors=0 nits=0 -->`,
});

/** One MR's live state, which a test script advances between desk passes. */
interface Mr {
 state: ChangeRequest["state"];
 head: string;
 mergeState: MergeState;
 ci: CiVerdict;
 comments: IssueComment[];
 labels: string[];
 squash: string | null;
 rebase: RebaseOutcome;
 merge: MergeOutcome;
}

/** A GitLab port fake with only the calls the merge desk may make; anything else throws. */
function fakeGitLab(mr: Mr) {
 const calls: string[] = [];
 const merges: { n: number; sha: string; title: string }[] = [];
 const forbidden = (name: string) => async () => { throw new Error(`unexpected GitLab call: ${name}`); };
 const port: ForgePort = {
  findPrByHead: forbidden("findPrByHead"),
  createDraftPr: forbidden("createDraftPr"),
  updatePrBody: forbidden("updatePrBody"),
  markReady: forbidden("markReady"),
  postComment: forbidden("postComment"),
  getPr: async (_repo, n) => {
   calls.push("getPr");
   return {
    iid: n, state: mr.state, draft: false, title: "Merge desk on GitLab (node #96)", headRef: "node/96",
    headSha: mr.head, baseRef: "main", mergeState: mr.mergeState, webUrl: "https://gitlab.example.test/claw/sim/-/merge_requests/9",
    author: BOT, mergeCommitSha: null, mergedBy: null,
   };
  },
  listComments: async () => { calls.push("listComments"); return mr.comments; },
  ciVerdictFor: async () => { calls.push("ciVerdictFor"); return mr.ci; },
  issueLabels: async (_repo, issue) => { calls.push(`issueLabels:${issue}`); return mr.labels; },
  squashRefusal: async () => { calls.push("squashRefusal"); return mr.squash; },
  rebasePr: async () => {
   calls.push("rebasePr");
   if (mr.rebase.status === "head-moved") { mr.head = mr.rebase.headSha; mr.mergeState = "pending"; mr.ci = RUNNING; }
   return mr.rebase;
  },
  mergePr: async (_repo, n, sha, title) => {
   calls.push("mergePr");
   merges.push({ n, sha, title });
   if (mr.merge.status === "merged") mr.state = "merged";
   return mr.merge;
  },
 };
 return { port, calls, merges };
}

function needsRebase(over: Partial<Mr> = {}): Mr {
 return {
  state: "open", head: GATED, mergeState: "needs-rebase", ci: GREEN, comments: [review(GATED, 2)], labels: [],
  squash: null, rebase: { status: "head-moved", headSha: REBASED, requested: true }, merge: { status: "merged" }, ...over,
 };
}

function rig(opts: { autoMerge?: boolean } = {}) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-gitlab-desk-"));
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, stringify({
  version: 1,
  maps: [{
   repo: REPO, root: 12, walk: "full", autoMerge: opts.autoMerge ?? true,
   commands: { test: "bun test" },
   discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1234567890" },
  }],
  bot: { identity: BOT },
  state: { journalPath: join(dir, "state.sqlite") },
 }));
 const config = loadConfig(configPath).config;
 const map = config.maps[0]!;
 const journal = openJournal(config);
 journal.upsertWorker({
  root: 12, nodeId: "96", repo: map.repo, lane: "implement", status: "awaiting-merge", phase: "awaiting-merge",
  prNumber: 9, verdictSha: GATED, verdictBlockers: 0,
 });
 const posts: string[] = [];
 const spawned: string[] = [];
 const desk = (port: ForgePort) => runMergeDesk({
  config, journal, map, token: "write-token", botIdentity: BOT, github: port,
  post: async (content) => { posts.push(content); return `msg-${posts.length}`; },
  spawn: async (id) => { spawned.push(id); return 4242; },
 });
 const events = (kind: string) => journal.listNodeEvents(map.repo, "96").filter((e) => e.kind === kind);
 const row = () => journal.getWorker("96", map.repo);
 return { config, map, journal, desk, posts, spawned, events, row, close() { journal.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("node #126 — gitlab-rebase-squash-merge: the merge desk on a GitLab map", () => {
 test("scripted needs-rebase → pending → mergeable → merged: one rebase, one squash merge at the re-gated head", async () => {
  const r = rig();
  try {
   const mr = needsRebase();
   const gl = fakeGitLab(mr);

   // Pass 1: GitLab asks for a rebase. Ranger rebases and stops: head moved, nothing merged.
   expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], merged: [], parked: [], errors: [] });
   expect(gl.calls).toEqual(["getPr", "listComments", "ciVerdictFor", "issueLabels:96", "squashRefusal", "rebasePr"]);
   expect(gl.merges).toEqual([]);
   expect(r.events("rebased").map((e) => e.detail)).toEqual([expect.stringMatching(new RegExp(`^from=${GATED} to=${REBASED}`))]);
   expect(r.row()).toMatchObject({ status: "awaiting-merge" });

   // The fresh round at the rebased head (the send-back's work) lands; GitLab is still computing.
   mr.comments.push(review(REBASED, 3));
   gl.calls.length = 0;
   expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], merged: [], parked: [] });
   expect(gl.calls).not.toContain("rebasePr");
   expect(gl.calls).not.toContain("mergePr");

   // Pass 3: the new pipeline is green and the MR mergeable — squash-merge pinned to the rebased head.
   mr.ci = GREEN;
   mr.mergeState = "mergeable";
   expect(await r.desk(gl.port)).toMatchObject({ merged: ["96"], resumed: ["96"], parked: [], errors: [] });
   expect(gl.merges).toEqual([{ n: 9, sha: REBASED, title: "Merge desk on GitLab (node #96)" }]);
   expect(r.events("merged")).toHaveLength(1);
   expect(r.row()).toMatchObject({ status: "running", phase: "close" });
   expect(r.spawned).toEqual(["96"]);
  } finally { r.close(); }
 });

 test("a rebase still running after the bounded wait is pending, and never merges in the same pass", async () => {
  const r = rig();
  try {
   const mr = needsRebase({ rebase: { status: "pending", reason: "GitLab is still rebasing !9 after 2 checks", requested: true } });
   const gl = fakeGitLab(mr);
   expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], merged: [], parked: [] });
   expect(gl.calls).not.toContain("mergePr");
   // The journal says the rebase was asked for, never that the head moved.
   const [pending] = r.events("rebased").map((e) => e.detail);
   expect(pending).toMatch(new RegExp(`^from=${GATED}: ranger asked for a rebase .*the head has not moved yet \\(GitLab is still rebasing`));
   expect(pending).not.toContain("the head moved");

   // Next pass: GitLab still reports need_rebase at the same head; the port waits on the running rebase.
   mr.rebase = { status: "head-moved", headSha: REBASED, requested: false };
   gl.calls.length = 0;
   expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], merged: [], parked: [], resumed: [] });
   expect(gl.calls).toContain("rebasePr");
   expect(gl.calls).not.toContain("mergePr");
   expect(r.row()).toMatchObject({ status: "awaiting-merge" });
   expect(r.journal.listRebases(r.map.repo, "96")[0]).toEqual({ from: GATED, to: REBASED, requested: false });

   // Ranger saw that landing, so the unreviewed new head is its rebase: a fresh round, not a park.
   mr.mergeState = "mergeable";
   mr.ci = GREEN;
   expect(await r.desk(gl.port)).toMatchObject({ resumed: ["96"], parked: [] });
  } finally { r.close(); }
 });

 test("a head that moved while ranger knew its rebase only as pending is re-gated, then held at the card: never auto-merged", async () => {
  const r = rig();
  try {
   const mr = needsRebase({ rebase: { status: "pending", reason: "GitLab is still rebasing !9 after 2 checks", requested: true } });
   const gl = fakeGitLab(mr);
   expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], parked: [] });
   // Between passes the head moves, unobserved: ranger's rebase landing, or anyone's push.
   mr.head = REBASED;
   mr.mergeState = "mergeable";
   expect(await r.desk(gl.port)).toMatchObject({ resumed: ["96"], parked: [] });
   expect(r.events("sweep").map((e) => e.detail)).toContainEqual(expect.stringContaining("after ranger asked for a rebase, unseen"));

   // The fresh round passes at the moved head: the gate passes, but ranger does not merge it.
   r.journal.updateWorker("96", r.map.repo, { status: "awaiting-merge", phase: "awaiting-merge", pid: null });
   mr.comments.push(review(REBASED, 3));
   gl.calls.length = 0;
   expect(await r.desk(gl.port)).toMatchObject({ cards: ["96"], merged: [], parked: [] });
   expect(gl.calls).not.toContain("mergePr");
   expect(gl.calls).not.toContain("rebasePr");
   expect(r.posts.at(-1)).toContain(`the head moved from ${GATED.slice(0, 8)} after ranger asked for a rebase, and ranger did not see the rebase land. Confirm the moved head is ranger's rebase`);
   expect(r.posts.at(-1)).toContain("Auto-merge is held for that reason.");
  } finally { r.close(); }
 });

 test("a push past ranger's observed rebase head is not ranger's: it parks", async () => {
  const r = rig();
  try {
   const mr = needsRebase();
   const gl = fakeGitLab(mr);
   expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"] });
   mr.head = "c".repeat(40);
   mr.mergeState = "mergeable";
   mr.ci = GREEN;
   expect(await r.desk(gl.port)).toMatchObject({ parked: ["96"], resumed: [] });
   expect(r.row()?.outcome).toContain("review-clean");
  } finally { r.close(); }
 });

 test("a fault on the rebase request is an error retried next pass, never a park", async () => {
  const r = rig();
  try {
   const gl = fakeGitLab(needsRebase());
   gl.port.rebasePr = async () => { throw new Error("projects/1/merge_requests/9/rebase: rebase request failed (HTTP 502)"); };
   const result = await r.desk(gl.port);
   expect(result).toMatchObject({ parked: [], merged: [] });
   expect(result.errors).toHaveLength(1);
   expect(r.row()).toMatchObject({ status: "awaiting-merge" });
   expect(r.events("rebased")).toEqual([]);
  } finally { r.close(); }
 });

 test("waits on a running rebase do not count as requests; a rebase that never lands parks at the pass bound", async () => {
  const r = rig();
  try {
   const reason = "GitLab is still rebasing !9 after 2 checks";
   const mr = needsRebase({ rebase: { status: "pending", reason, requested: true } });
   const gl = fakeGitLab(mr);
   expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], parked: [] });
   mr.rebase = { status: "pending", reason, requested: false };
   for (let pass = 1; pass < 10; pass++) expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], parked: [] });
   expect(r.events("rebased")).toHaveLength(10);
   expect(r.events("rebased").filter((e) => e.detail?.includes("ranger waited on a running rebase of !9"))).toHaveLength(9);
   gl.calls.length = 0;
   expect(await r.desk(gl.port)).toMatchObject({ parked: ["96"], pending: [] });
   expect(gl.calls).not.toContain("rebasePr");
   expect(r.row()?.outcome).toContain(`requested a rebase of !9 from ${GATED.slice(0, 8)} 1 time(s) over 10 pass(es)`);
  } finally { r.close(); }
 });

 test("after ranger's rebase, a new head without a review is sent back for a fresh round, not parked", async () => {
  const r = rig();
  try {
   const mr = needsRebase();
   const gl = fakeGitLab(mr);
   await r.desk(gl.port);
   mr.mergeState = "mergeable";
   mr.ci = GREEN;
   gl.calls.length = 0;
   const result = await r.desk(gl.port);
   expect(result).toMatchObject({ resumed: ["96"], parked: [], merged: [] });
   expect(gl.calls).toEqual(["getPr", "listComments"]);
   expect(r.row()).toMatchObject({ status: "running", phase: "review" });
   expect(r.events("sweep").map((e) => e.detail)).toContainEqual(expect.stringContaining(`ranger rebased !9 from ${GATED.slice(0, 8)}`));
  } finally { r.close(); }
 });

 test("ranger's rebase is still recognised after many unrelated events: the row is sent back, not parked", async () => {
  const r = rig();
  try {
   const mr = needsRebase();
   const gl = fakeGitLab(mr);
   await r.desk(gl.port);
   for (let i = 0; i < 70; i++) r.journal.recordEvent("sweep", { nodeId: "96", repo: r.map.repo, detail: "waiting for the implement lane" });
   mr.mergeState = "mergeable";
   mr.ci = GREEN;
   expect(await r.desk(gl.port)).toMatchObject({ resumed: ["96"], parked: [] });
   expect(r.row()).toMatchObject({ status: "running", phase: "review" });
  } finally { r.close(); }
 });

 test("a head moved by anyone else, without a ranger rebase, still fails the gate and parks", async () => {
  const r = rig();
  try {
   const gl = fakeGitLab(needsRebase({ head: REBASED, mergeState: "mergeable" }));
   expect(await r.desk(gl.port)).toMatchObject({ parked: ["96"], resumed: [] });
   expect(r.row()?.outcome).toContain("review-clean");
  } finally { r.close(); }
 });

 test("a rebase GitLab cannot do parks with its message, and nothing merges", async () => {
  const r = rig();
  try {
   const gl = fakeGitLab(needsRebase({ rebase: { status: "not-mergeable", reason: "GitLab could not rebase !9: Rebase failed: conflict" } }));
   expect(await r.desk(gl.port)).toMatchObject({ parked: ["96"], merged: [] });
   expect(gl.merges).toEqual([]);
   expect(r.row()?.outcome).toContain("Rebase failed: conflict");
   expect(r.posts.at(-1)).toContain("**parked** #96");
  } finally { r.close(); }
 });

 for (const head of ["mergeable", "needs-rebase"] as const) {
  test(`squash_option never refuses and escalates before any write (${head})`, async () => {
   const r = rig();
   try {
    const gl = fakeGitLab(needsRebase({ mergeState: head, squash: `${REPO} has squash_option "never"` }));
    expect(await r.desk(gl.port)).toMatchObject({ parked: ["96"], merged: [], pending: [] });
    expect(gl.calls).not.toContain("rebasePr");
    expect(gl.calls).not.toContain("mergePr");
    expect(r.row()?.outcome).toContain(`squash_option "never"`);
    expect(r.posts.at(-1)).toContain("**parked** #96");
   } finally { r.close(); }
  });
 }

 test("a 409 at merge time is head moved: nothing merges, nothing parks, the new head is re-gated", async () => {
  const r = rig();
  try {
   const gl = fakeGitLab(needsRebase({ mergeState: "mergeable", merge: { status: "head-moved", reason: "!9 is no longer at aaaaaaaa (HTTP 409)" } }));
   expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], merged: [], parked: [], resumed: [] });
   expect(r.events("merged")).toEqual([]);
   expect(r.row()).toMatchObject({ status: "awaiting-merge" });
   expect(r.spawned).toEqual([]);
  } finally { r.close(); }
 });

 test("a 405/406/422 at merge time parks as not mergeable, with GitLab's message", async () => {
  const r = rig();
  try {
   const reason = "GitLab declined to merge !9: HTTP 406: Branch cannot be merged";
   const gl = fakeGitLab(needsRebase({ mergeState: "mergeable", merge: { status: "not-mergeable", reason } }));
   expect(await r.desk(gl.port)).toMatchObject({ parked: ["96"], merged: [] });
   expect(r.row()?.outcome).toBe(reason);
   expect(r.events("merged")).toEqual([]);
  } finally { r.close(); }
 });

 test("a merge GitLab did not squash is still journalled as merged and closes, and the notice escalates it", async () => {
  const r = rig();
  try {
   const gl = fakeGitLab(needsRebase({ mergeState: "mergeable", merge: { status: "merged", unsquashed: "GitLab merged !9 without squashing (squash=false)" } }));
   expect(await r.desk(gl.port)).toMatchObject({ merged: ["96"], resumed: ["96"], parked: [], errors: [] });
   const [merged] = r.events("merged").map((e) => e.detail);
   expect(merged).toContain("merged (NOT squashed) by ranger");
   expect(merged).not.toContain("squash-merged");
   expect(r.events("parked")).toEqual([]);
   expect(r.row()).toMatchObject({ status: "running", phase: "close" });
   expect(r.spawned).toEqual(["96"]);
   const notice = r.posts.at(-1)!;
   expect(notice).toContain("**merged** #96");
   expect(notice).toContain(":warning: Needs your eye: GitLab merged !9 without squashing");
   expect(notice).not.toContain("squash-merged");
  } finally { r.close(); }
 });

 test("a forge that keeps asking for a rebase at one head is asked a bounded number of times, then escalated", async () => {
  const r = rig();
  try {
   const mr = needsRebase({ rebase: { status: "pending", reason: "GitLab finished rebasing !9 but the head is still aaaaaaaa", requested: true } });
   const gl = fakeGitLab(mr);
   for (let pass = 0; pass < 3; pass++) expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], parked: [] });
   gl.calls.length = 0;
   expect(await r.desk(gl.port)).toMatchObject({ parked: ["96"], pending: [], merged: [] });
   expect(gl.calls).not.toContain("rebasePr");
   expect(gl.calls).not.toContain("mergePr");
   expect(r.events("rebased")).toHaveLength(3);
   expect(r.row()?.outcome).toContain(`requested a rebase of !9 from ${GATED.slice(0, 8)} 3 time(s) over 3 pass(es)`);
   expect(r.posts.at(-1)).toContain("**parked** #96");
  } finally { r.close(); }
 });

 test("the rebase bound counts per head: requests from an earlier head do not count against a new one", async () => {
  const r = rig();
  try {
   for (let i = 0; i < 3; i++) r.journal.recordRebase({ nodeId: "96", repo: r.map.repo, from: REBASED, to: "e".repeat(40), requested: true, note: "earlier head" });
   const gl = fakeGitLab(needsRebase());
   expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], parked: [] });
   expect(gl.calls).toContain("rebasePr");
   expect(r.journal.listRebases(r.map.repo, "96")[0]).toEqual({ from: GATED, to: REBASED, requested: true });
  } finally { r.close(); }
 });

 test("the project's squash policy is read once per desk pass, however many rows would merge", async () => {
  const r = rig();
  try {
   r.journal.upsertWorker({
    root: 12, nodeId: "97", repo: r.map.repo, lane: "implement", status: "awaiting-merge", phase: "awaiting-merge",
    prNumber: 10, verdictSha: GATED, verdictBlockers: 0,
   });
   const gl = fakeGitLab(needsRebase({ mergeState: "mergeable", squash: `${REPO} has squash_option "never"` }));
   expect(await r.desk(gl.port)).toMatchObject({ parked: ["96", "97"] });
   expect(gl.calls.filter((c) => c === "squashRefusal")).toHaveLength(1);
  } finally { r.close(); }
 });

 for (const head of ["mergeable", "needs-rebase"] as const) {
  test(`ranger:needs-eye holds the merge exactly as on GitHub: a card, no rebase, no merge (${head})`, async () => {
   const r = rig();
   try {
    const gl = fakeGitLab(needsRebase({ mergeState: head, labels: ["ranger:needs-eye"] }));
    expect(await r.desk(gl.port)).toMatchObject({ cards: ["96"], merged: [], parked: [] });
    expect(gl.calls).toContain("issueLabels:96");
    expect(gl.calls).not.toContain("rebasePr");
    expect(gl.calls).not.toContain("mergePr");
    expect(r.posts.at(-1)).toContain("Labelled `ranger:needs-eye`");
    if (head === "needs-rebase") expect(r.posts.at(-1)).toContain("rebase the MR onto `main`");
   } finally { r.close(); }
  });
 }

 test("the desk selects the GitLab port for gitlab: maps and GitHub's for bare repos", () => {
  const r = rig();
  try {
   const gitlab = deskPort(r.config, r.map);
   expect(gitlab).not.toBe(realGitHub);
   expect(gitlab.rebasePr).toBeFunction();
   expect(gitlab.squashRefusal).toBeFunction();
   expect(deskPort(r.config, { ...r.map, repo: "acme/seelite" })).toBe(realGitHub);
  } finally { r.close(); }
 });
});
