import { githubCiVerdict } from "../src/github-ci.ts";
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { processGroupCommands, runCmd } from "../src/exec.ts";
import { findClosingKeyword } from "../src/git-ops.ts";
import type { ChangeRequest } from "../src/forge.ts";
import type { CheckRun } from "../src/github.ts";
import type { FrontierEntry } from "../src/graph.ts";
import {
 implementBranchFor,
 recordedReviews,
 resolvePhase,
 reviewAtHead,
 reviewMarker,
 supersededAtHead,
 supersededNote,
} from "../src/implement.ts";
import { FencedError, openJournal } from "../src/journal.ts";
import { probeFailureSummary, probesFailedOutcome } from "../src/outcomes.ts";
import { evaluateMergeGate } from "../src/merge-gate.ts";
import { parseVerdictBlock, ReviewError } from "../src/review.ts";
import { classify } from "../src/route.ts";
import { sweepMap } from "../src/sweep.ts";
import { baseConfigLines } from "./support.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function pr(over: Partial<ChangeRequest> = {}): ChangeRequest {
 return {
  iid: 7,
  state: "open",
  draft: false,
  title: "t",
  body: "",
  mergedBy: null,
  headRef: "node/20-x",
  headSha: SHA,
  baseRef: "main",
  mergeState: "mergeable",
  mergeCommitSha: null,
  webUrl: "https://github.com/acme/widgets/pull/7",
  author: "ivy-bot",
  ...over,
 };
}

const GREEN: CheckRun[] = [{ id: 9, name: "build", status: "completed", conclusion: "success" }];

function gate(over: Partial<Parameters<typeof evaluateMergeGate>[0]> & { checkRuns?: CheckRun[] } = {}) {
 return evaluateMergeGate({
  pr: pr(),
  ci: githubCiVerdict("acme/widgets", over.checkRuns ?? GREEN),
  expectedBase: "main",
  verdictSha: SHA,
  verdictBlockers: 0,
  ...over,
 });
}

describe("merge gate (#23)", () => {
 test("passes on green CI, clean merge, base main, a clean verdict at the live head — and names the run to cite", () => {
  expect(gate()).toEqual({ status: "pass", ciCheckRunId: 9, headSha: SHA });
 });
 test("no check runs is pending, never green (no fail-open on an empty rollup)", () => {
  expect(gate({ checkRuns: [] }).status).toBe("pending");
 });
 test("a running check is pending; a failed one fails", () => {
  expect(gate({ checkRuns: [{ id: 1, name: "ci", status: "in_progress", conclusion: null }] }).status).toBe("pending");
  const failed = gate({ checkRuns: [...GREEN, { id: 2, name: "lint", status: "completed", conclusion: "failure" }] });
  expect(failed).toMatchObject({ status: "fail", check: "ci-green" });
 });
 test("only skipped/neutral runs fail: nothing for the close to cite", () => {
  expect(gate({ checkRuns: [{ id: 3, name: "x", status: "completed", conclusion: "skipped" }] })).toMatchObject({ status: "fail", check: "ci-green" });
 });
 test("mergeability: computing is pending, conflicts fail", () => {
  expect(gate({ pr: pr({ mergeState: "pending" }) }).status).toBe("pending");
  expect(gate({ pr: pr({ mergeState: "conflict" }) })).toMatchObject({ status: "fail", check: "mergeable" });
 });
 test("a conflicting PR with no check runs fails on mergeability, not pending on CI (seelite #692)", () => {
  // GitHub starts no pull_request workflow on a conflicting PR: waiting for CI would never end.
  expect(gate({ checkRuns: [], pr: pr({ mergeState: "conflict" }) })).toMatchObject({ status: "fail", check: "mergeable" });
  expect(gate({ checkRuns: [], pr: pr({ mergeState: "pending" }) }).status).toBe("pending");
 });
 test("wrong base fails", () => {
  expect(gate({ pr: pr({ baseRef: "develop" }) })).toMatchObject({ status: "fail", check: "base-branch" });
 });
 test("a push after the review (head moved off the verdict) fails", () => {
  expect(gate({ verdictSha: OTHER })).toMatchObject({ status: "fail", check: "review-clean" });
 });
 test("blockers or majors at the head fail the gate (principal, 2026-10-03)", () => {
  expect(gate({ verdictBlockers: 1 })).toMatchObject({ status: "fail", check: "review-clean" });
  expect(gate({ verdictBlockers: 0, verdictMajors: 1 })).toMatchObject({ status: "fail", check: "review-clean" });
  expect(gate({ verdictBlockers: 0, verdictMajors: 0 }).status).toBe("pass");
 });
 test("a merged or closed PR fails the open check", () => {
  expect(gate({ pr: pr({ state: "closed" }) })).toMatchObject({ status: "fail", check: "open" });
 });
});

