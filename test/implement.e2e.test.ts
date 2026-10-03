import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
 copyFileSync,
 existsSync,
 mkdirSync,
 mkdtempSync,
 readFileSync,
 realpathSync,
 rmSync,
 writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { runCmd } from "../src/exec.ts";
import type { CheckRun, IssueComment, PullRequest } from "../src/github.ts";
import type { GitHubPort } from "../src/implement.ts";
import { openJournal, type Journal } from "../src/journal.ts";
import type { ReviewVerdict } from "../src/review.ts";
import { sweepMap } from "../src/sweep.ts";
import { runNode, type RunNodeContext } from "../src/worker.ts";
import { baseConfigLines, createCanonicalRepo, GIT_ENV } from "./support.ts";

const fixturesBin = join(import.meta.dir, "fixtures", "bin");
const dataDir = join(import.meta.dir, "fixtures", "data");
const implementWorker = join(fixturesBin, "implement-worker");
const BOT = "ivy-bot";
const DEAD_PID = 2_147_483_646;

/** In-memory forge over the real bare origin: a PR's head is the origin branch's tip. */
class FakeGitHub implements GitHubPort {
 prs = new Map<
  number,
  {
   head: string;
   base: string;
   title: string;
   body: string;
   draft: boolean;
   state: "open" | "closed";
   merged: boolean;
   mergedSha: string | null;
  }
 >();
 comments = new Map<number, IssueComment[]>();
 checkRuns: CheckRun[] = [
  { id: 101, name: "build", status: "completed", conclusion: "success" },
 ];
 private next = 1;

 constructor(private readonly origin: string) {}

 async sha(branch: string): Promise<string> {
  const r = await runCmd("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
   cwd: this.origin,
  });
  return r.code === 0 ? r.stdout.trim() : "";
 }

 private async view(n: number): Promise<PullRequest> {
  const pr = this.prs.get(n);
  if (pr === undefined) throw new Error(`no PR #${n}`);
  return {
   number: n,
   state: pr.state,
   merged: pr.merged,
   draft: pr.draft,
   headRef: pr.head,
   headSha: pr.mergedSha ?? (await this.sha(pr.head)),
   baseRef: pr.base,
   mergeable: true,
   mergeableState: "clean",
   mergeCommitSha: pr.mergedSha,
   url: `https://github.com/acme/widgets/pull/${n}`,
   author: BOT,
  };
 }

 async findPrByHead(_repo: string, branch: string) {
  for (const [n, pr] of this.prs) if (pr.head === branch) return this.view(n);
  return null;
 }
 async getPr(_repo: string, n: number) {
  return this.view(n);
 }
 async createDraftPr(
  _repo: string,
  pr: { head: string; base: string; title: string; body: string },
 ) {
  const n = this.next++;
  this.prs.set(n, { ...pr, draft: true, state: "open", merged: false, mergedSha: null });
  return this.view(n);
 }
 async updatePrBody(_repo: string, n: number, body: string) {
  const pr = this.prs.get(n);
  if (pr) pr.body = body;
 }
 async markReady(_repo: string, pr: PullRequest) {
  const stored = this.prs.get(pr.number);
  if (stored) stored.draft = false;
 }
 async checkRunsFor() {
  return this.checkRuns;
 }
 async postComment(_repo: string, n: number, body: string) {
  const list = this.comments.get(n) ?? [];
  list.push({ id: list.length + 1, author: BOT, body });
  this.comments.set(n, list);
  return list.length;
 }
 async listComments(_repo: string, n: number) {
  return this.comments.get(n) ?? [];
 }

 /** The principal's merge: fast-forward origin main to the PR head. */
 async merge(n: number): Promise<string> {
  const pr = this.prs.get(n);
  if (pr === undefined) throw new Error(`no PR #${n}`);
  const head = await this.sha(pr.head);
  await runCmd("git", ["update-ref", "refs/heads/main", head], { cwd: this.origin });
  pr.merged = true;
  pr.state = "closed";
  pr.mergedSha = head;
  return head;
 }
}

