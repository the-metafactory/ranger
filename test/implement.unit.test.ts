import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { processGroupCommands, runCmd } from "../src/exec.ts";
import { findClosingKeyword } from "../src/git-ops.ts";
import type { CheckRun, PullRequest } from "../src/github.ts";
import type { FrontierEntry } from "../src/graph.ts";
import {
 implementBranchFor,
 recordedReviews,
 resolvePhase,
 reviewMarker,
} from "../src/implement.ts";
import { FencedError, openJournal } from "../src/journal.ts";
import { evaluateMergeGate } from "../src/merge-gate.ts";
import { parseVerdictBlock, ReviewError } from "../src/review.ts";
import { classify } from "../src/route.ts";
import { sweepMap } from "../src/sweep.ts";
import { baseConfigLines } from "./support.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function pr(over: Partial<PullRequest> = {}): PullRequest {
 return {
  number: 7,
  state: "open",
  merged: false,
  draft: false,
  headRef: "node/20-x",
  headSha: SHA,
  baseRef: "main",
  mergeable: true,
  mergeableState: "clean",
  mergeCommitSha: null,
  url: "https://github.com/acme/widgets/pull/7",
  author: "ivy-bot",
  ...over,
 };
}

const GREEN: CheckRun[] = [{ id: 9, name: "build", status: "completed", conclusion: "success" }];

function gate(over: Partial<Parameters<typeof evaluateMergeGate>[0]> = {}) {
 return evaluateMergeGate({
  pr: pr(),
  checkRuns: GREEN,
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
  expect(gate({ pr: pr({ mergeable: null }) }).status).toBe("pending");
  expect(gate({ pr: pr({ mergeable: false, mergeableState: "dirty" }) })).toMatchObject({ status: "fail", check: "mergeable" });
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

describe("closing keywords (#588 fail-open path)", () => {
 test.each([
  "closes #12",
  "Fixes #3",
  "resolved: #9",
  "fix acme/widgets#4",
  "Closes https://github.com/acme/widgets/issues/5",
 ])("finds %p", (text) => {
  expect(findClosingKeyword(`feat: thing\n\n${text}`)).not.toBeNull();
 });
 test.each(["node #12", "fixed the flaky test", "see #12", "closer to #3 than before"])("ignores %p", (text) => {
  expect(findClosingKeyword(text)).toBeNull();
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
  expect(resolvePhase(pr({ merged: true, state: "closed" }))).toBe("close");
  expect(resolvePhase(pr({ state: "closed" }))).toBe("pr-closed");
 });
 test("a declared git-merged-into probe names the branch", () => {
  expect(implementBranchFor({ probes: [{ type: "git-merged-into", ref: "node/flight-sound-prune" }] }, "node/9-x")).toBe("node/flight-sound-prune");
  expect(implementBranchFor({ probes: [] }, "node/9-x")).toBe("node/9-x");
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
   journal.upsertWorker({ nodeId: "3", repo: "acme/widgets", status: "claimed" });
   const first = journal.beginGeneration("3");
   journal.assertGeneration("3", first, "push");
   const second = journal.beginGeneration("3");
   expect(second).toBe(first + 1);
   expect(() => journal.assertGeneration("3", first, "push")).toThrow(FencedError);
   journal.assertGeneration("3", second, "push");
   expect(() => journal.beginGeneration("missing")).toThrow(FencedError);
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
    journal.upsertWorker({
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
   expect(journal.getWorker("4")?.workerPgid).toBeNull();
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
   expect(implementLaneBusy(journal)).toBe(false);
   journal.upsertWorker({ nodeId: "1", repo: "acme/widgets", status: "awaiting-merge", lane: "implement" });
   expect(implementLaneBusy(journal)).toBe(false); // waiting on a merge does not hold the lane
   journal.upsertWorker({ nodeId: "2", repo: "acme/widgets", status: "running", lane: "research" });
   expect(implementLaneBusy(journal)).toBe(false);
   journal.upsertWorker({ nodeId: "4", repo: "acme/widgets", status: "running", lane: "implement" });
   expect(implementLaneBusy(journal)).toBe(true);
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

describe("implement lane holder", () => {
 test("names the implement worker building or under review, except the asking node", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-holder-"));
  try {
   const path = join(dir, "ranger.yaml");
   require("node:fs").writeFileSync(path, baseConfigLines(dir).join("\n"));
   const journal = openJournal(loadConfig(path).config);
   journal.upsertWorker({ nodeId: "1", repo: "acme/widgets", status: "awaiting-merge", lane: "implement" });
   journal.upsertWorker({ nodeId: "2", repo: "acme/widgets", status: "running", lane: "research" });
   expect(journal.implementLaneHolder()).toBeNull();
   journal.upsertWorker({ nodeId: "3", repo: "acme/widgets", status: "running", lane: "implement" });
   expect(journal.implementLaneHolder()?.nodeId).toBe("3");
   expect(journal.implementLaneHolder("3")).toBeNull();
   journal.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});