describe("sage verdict block (sage#83 contract)", () => {
 const out = (block: object) =>
  `## Review\n\nBody text.\n\n\`\`\`json\n{"ignored": true}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\`\n`;
 test("parses the LAST json fence; the body is everything before it", () => {
  const v = parseVerdictBlock(
   out({ verdict: "approved", summary: "ok", commit_id: SHA, findings: { blockers: 0, majors: 2, nits: 1 } }),
  );
  expect(v).toMatchObject({ verdict: "approved", commitId: SHA, blockers: 0, majors: 2, nits: 1 });
  expect(v.body).toContain("Body text.");
  expect(v.body).toContain('{"ignored": true}');
 });
 test("refuses a block with no commit id or a non-count finding", () => {
  expect(() => parseVerdictBlock(out({ verdict: "approved", findings: { blockers: 0, majors: 0, nits: 0 } }))).toThrow(ReviewError);
  expect(() => parseVerdictBlock(out({ verdict: "x", commit_id: SHA, findings: { blockers: -1, majors: 0, nits: 0 } }))).toThrow(ReviewError);
  expect(() => parseVerdictBlock("no block at all")).toThrow(ReviewError);
 });
});

describe("closing keywords (#588 fail-open path, node #128 per forge)", () => {
 // [text, GitHub hit, GitLab hit]: null where the forge reads no closing reference.
 const table: [string, string | null, string | null][] = [
  ["closes #12", "closes #12", "closes #12"],
  ["Fixes #3", "Fixes #3", "Fixes #3"],
  ["resolved: #9", "resolved: #9", "resolved: #9"],
  ["fix acme/widgets#4", "fix acme/widgets#4", "fix acme/widgets#4"],
  // GitLab reads an issue URL on any host, with or without /-; refusing a foreign one costs nothing.
  ["Closes https://github.com/acme/widgets/issues/5", "Closes https://github.com/acme/widgets/issues/5", "Closes https://github.com/acme/widgets/issues/5"],
  // GitLab's grammar: every inflection, nested groups, issue and work-item URLs.
  ["Implements #12", null, "Implements #12"],
  ["closing claw/crisis-simulator#12", null, "closing claw/crisis-simulator#12"],
  [
   "Fixes: https://gitlab.software.geant.org/claw/crisis-simulator/-/issues/12",
   null,
   "Fixes: https://gitlab.software.geant.org/claw/crisis-simulator/-/issues/12",
  ],
  ["Resolving issue #7", null, "Resolving issue #7"],
  ["implementing issues group/sub/project#8", null, "implementing issues group/sub/project#8"],
  ["IMPLEMENTED https://gitlab.example.org/g/p/-/work_items/9", null, "IMPLEMENTED https://gitlab.example.org/g/p/-/work_items/9"],
  ["fixing project#10", null, "fixing project#10"],
  ["Closed #11", "Closed #11", "Closed #11"],
  // GitLab's alternative issue prefixes and its URL forms without the /- segment.
  ["Closes GL-128", null, "Closes GL-128"],
  ["Closes [issue:128]", null, "Closes [issue:128]"],
  ["fixes [issue:claw/crisis-simulator/128]", null, "fixes [issue:claw/crisis-simulator/128]"],
  [
   "Closes https://gitlab.example.org/g/p/issues/128",
   null,
   "Closes https://gitlab.example.org/g/p/issues/128",
  ],
  [
   "Resolves https://gitlab.example.org/g/p/-/issues/incident/5",
   null,
   "Resolves https://gitlab.example.org/g/p/-/issues/incident/5",
  ],
  [
   "closes https://gitlab.example.org/groups/g/-/work_items/6",
   null,
   "closes https://gitlab.example.org/groups/g/-/work_items/6",
  ],
  // Neither forge reads these.
  ["node #12", null, null],
  ["fixed the flaky test", null, null],
  ["see #12", null, null],
  ["closer to #3 than before", null, null],
  ["prefix #3", null, null],
  ["unresolved #4", null, null],
  ["Ranger closes the node after the merge", null, null],
  ["fixtures/x#12", null, null],
  ["Fixes https://gitlab.example.org/g/p/-/merge_requests/12", null, null],
  ["Implemented by ranger's implement lane in MR !12 (https://gitlab.example.org/g/p/-/merge_requests/12)", null, null],
 ];
 for (const forge of ["github", "gitlab"] as const) {
  test.each(table)(`${forge}: %p`, (text, github, gitlab) => {
   const want = forge === "github" ? github : gitlab;
   expect(findClosingKeyword(`feat: thing\n\n${text}`, forge)).toBe(want);
  });
 }
 test("ranger's own GitLab-shaped PR prose passes the GitLab guard", () => {
  const prose = [
   "Implements orienteer node gitlab:gitlab.example.org/g/p #128: Refuse closing references (node #128)",
   "Draft by ranger's implement lane for orienteer node gitlab:gitlab.example.org/g/p #128.",
   "Squash-merge keeps one commit per node. The node is not referenced with a closing keyword on purpose: the close goes through the graph's gate.",
   "Ranger closes the node after the merge, through its declared probes and this PR's CI run.",
   "Refuse closing references (node #128) (#12)",
  ].join("\n");
  expect(findClosingKeyword(prose, "gitlab")).toBeNull();
 });
});

