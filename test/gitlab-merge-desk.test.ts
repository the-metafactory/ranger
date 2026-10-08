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
  squash: null, rebase: { status: "head-moved", headSha: REBASED }, merge: { status: "merged" }, ...over,
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
   const mr = needsRebase({ rebase: { status: "pending", reason: "GitLab is still rebasing !9 after 10 checks" } });
   const gl = fakeGitLab(mr);
   expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], merged: [], parked: [] });
   expect(gl.calls).not.toContain("mergePr");
   expect(r.events("rebased").map((e) => e.detail)).toEqual([expect.stringMatching(new RegExp(`^from=${GATED} \\(GitLab is still rebasing`))]);

   // Next pass: GitLab still reports need_rebase at the same head; the port waits on the running rebase.
   mr.rebase = { status: "head-moved", headSha: REBASED };
   gl.calls.length = 0;
   expect(await r.desk(gl.port)).toMatchObject({ pending: ["96"], merged: [], parked: [], resumed: [] });
   expect(gl.calls).toContain("rebasePr");
   expect(gl.calls).not.toContain("mergePr");
   expect(r.row()).toMatchObject({ status: "awaiting-merge" });
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
   expect(r.events("sweep").map((e) => e.detail)).toContainEqual(expect.stringContaining(`ranger rebased PR #9 from ${GATED.slice(0, 8)}`));
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

 test("a merge GitLab did not squash is escalated with a park card, not announced as merged", async () => {
  const r = rig();
  try {
   const gl = fakeGitLab(needsRebase({ mergeState: "mergeable", merge: { status: "refused", reason: "GitLab merged !9 without squashing" } }));
   expect(await r.desk(gl.port)).toMatchObject({ parked: ["96"], merged: [] });
   expect(r.posts.at(-1)).toContain("without squashing");
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