/** A scripted sage: blockers per round; the commit id is the PR's live head. */
function scriptedReviewer(github: FakeGitHub, blockers: number[], onReview?: (round: number) => void) {
 const calls: number[] = [];
 const reviewer = async (_repo: string, pr: number): Promise<ReviewVerdict> => {
  const round = calls.length + 1;
  calls.push(pr);
  onReview?.(round);
  const head = (await github.getPr("acme/widgets", pr)).headSha;
  const b = blockers[Math.min(round - 1, blockers.length - 1)];
  return {
   verdict: b > 0 ? "changes-requested" : "approved",
   summary: `round ${round}`,
   commitId: head,
   blockers: b,
   majors: 1,
   nits: 2,
   body: `## Sage\n\nRound ${round}: ${b} blocker(s).`,
  };
 };
 return { reviewer, calls };
}

interface Rig {
 dir: string;
 origin: string;
 canonical: string;
 journal: Journal;
 statePath: string;
 ctx: RunNodeContext;
 github: FakeGitHub;
}

const savedEnv = { ...process.env };

async function rig(opts: {
 nodeId?: string;
 autonomy?: "auto" | "propose";
 author?: string;
 blockers?: number[];
 onReview?: (round: number) => void;
}): Promise<Rig & { calls: number[] }> {
 const nodeId = opts.nodeId ?? "20";
 const dir = mkdtempSync(join(tmpdir(), "ranger-implement-"));
 const { origin, canonical } = await createCanonicalRepo(dir);

 const data = join(dir, "data");
 mkdirSync(data);
 copyFileSync(join(dataDir, "acme__widgets-node-1.json"), join(data, "acme__widgets-node-1.json"));
 const probes = [{ type: "artifact-exists", path: "src/feature.ts", atRef: "main" }];
 writeFileSync(
  join(data, `acme__widgets-node-${nodeId}.json`),
  JSON.stringify({
   repo: "acme/widgets",
   ref: { id: nodeId },
   node: {
    id: nodeId,
    title: "Add the feature module",
    kind: "task",
    checkpointId: "feature-shipped",
    autonomy: opts.autonomy ?? "auto",
    probes,
   },
   status: "open",
   assignees: [BOT],
   blockedBy: [],
   author: opts.author ?? "alice",
   url: `https://github.com/acme/widgets/issues/${nodeId}`,
   typed: true,
   parent: { id: "1" },
   body: "## Task\n\nAdd src/feature.ts and its test.",
  }),
 );
 const statePath = join(dir, "state.json");
 writeFileSync(
  statePath,
  JSON.stringify({
   nodes: {
    [nodeId]: {
     assignees: [BOT],
     status: "open",
     autonomy: opts.autonomy ?? "auto",
     probes,
    },
   },
   decisions: [],
  }),
 );

 const lines = baseConfigLines(dir, {
  map: [
   `    canonical: ${canonical}`,
   "    commands:",
   "      test: test -f src/feature.ts",
  ],
  auth: ["  writeTokens:", '    "acme/*": RANGER_WRITE_TEST'],
  state: [`  canonicalRoot: ${dir}`],
  workers: ["  wallClockMin: 1", "  reviewRounds: 2"],
 }).map((l) => (l === "    walk: research-only" ? "    walk: full" : l));
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, lines.join("\n"));
 const { config } = loadConfig(configPath);

 Object.assign(process.env, GIT_ENV, {
  PATH: `${fixturesBin}:${savedEnv.PATH ?? ""}`,
  FAKE_SOMA_DIR: data,
  FAKE_SOMA_STATE: statePath,
 });
 delete process.env.RANGER_DISCORD_TOKEN; // park cards are best-effort

 const journal = openJournal(config);
 journal.upsertWorker({ nodeId, repo: "acme/widgets", status: "claimed", lane: "implement" });
 const github = new FakeGitHub(origin);
 const { reviewer, calls } = scriptedReviewer(github, opts.blockers ?? [0], opts.onReview);
 const ctx: RunNodeContext = {
  config,
  map: config.maps[0],
  token: "ghp_write",
  botIdentity: BOT,
  journal,
  workerCommand: [implementWorker, "build"],
  github,
  reviewer,
  readOnlyToken: "ghp_readonly",
 };
 return { dir, origin, canonical, journal, statePath, ctx, github, calls };
}