describe("review markers (F2 resume record)", () => {
 const verdict = { verdict: "approved", summary: "", commitId: SHA, blockers: 1, majors: 2, nits: 3, body: "" };
 test("reads back the bot's markers and ignores anyone else's (no forged clean verdict)", () => {
  const forged = reviewMarker(2, { ...verdict, blockers: 0 });
  const recorded = recordedReviews(
   [
    { id: 1, author: "ivy-bot", body: `${reviewMarker(1, verdict)}\nround one text` },
    { id: 2, author: "mallory", body: forged },
   ],
   "ivy-bot",
  );
  expect(recorded).toEqual([
   { round: 1, sha: SHA, blockers: 1, majors: 2, nits: 3, body: "round one text" },
  ]);
 });
 test("phase resolves from the PR: none → implement, open → review, merged → close, closed → pr-closed", () => {
  expect(resolvePhase(null)).toBe("implement");
  expect(resolvePhase(pr())).toBe("review");
  expect(resolvePhase(pr({ state: "merged" }))).toBe("close");
  expect(resolvePhase(pr({ state: "closed" }))).toBe("pr-closed");
 });
 test("a declared git-merged-into probe names the branch", () => {
  expect(implementBranchFor({ probes: [{ type: "git-merged-into", ref: "node/flight-sound-prune" }] }, "node/9-x")).toBe("node/flight-sound-prune");
  expect(implementBranchFor({ probes: [] }, "node/9-x")).toBe("node/9-x");
 });
});

describe("node #106 — newest-same-head-review-wins: the newest review at a head is the one that stands", () => {
 const at = (round: number, sha: string, majors: number, author = "ivy-bot") => ({
  id: round,
  author,
  body: `${reviewMarker(round, { verdict: "commented", summary: "", commitId: sha, blockers: 0, majors, nits: 0, body: "" })}\nround ${round}`,
 });
 test("rounds 12 (1 major) and 13 (clean) on one head: round 13 stands, in either comment order", () => {
  for (const comments of [[at(12, SHA, 1), at(13, SHA, 0)], [at(13, SHA, 0), at(12, SHA, 1)]]) {
   expect(reviewAtHead(recordedReviews(comments, "ivy-bot"), SHA)).toMatchObject({ round: 13, majors: 0 });
  }
 });
 test("a genuine major in the newest review at the head still stands (the gate holds)", () => {
  const current = reviewAtHead(recordedReviews([at(12, SHA, 0), at(13, SHA, 1)], "ivy-bot"), SHA);
  expect(current).toMatchObject({ round: 13, majors: 1 });
 });
 test("the accepted risk: a real major the newer clean round missed no longer gates, and is named as superseded", () => {
  // The marker cannot tell an errored lens from a real finding, so a reviewer
  // that misses in round 13 a major it found in round 12 clears the head.
  // supersededNote names what was set aside, for the journal and the cards.
  const reviews = recordedReviews([at(12, SHA, 1), at(13, SHA, 0)], "ivy-bot");
  expect(reviewAtHead(reviews, SHA)).toMatchObject({ round: 13, majors: 0 });
  expect(supersededAtHead(reviews, SHA).map((r) => r.round)).toEqual([12]);
  expect(supersededNote(reviews, SHA)).toBe(
   `sage round 12 (0 blocker(s), 1 major(s)) at ${SHA.slice(0, 8)} superseded by the clean round 13 at the same head (no code change between them)`,
  );
 });
 test("nothing is named superseded when the standing round gates, no older round gated, or the major was on another head", () => {
  for (const comments of [[at(12, SHA, 1), at(13, SHA, 1)], [at(12, SHA, 0), at(13, SHA, 0)], [at(12, OTHER, 1), at(13, SHA, 0)], [at(13, SHA, 0)]]) {
   const reviews = recordedReviews(comments, "ivy-bot");
   expect(supersededAtHead(reviews, SHA)).toEqual([]);
   expect(supersededNote(reviews, SHA)).toBeNull();
  }
 });
 test("a marker quoted inside a machine-account comment's text never reads as a round", () => {
  const quoted = { id: 99, author: "ivy-bot", body: `**Sage review**\n> ${at(14, SHA, 0).body}` };
  const current = reviewAtHead(recordedReviews([at(12, SHA, 1), quoted], "ivy-bot"), SHA);
  expect(current).toMatchObject({ round: 12, majors: 1 });
 });
 test("a clean newer round posted by anyone but the machine account never clears the head", () => {
  const current = reviewAtHead(recordedReviews([at(12, SHA, 1), at(13, SHA, 0, "mallory")], "ivy-bot"), SHA);
  expect(current).toMatchObject({ round: 12, majors: 1 });
 });
 test("unsorted input: the highest round at the head stands, whatever the array order", () => {
  const reviews = [{ round: 13, sha: SHA }, { round: 11, sha: SHA }, { round: 12, sha: SHA }, { round: 14, sha: OTHER }];
  expect(reviewAtHead(reviews, SHA)).toMatchObject({ round: 13 });
  // A tied round falls to the later one in the input.
  const tied = [{ round: 5, sha: SHA, tag: "first" }, { round: 5, sha: SHA, tag: "second" }];
  expect(reviewAtHead(tied, SHA)?.tag).toBe("second");
 });
 test("selection by head is unchanged: another head's newer round never stands here", () => {
  const reviews = recordedReviews([at(1, OTHER, 1), at(2, SHA, 0), at(3, OTHER, 0)], "ivy-bot");
  expect(reviewAtHead(reviews, SHA)).toMatchObject({ round: 2 });
  expect(reviewAtHead(reviews, OTHER)).toMatchObject({ round: 3 });
  expect(reviewAtHead(reviews, "c".repeat(40))).toBeUndefined();
 });
 test("history stays intact: every round is still recorded with its own findings", () => {
  const reviews = recordedReviews([at(12, SHA, 1), at(13, SHA, 0)], "ivy-bot");
  reviewAtHead(reviews, SHA);
  expect(reviews.map((r) => [r.round, r.majors, r.body])).toEqual([[12, 1, "round 12"], [13, 0, "round 13"]]);
 });
});