function state(path: string) {
 return JSON.parse(readFileSync(path, "utf8"));
}

describe("implement lane (node #23)", () => {
 let cleanup: string[] = [];
 beforeEach(() => {
  cleanup = [];
 });
 afterEach(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
   if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
 });

 test("auto node end to end: build → draft PR → review r1 blockers → fix → r2 clean → ready → merge card once → merge → gated close citing CI", async () => {
  const r = await rig({ blockers: [1, 0] });
  cleanup.push(r.dir);

  const first = await runNode("20", r.ctx);
  expect(first.status).toBe("awaiting-merge");
  expect(first.prNumber).toBe(1);
  const row = r.journal.getWorker("20");
  expect(row?.status).toBe("awaiting-merge");
  expect(row?.reviewRound).toBe(2);
  expect(row?.verdictBlockers).toBe(0);
  expect(r.calls).toHaveLength(2);

  const pr = r.github.prs.get(1);
  expect(pr?.draft).toBe(false);
  expect(pr?.title).toBe("Add the feature module (node #20)");
  expect(pr?.body).toContain("ranger never merges");
  const comments = r.github.comments.get(1) ?? [];
  expect(comments.map((c) => c.body.match(/round=(\d)/)?.[1])).toEqual(["1", "2"]);
  // The fix pass's commit is on origin: two commits ahead of main.
  const log = await runCmd("git", ["log", "--format=%s", "main..refs/heads/node/20-add-the-feature-module"], { cwd: r.origin });
  expect(log.stdout.trim().split("\n")).toHaveLength(2);

  // Tick: the merge desk posts the card once.
  const posts: string[] = [];
  const spawned: string[] = [];
  const sweep = () =>
   sweepMap({
    config: r.ctx.config,
    journal: r.journal,
    map: r.ctx.map,
    token: "ghp_write",
    botIdentity: BOT,
    github: r.github,
    post: async (content) => {
     posts.push(content);
     return `msg-${posts.length}`;
    },
    respawn: async (nodeId) => {
     spawned.push(nodeId);
     return DEAD_PID;
    },
   });
  const tick1 = await sweep();
  expect(tick1.mergeDesk?.cards).toEqual(["20"]);
  expect(posts[0]).toContain("merge needed");
  const tick2 = await sweep();
  expect(tick2.mergeDesk?.cards).toEqual([]);
  expect(posts).toHaveLength(1);

  // The principal merges; the next tick resumes run-node at the close phase.
  const merged = await r.github.merge(1);
  const tick3 = await sweep();
  expect(tick3.mergeDesk?.resumed).toEqual(["20"]);
  expect(spawned).toEqual(["20"]);
  expect(r.journal.getWorker("20")?.attempts).toBe(0); // the resume is not a crash

  const closed = await runNode("20", r.ctx);
  expect(closed.status).toBe("success");
  const s = state(r.statePath);
  expect(s.nodes["20"].status).toBe("closed");
  expect(s.lastClose.ci).toBe(`101@${merged}`);
  expect(s.lastClose.evidence.map((e: { kind: string }) => e.kind)).toEqual(["judged"]);
  expect(realpathSync(s.lastCloseCwd)).toBe(realpathSync(r.canonical));
  expect(r.journal.getWorker("20")?.status).toBe("success");
  expect(r.journal.getWorker("20")?.pid).toBeNull();
  expect(existsSync(join(r.canonical, ".worktrees", "node-20"))).toBe(false);
 }, 60_000);

 test("resume after a crash between review and fix runs the fix pass — no re-review, no cap reset (F2)", async () => {
  // Round 1 finds a blocker; the fix pass then commits nothing (simulating a
  // supervisor that died before fixing). The resume must fix, not park.
  const mode: string[] = [];
  const r = await rig({
   blockers: [1, 0],
   onReview: (round) => {
    if (round === 1) mode[1] = "noop";
   },
  });
  cleanup.push(r.dir);
  // The worker command array is the one the supervisor spawns from.
  const cmd = r.ctx.workerCommand as string[];
  mode.push(...cmd);
  r.ctx.workerCommand = mode;
  const first = await runNode("20", r.ctx);
  expect(first.status).toBe("failed");
  expect(r.calls).toHaveLength(1);

  mode[1] = "build";
  r.journal.updateWorker("20", { status: "claimed" });
  const resumed = await runNode("20", r.ctx);
  expect(resumed.status).toBe("awaiting-merge");
  expect(r.calls).toHaveLength(2); // round 1 was read back from the PR, not re-run
  const rounds = (r.github.comments.get(1) ?? []).map((c) => c.body.match(/round=(\d)/)?.[1]);
  expect(rounds).toEqual(["1", "2"]);
 }, 60_000);

 test("blockers after the round cap park the node, keeping the claim", async () => {
  const r = await rig({ blockers: [2, 1] });
  cleanup.push(r.dir);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("remain after 2 sage round(s)");
  expect(r.journal.getWorker("20")?.status).toBe("parked");
  expect(r.journal.deadmanCount()).toBe(0); // a park is not a crash
  expect(state(r.statePath).nodes["20"].assignees).toEqual([BOT]);
 }, 60_000);

 test("a closing keyword in a commit message refuses the push (#588)", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  r.ctx.workerCommand = [implementWorker, "keyword"];
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("closing keyword");
  expect(r.github.prs.size).toBe(0);
  expect(await r.github.sha("node/20-add-the-feature-module")).toBe("");
 }, 60_000);

 test("a worker that commits nothing fails and counts toward the dead-man", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  r.ctx.workerCommand = [implementWorker, "noop"];
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toContain("committed nothing");
  expect(r.journal.deadmanCount()).toBe(1);
 }, 60_000);

 test("propose node: merge is the ratification — the close carries tested evidence and no --ci", async () => {
  const r = await rig({ autonomy: "propose" });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(r.github.prs.get(1)?.body).toContain("merging this PR is the ratification");
  await r.github.merge(1);
  r.journal.updateWorker("20", { status: "running" });
  const closed = await runNode("20", r.ctx);
  expect(closed.status).toBe("success");
  const s = state(r.statePath);
  expect(s.lastClose.ci).toBe("");
  expect(s.lastClose.evidence.map((e: { kind: string }) => e.kind)).toEqual(["judged", "tested"]);
 }, 60_000);

 test("propose node filed by the machine account is refused (node #9 ban)", async () => {
  const r = await rig({ autonomy: "propose", author: BOT });
  cleanup.push(r.dir);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("refused");
  expect(outcome.detail).toContain("never walks work it minted");
  expect(r.github.prs.size).toBe(0);
 }, 60_000);

 test("a superseded occupant is fenced before its next outward action (F1)", async () => {
  // A second run-node takes the node while the first one's worker runs.
  const r = await rig({});
  cleanup.push(r.dir);
  const realWorker = r.ctx.workerCommand as string[];
  r.ctx.worker = async (prompt, opts) => {
   r.journal.beginGeneration("20"); // a newer occupant arrives mid-run
   return runCmd(realWorker[0], [...realWorker.slice(1), prompt], opts);
  };
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("refused");
  expect(outcome.detail).toContain("superseded");
  expect(r.github.prs.size).toBe(0); // never pushed, never opened a PR
  expect(await r.github.sha("node/20-add-the-feature-module")).toBe("");
 }, 60_000);
});