function entry(node: Partial<FrontierEntry["node"]>, author = "alice", id = "5"): FrontierEntry {
 return {
  ref: { id },
  node: { id, title: "t", kind: "task", autonomy: "propose", probes: [], ...node },
  status: "open",
  assignees: [],
  blockedBy: [],
  author,
  url: `https://github.com/acme/widgets/issues/${id}`,
  typed: true,
 };
}

describe("routing — propose task/build → implement with merge ratification (#23 ruling)", () => {
 const opts = { botIdentity: "ivy-bot" };
 test("walk: full routes a propose task to the implement lane", () => {
  expect(classify(entry({}), "acme/widgets", "full", {}, opts).route).toEqual({
   route: "implement",
   walkable: true,
   ratify: "merge",
  });
 });
 test("not on walk: full, not for bot-filed nodes, not without a bot identity, not for approve — those escalate", () => {
  for (const node of [
   classify(entry({}), "acme/widgets", "research-only", {}, opts),
   classify(entry({}, "ivy-bot"), "acme/widgets", "full", {}, opts),
   classify(entry({}), "acme/widgets", "full", {}, {}),
   classify(entry({ autonomy: "approve" }), "acme/widgets", "full", {}, opts),
   classify(entry({ kind: "research" }), "acme/widgets", "full", {}, opts),
  ]) {
   expect(node.route.route).toBe("escalate-hitl");
  }
 });
 test("the allowlist keeps an off-list propose node on its HITL card and an off-list auto node unwalkable", () => {
  const allow = { ...opts, allowlist: ["9"] };
  expect(classify(entry({}), "acme/widgets", "full", {}, allow).route.route).toBe("escalate-hitl");
  expect(classify(entry({ autonomy: "auto" }), "acme/widgets", "full", {}, allow).route).toEqual({
   route: "implement",
   walkable: false,
   ratify: "auto",
  });
  expect(classify(entry({ autonomy: "auto" }, "alice", "9"), "acme/widgets", "full", {}, allow).route).toMatchObject({ walkable: true });
 });
});

describe("occupant fence + process groups (#23 F1)", () => {
 function journalIn(dir: string) {
  const path = join(dir, "ranger.yaml");
  require("node:fs").writeFileSync(path, baseConfigLines(dir).join("\n"));
  return { journal: openJournal(loadConfig(path).config), config: loadConfig(path).config };
 }

 test("a newer generation fences the older occupant", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-fence-"));
  try {
   const { journal } = journalIn(dir);
   journal.upsertWorker({ root: 1, nodeId: "3", repo: "acme/widgets", status: "claimed" });
   const first = journal.beginGeneration("3", "acme/widgets");
   journal.assertGeneration("3", "acme/widgets", first, "push");
   const second = journal.beginGeneration("3", "acme/widgets");
   expect(second).toBe(first + 1);
   expect(() => journal.assertGeneration("3", "acme/widgets", first, "push")).toThrow(FencedError);
   journal.assertGeneration("3", "acme/widgets", second, "push");
   expect(() => journal.beginGeneration("missing", "acme/widgets")).toThrow(FencedError);
   journal.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });

 test("a timeout kills the whole group, grandchildren included", async () => {
  let pgid = 0;
  const result = await runCmd("/bin/sh", ["-c", "sleep 300 & sleep 300"], {
   processGroup: true,
   timeoutMs: 300,
   onSpawn: (pid) => {
    pgid = pid;
   },
  });
  expect(result.code).not.toBe(0);
  await Bun.sleep(200);
  expect(await processGroupCommands(pgid)).toEqual([]);
 });

 test("sweep kills a dead supervisor's orphaned worker group — only when it still names the worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-orphan-"));
  const ours = join(dir, "canonical", ".worktrees", "node-4");
  const spawnGroup = (marker: string) => {
   // The marker rides as $0 and the `; :` stops sh exec-ing sleep in place,
   // so the group keeps a process whose command line names it — like a
   // worker whose prompt names its worktree.
   const child = spawn("/bin/sh", ["-c", "sleep 300; :", marker], { detached: true, stdio: "ignore" });
   child.unref();
   return child.pid as number;
  };
  const orphan = spawnGroup(ours);
  const stranger = spawnGroup(join(dir, "someone-else"));
  try {
   const { journal, config } = journalIn(dir);
   for (const [nodeId, pgid] of [["4", orphan], ["5", stranger]] as const) {
    journal.upsertWorker({ root: 1,
     nodeId,
     repo: "acme/widgets",
     status: "running",
     pid: 2_147_483_646, // the dead supervisor
     attempts: 0,
     worktree: ours,
     workerPgid: pgid,
    });
   }
   const swept = await sweepMap({
    config,
    journal,
    map: config.maps[0],
    token: "ghp_write",
    botIdentity: "ivy-bot",
   });
   expect(swept.orphansKilled).toEqual(["4"]);
   await Bun.sleep(200);
   expect(await processGroupCommands(orphan)).toEqual([]);
   expect((await processGroupCommands(stranger)).length).toBeGreaterThan(0); // not ours: left alone
   expect(journal.getWorker("4", "acme/widgets")?.workerPgid).toBeNull();
   journal.close();
  } finally {
   try {
    process.kill(-stranger, "SIGKILL");
   } catch {}
   try {
    process.kill(-orphan, "SIGKILL");
   } catch {}
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

describe("walk — implement lane selection (#23)", () => {
 test("candidates are walkable implement routes; the lane is busy only while a worker builds or reviews", async () => {
  const { implementCandidates, implementLaneBusy } = await import("../src/walk.ts");
  const nodes = [
   classify(entry({ autonomy: "auto" }, "alice", "1"), "acme/widgets", "full", {}, { botIdentity: "ivy-bot" }),
   classify(entry({}, "alice", "2"), "acme/widgets", "full", {}, { botIdentity: "ivy-bot" }),
   classify(entry({ autonomy: "approve" }, "alice", "3"), "acme/widgets", "full", {}, { botIdentity: "ivy-bot" }),
  ];
  expect(implementCandidates(nodes).map((n) => n.id)).toEqual(["1", "2"]);

  const dir = mkdtempSync(join(tmpdir(), "ranger-lane-"));
  try {
   const path = join(dir, "ranger.yaml");
   require("node:fs").writeFileSync(path, baseConfigLines(dir).join("\n"));
   const journal = openJournal(loadConfig(path).config);
   expect(implementLaneBusy(journal, "headless")).toBe(false);
   journal.upsertWorker({ root: 1, nodeId: "1", repo: "acme/widgets", status: "awaiting-merge", lane: "implement" });
   expect(implementLaneBusy(journal, "headless")).toBe(false); // waiting on a merge does not hold the lane
   journal.upsertWorker({ root: 1, nodeId: "2", repo: "acme/widgets", status: "running", lane: "research" });
   expect(implementLaneBusy(journal, "headless")).toBe(false);
   journal.upsertWorker({ root: 1, nodeId: "4", repo: "acme/widgets", status: "running", lane: "implement" });
   expect(implementLaneBusy(journal, "headless")).toBe(true);
   journal.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

describe("probe tier (#23 follow-up)", () => {
 test("the gate requires a passing probe record at the live head when the map has a probe tier", async () => {
  expect(gate({ probesRequired: true, probePassedSha: null })).toMatchObject({ status: "fail", check: "probes" });
  expect(gate({ probesRequired: true, probePassedSha: OTHER })).toMatchObject({ status: "fail", check: "probes" });
  expect(gate({ probesRequired: true, probePassedSha: SHA }).status).toBe("pass");
  expect(gate({ probesRequired: false }).status).toBe("pass");
 });
 test("templating substitutes only a numeric node id", async () => {
  const { probeCommandFor } = await import("../src/implement.ts");
  expect(probeCommandFor('npm run probe:pr -- --intent "node #{node}"', "550")).toBe('npm run probe:pr -- --intent "node #550"');
  expect(() => probeCommandFor("x {node}", '1"; rm -rf ~')).toThrow();
 });
 test("summary parsing and forged probe markers", async () => {
  const { parseProbeSummary, probeMarker, recordedProbes } = await import("../src/implement.ts");
  expect(parseProbeSummary("probe selection: semantic\nreason: x\nselected: 4\n")).toEqual({ selected: "4", mode: "semantic" });
  expect(parseProbeSummary("No browser probes selected")).toEqual({ selected: "?", mode: "unknown" });
  const pass = probeMarker({ sha: SHA, passed: true, selected: "4", mode: "semantic" });
  expect(recordedProbes([{ id: 1, author: "mallory", body: pass }, { id: 2, author: "ivy-bot", body: `${pass}\nok` }], "ivy-bot")).toEqual([
   { sha: SHA, passed: true, selected: "4", mode: "semantic" },
  ]);
 });
});

describe("sage exit codes (live finding on seelite #667)", () => {
 const fake = join(import.meta.dir, "fixtures", "bin", "fake-sage");
 const run = async (mode: string) => {
  const { sageReview } = await import("../src/review.ts");
  const saved = process.env.SAGE_FAKE_MODE;
  process.env.SAGE_FAKE_MODE = mode;
  try {
   return await sageReview("acme/widgets", 7, "ghp_readonly", { command: fake });
  } finally {
   if (saved === undefined) delete process.env.SAGE_FAKE_MODE;
   else process.env.SAGE_FAKE_MODE = saved;
  }
 };
 test("exit 1 with a changes-requested verdict block is a verdict, not a failure", async () => {
  expect(await run("changes-requested")).toMatchObject({ verdict: "changes-requested", blockers: 2 });
 });
 test("exit 0 approved parses; exit 1 without a block is a failure", async () => {
  expect(await run("approved")).toMatchObject({ verdict: "approved", blockers: 0 });
  await expect(run("crash")).rejects.toThrow(ReviewError);
 });
});

describe("worker prompts are headless-aware (found live on seelite #669)", () => {
 test("both SOPs forbid ending the turn while waiting on background work", async () => {
  const { assembleImplementPrompt, assembleResearchPrompt } = await import("../src/prompt.ts");
  const base = {
   repo: "acme/widgets",
   node: { id: "9", title: "t", body: "b", kind: "task", autonomy: "auto", url: "u" },
   map: { title: "m", body: "" },
   branch: "node/9-t",
   worktree: "/w",
   botIdentity: "ivy-bot",
  };
  for (const prompt of [assembleResearchPrompt(base), assembleImplementPrompt({ ...base, testCommand: "bun test" })]) {
   expect(prompt).toContain("HEADLESS session");
   expect(prompt).toContain("Never start work in the background and end your turn waiting for it");
  }
 });
});

describe("the implement prompt leaves the full probe suite to the supervisor (found live on seelite #661)", () => {
 const base = {
  repo: "acme/widgets",
  node: { id: "9", title: "t", body: "b", kind: "task", autonomy: "auto", url: "u" },
  map: { title: "m", body: "" },
  branch: "node/9-t",
  worktree: "/w",
  botIdentity: "ivy-bot",
  testCommand: "bun test",
 };
 test("a map with a probe tier tells the worker not to run the full suite", async () => {
  const { assembleImplementPrompt } = await import("../src/prompt.ts");
  const prompt = assembleImplementPrompt({ ...base, probeTier: true });
  expect(prompt).toContain("Do NOT run the full probe suite");
  expect(prompt).toContain("the supervisor runs it once on the final reviewed head");
 });
 test("a map without a probe tier says nothing about probes", async () => {
  const { assembleImplementPrompt } = await import("../src/prompt.ts");
  expect(assembleImplementPrompt(base)).not.toContain("probe suite");
 });
});

describe("implement lane holder", () => {
 test("names the implement worker building or under review, except the asking node", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-holder-"));
  try {
   const path = join(dir, "ranger.yaml");
   require("node:fs").writeFileSync(path, baseConfigLines(dir).join("\n"));
   const journal = openJournal(loadConfig(path).config);
   journal.upsertWorker({ root: 1, nodeId: "1", repo: "acme/widgets", status: "awaiting-merge", lane: "implement" });
   journal.upsertWorker({ root: 1, nodeId: "2", repo: "acme/widgets", status: "running", lane: "research" });
   expect(journal.laneHolder("headless")).toBeNull();
   journal.upsertWorker({ root: 1, nodeId: "3", repo: "acme/widgets", status: "running", lane: "implement" });
   expect(journal.laneHolder("headless")?.nodeId).toBe("3");
   expect(journal.laneHolder("headless", { nodeId: "3", repo: "acme/widgets" })).toBeNull();
   journal.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

describe("skip list", () => {
 test("a skipped node is never walkable: an auto task stays unwalkable, a propose task keeps its HITL card", () => {
  const opts = { botIdentity: "ivy-bot", skip: ["5"] };
  expect(classify(entry({ autonomy: "auto" }), "acme/widgets", "full", {}, opts).route).toEqual({
   route: "implement",
   walkable: false,
   ratify: "auto",
  });
  expect(classify(entry({}), "acme/widgets", "full", {}, opts).route.route).toBe("escalate-hitl");
  expect(classify(entry({}, "alice", "6"), "acme/widgets", "full", {}, opts).route).toMatchObject({ walkable: true, ratify: "merge" });
 });
});

describe("failing probes lead the summary (node #107)", () => {
 test("each failed probe is named with its kind and failed checks", () => {
  const stdout = [
   "probe selection: semantic",
   "selected: 2",
   "FAIL probe-hud.mjs (0.1s) exit=1 assert peak load 1.0",
   "     │   ok   the hud mounts",
   '     │  FAIL  the hud draws — {"drawn":false}',
   "FAIL probe-weapon.mjs (0.1s) exit=1 crash peak load 1.0",
   "FAILED: probe-hud.mjs · probe-weapon.mjs",
  ].join("\n");
  expect(probeFailureSummary(stdout, 1)).toEqual(["probe-hud.mjs (assert): the hud draws", "probe-weapon.mjs (crash)"]);
 });

 test("a probe named only on the FAILED line has no kind to report", () => {
  expect(probeFailureSummary("FAILED: probe-hud.mjs\n", 1)).toEqual(["probe-hud.mjs (kind not printed)"]);
 });

 test("a run that names nothing says the names are unavailable rather than guessing", () => {
  expect(probeFailureSummary("selected: 2\n12 assertions, 1 failed\n", 1)).toEqual([
   "names unavailable: the run (exit 1) printed no failing probe names ranger reads",
  ]);
 });

 test("a run killed before it named failures lists the selected probes it had not passed", () => {
  const stdout = "selected: 2\n  probe-a.mjs\n  probe-b.mjs\nok   probe-a.mjs (1.0s)\n";
  expect(probeFailureSummary(stdout, -9)).toEqual(["stopped (exit -9) before passing probe-b.mjs"]);
 });

 test("a passing run has nothing to summarise", () => {
  expect(probeFailureSummary("FAIL probe-hud.mjs (0.1s) exit=1 assert\n", 0)).toEqual([]);
 });

 test("the park keeps its FAILED line and puts the kinds on their own line, after the merge-base line and ahead of the tail", () => {
  const outcome = probesFailedOutcome({
   sha: SHA,
   pr: 3,
   exit: 1,
   failed: ["probe-hud.mjs"],
   summary: ["probe-hud.mjs (assert): the hud draws"],
   tail: "ok   probe-filler.mjs (0.1s)",
  });
  expect(outcome.split("\n")).toEqual([
   "browser probes failed twice at aaaaaaaa on PR #3 (exit 1)",
   "FAILED: probe-hud.mjs",
   "failing: probe-hud.mjs (assert): the hud draws",
   "ok   probe-filler.mjs (0.1s)",
  ]);
 });

 test("a long summary cannot push the merge-base line out of the 400 characters the row keeps", () => {
  const outcome = probesFailedOutcome({
   sha: SHA,
   pr: 3,
   exit: 1,
   failed: ["probe-hud.mjs", "probe-weapon.mjs"],
   redOnBase: ["probe-weapon.mjs"],
   summary: [`probe-hud.mjs (assert): ${"a long check name ".repeat(20)}`, `probe-weapon.mjs (assert): ${"another ".repeat(30)}`],
   tail: "x".repeat(600),
  }).slice(0, 400);
  expect(outcome).toContain("red on the merge base too: probe-weapon.mjs\nfailing: probe-hud.mjs (assert): a long check name");
 });
});
