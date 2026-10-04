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
import { ReviewError, type ReviewVerdict } from "../src/review.ts";
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
   mergedBy: string | null;
  }
 >();
 comments = new Map<number, IssueComment[]>();
 /** Issue labels by node id (ranger:needs-eye). */
 labels = new Map<number, string[]>();
 merges: { n: number; sha: string; title: string }[] = [];
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
   title: pr.title,
   mergedBy: pr.mergedBy,
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
  this.prs.set(n, { ...pr, draft: true, state: "open", merged: false, mergedSha: null, mergedBy: null });
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

 async issueLabels(_repo: string, n: number) {
  return this.labels.get(n) ?? [];
 }
 /** Ranger's merge: like GitHub, refused when the head moved off `sha`. */
 async mergePr(_repo: string, n: number, sha: string, title: string) {
  const pr = this.prs.get(n);
  if (pr === undefined) throw new Error(`no PR #${n}`);
  if ((await this.sha(pr.head)) !== sha) throw new Error("409 head moved");
  this.merges.push({ n, sha, title });
  await this.merge(n, BOT);
 }

 /** A merge (the principal's by default): fast-forward origin main to the PR head. */
 async merge(n: number, by = "jcfischer"): Promise<string> {
  const pr = this.prs.get(n);
  if (pr === undefined) throw new Error(`no PR #${n}`);
  const head = await this.sha(pr.head);
  await runCmd("git", ["update-ref", "refs/heads/main", head], { cwd: this.origin });
  pr.merged = true;
  pr.state = "closed";
  pr.mergedSha = head;
  pr.mergedBy = by;
  return head;
 }
}

/** A scripted sage: blockers per round; the commit id is the PR's live head. */
function scriptedReviewer(
 github: FakeGitHub,
 blockers: number[],
 onReview?: (round: number) => void,
 majors: number[] = [0],
) {
 const calls: number[] = [];
 const reviewer = async (_repo: string, pr: number): Promise<ReviewVerdict> => {
  const round = calls.length + 1;
  calls.push(pr);
  onReview?.(round);
  const head = (await github.getPr("acme/widgets", pr)).headSha;
  const b = blockers[Math.min(round - 1, blockers.length - 1)];
  const m = majors[Math.min(round - 1, majors.length - 1)];
  return {
   verdict: b + m > 0 ? "changes-requested" : "approved",
   summary: `round ${round}`,
   commitId: head,
   blockers: b,
   majors: m,
   nits: 2,
   body: `## Sage\n\nRound ${round}: ${b} blocker(s), ${m} major(s).`,
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
 majors?: number[];
 onReview?: (round: number) => void;
 /** commands.probe for the map (a fake-probe invocation). */
 probe?: string;
 autoMerge?: boolean;
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
   ...(opts.probe === undefined ? [] : [`      probe: '${opts.probe}'`]),
   ...(opts.autoMerge === true ? ["    autoMerge: true"] : []),
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
 const { reviewer, calls } = scriptedReviewer(github, opts.blockers ?? [0], opts.onReview, opts.majors ?? [0]);
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
  // The machine account authors the work (design §2), not the host identity.
  const authors = await runCmd("git", ["log", "--format=%an <%ae>", "main..refs/heads/node/20-add-the-feature-module"], { cwd: r.origin });
  expect(new Set(authors.stdout.trim().split("\n"))).toEqual(new Set([`${BOT} <${BOT}@users.noreply.github.com>`]));

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
  expect(outcome.detail).toContain("blocker(s) and 0 major(s) remain after 2 sage round(s)");
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
  // The session output is kept, and the failure names where (found live on #669).
  const log = outcome.detail.match(/worker log: ([^)]+)\)/)?.[1];
  expect(log).toBeDefined();
  expect(readFileSync(log as string, "utf8")).toContain("build pass — exit 0");
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
 test("a worker that leaves the tree dirty fails: the test run must cover exactly what is pushed", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  r.ctx.workerCommand = [implementWorker, "dirty"];
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toContain("uncommitted or untracked");
  expect(r.github.prs.size).toBe(0);
 }, 60_000);

 test("a PR parked at the review cap that the principal merges anyway still closes (merge desk watches parked PRs)", async () => {
  const r = await rig({ blockers: [2, 1] });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("parked");
  const sweep = () =>
   sweepMap({
    config: r.ctx.config,
    journal: r.journal,
    map: r.ctx.map,
    token: "ghp_write",
    botIdentity: BOT,
    github: r.github,
    post: async () => "msg",
    respawn: async () => DEAD_PID,
   });
  const quiet = await sweep(); // open + parked: the desk does nothing
  expect(quiet.mergeDesk?.resumed).toEqual([]);
  expect(quiet.mergeDesk?.cards).toEqual([]);
  expect(r.journal.getWorker("20")?.status).toBe("parked");

  await r.github.merge(1);
  expect((await sweep()).mergeDesk?.resumed).toEqual(["20"]);
  const closed = await runNode("20", r.ctx);
  expect(closed.status).toBe("success");
  expect(state(r.statePath).nodes["20"].status).toBe("closed");
 }, 60_000);
 test("probe tier passes on the final head: recorded on the PR, named in the body, gates and names the merge card — and never sees a ranger credential", async () => {
  const r = await rig({ blockers: [1, 0], probe: "fake-probe ok {node}" });
  cleanup.push(r.dir);
  process.env.RANGER_WRITE_TEST = "ghp_write"; // must not reach the probe
  const first = await runNode("20", r.ctx);
  expect(first.status).toBe("awaiting-merge");
  const comments = r.github.comments.get(1) ?? [];
  const probes = comments.filter((c) => c.body.includes("ranger:probes"));
  expect(probes).toHaveLength(1); // once, on the final head only
  const head = await r.github.sha("node/20-add-the-feature-module");
  expect(probes[0].body).toContain(`sha=${head} result=pass selected=2 mode=semantic`);
  expect(probes[0].body).toContain("node 20: 2 probes passed"); // {node} templated
  expect(r.github.prs.get(1)?.body).toContain("- Probes: passed at");

  const posts: string[] = [];
  const tick = await sweepMap({
   config: r.ctx.config,
   journal: r.journal,
   map: r.ctx.map,
   token: "ghp_write",
   botIdentity: BOT,
   github: r.github,
   post: async (content) => {
    posts.push(content);
    return "msg-1";
   },
  });
  expect(tick.mergeDesk?.cards).toEqual(["20"]);
  expect(posts[0]).toContain("Probes passed at");
 }, 60_000);

 test("a flaky probe run is retried once and passes", async () => {
  const r = await rig({ probe: `fake-probe flaky {node} ${tmpdir()}/ranger-flaky-${Date.now()}` });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const probe = (r.github.comments.get(1) ?? []).find((c) => c.body.includes("ranger:probes"));
  expect(probe?.body).toContain("result=pass");
  expect(probe?.body).toContain("2 run(s)");
 }, 60_000);

 test("probes failing twice park the node: the PR stays a draft, the failure is on the PR, no merge card", async () => {
  const r = await rig({ probe: "fake-probe fail {node}" });
  cleanup.push(r.dir);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("browser probes failed twice");
  expect(r.github.prs.get(1)?.draft).toBe(true);
  const probe = (r.github.comments.get(1) ?? []).find((c) => c.body.includes("ranger:probes"));
  expect(probe?.body).toContain("result=fail");
  expect(r.journal.deadmanCount()).toBe(0);
  const tick = await sweepMap({
   config: r.ctx.config,
   journal: r.journal,
   map: r.ctx.map,
   token: "ghp_write",
   botIdentity: BOT,
   github: r.github,
   post: async () => "msg",
  });
  expect(tick.mergeDesk?.cards ?? []).toEqual([]);
 }, 60_000);
 test("a PR that went ready before the map had a probe tier is sent back for probes, not parked", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge"); // no probe tier yet
  // The principal adds the probe tier while the PR waits for the merge.
  r.ctx.map.commands.probe = "fake-probe ok {node}";
  const spawned: string[] = [];
  const tick = await sweepMap({
   config: r.ctx.config,
   journal: r.journal,
   map: r.ctx.map,
   token: "ghp_write",
   botIdentity: BOT,
   github: r.github,
   post: async () => "msg",
   respawn: async (nodeId) => {
    spawned.push(nodeId);
    return DEAD_PID;
   },
  });
  expect(tick.mergeDesk?.resumed).toEqual(["20"]);
  expect(tick.mergeDesk?.parked).toEqual([]);
  expect(spawned).toEqual(["20"]);
  // The resumed run-node runs only the probe step: no new review round.
  const before = r.calls.length;
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(r.calls.length).toBe(before);
  const probe = (r.github.comments.get(1) ?? []).find((c) => c.body.includes("ranger:probes"));
  expect(probe?.body).toContain("result=pass");
 }, 60_000);
 test("a major gates like a blocker: fix pass, then a new sage round", async () => {
  const r = await rig({ blockers: [0, 0], majors: [1, 0] });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(r.calls).toHaveLength(2);
  const rounds = (r.github.comments.get(1) ?? []).map((c) => c.body.match(/round=(\d) sha=\w+ blockers=(\d) majors=(\d)/)?.slice(1).join(","));
  expect(rounds).toEqual(["1,0,1", "2,0,0"]);
 }, 60_000);

 test("majors left after the round cap park the node", async () => {
  const r = await rig({ blockers: [0], majors: [1, 1] });
  cleanup.push(r.dir);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("0 blocker(s) and 1 major(s) remain after 2 sage round(s)");
 }, 60_000);

 test("a ready PR whose last review still has a major (it went ready under the old rule) is sent back, and its merge card withdrawn", async () => {
  const r = await rig({ blockers: [0], majors: [1, 0] });
  cleanup.push(r.dir);
  // Simulate the old rule: the PR went ready after round 1 with one major.
  r.ctx.config.workers.reviewRounds = 1;
  // A cap of 1 parks on the major; stand the PR up as ready by hand.
  expect((await runNode("20", r.ctx)).status).toBe("parked");
  const pr = r.github.prs.get(1);
  if (pr) pr.draft = false;
  r.journal.updateWorker("20", { status: "awaiting-merge", phase: "awaiting-merge", mergeMessageId: "old-card" });
  r.ctx.config.workers.reviewRounds = 2;

  const posts: string[] = [];
  const spawned: string[] = [];
  const tick = await sweepMap({
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
  expect(tick.mergeDesk?.resumed).toEqual(["20"]);
  expect(posts[0]).toContain("merge card withdrawn");
  expect(r.journal.getWorker("20")?.mergeMessageId).toBeNull();
  // The resumed run-node reworks the major and runs round 2.
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(r.calls).toHaveLength(2);
 }, 60_000);
 test("a send-back waits for the implement lane, after withdrawing the stale card", async () => {
  const r = await rig({ blockers: [0], majors: [1, 0] });
  cleanup.push(r.dir);
  r.ctx.config.workers.reviewRounds = 1;
  expect((await runNode("20", r.ctx)).status).toBe("parked");
  r.journal.updateWorker("20", { status: "awaiting-merge", phase: "awaiting-merge", mergeMessageId: "old-card" });
  r.ctx.config.workers.reviewRounds = 2;
  // Another implement worker holds the lane.
  r.journal.upsertWorker({ nodeId: "99", repo: "acme/widgets", status: "running", lane: "implement" });

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
  const waiting = await sweep();
  expect(waiting.mergeDesk?.pending).toEqual(["20"]);
  expect(spawned).toEqual([]);
  expect(posts[0]).toContain("merge card withdrawn");
  expect(r.journal.getWorker("20")?.mergeMessageId).toBeNull();

  // The lane frees; the next tick sends it back, without a second withdrawal.
  r.journal.updateWorker("99", { status: "success" });
  const resumed = await sweep();
  expect(resumed.mergeDesk?.resumed).toEqual(["20"]);
  expect(spawned).toEqual(["20"]);
  expect(posts).toHaveLength(1);
 }, 60_000);
 test("autoMerge: a gate-passed PR with no needs-eye label is squash-merged by ranger at the gated head, then closed — the receipt names ranger and the standing grant", async () => {
  const r = await rig({ autonomy: "propose", autoMerge: true });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(r.github.prs.get(1)?.body).toContain("Ranger squash-merges this itself");
  const posts: string[] = [];
  const spawned: string[] = [];
  const tick = await sweepMap({
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
  expect(tick.mergeDesk?.merged).toEqual(["20"]);
  expect(tick.mergeDesk?.cards).toEqual([]);
  expect(spawned).toEqual(["20"]);
  const head = r.github.prs.get(1)?.mergedSha;
  expect(r.github.merges).toEqual([{ n: 1, sha: head as string, title: "Add the feature module (node #20)" }]);
  expect(posts[0]).toContain("**merged** #20");

  const closed = await runNode("20", r.ctx);
  expect(closed.status).toBe("success");
  const tested = state(r.statePath).lastClose.evidence.find((e: { kind: string }) => e.kind === "tested");
  expect(tested.summary).toContain(`${BOT} merged PR #1 under the principal's standing grant`);
 }, 60_000);

 test("autoMerge: a node labelled ranger:needs-eye keeps the one-tap merge card", async () => {
  const r = await rig({ autoMerge: true });
  cleanup.push(r.dir);
  r.github.labels.set(20, ["ranger:needs-eye"]);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const posts: string[] = [];
  const tick = await sweepMap({
   config: r.ctx.config,
   journal: r.journal,
   map: r.ctx.map,
   token: "ghp_write",
   botIdentity: BOT,
   github: r.github,
   post: async (content) => {
    posts.push(content);
    return "msg-1";
   },
   respawn: async () => DEAD_PID,
  });
  expect(tick.mergeDesk?.merged).toEqual([]);
  expect(tick.mergeDesk?.cards).toEqual(["20"]);
  expect(r.github.merges).toEqual([]);
  expect(posts[0]).toContain("your eye is the check");
 }, 60_000);
 // ---- substrate caps (node #45) ----

 test("a session capped mid-build resumes on the next substrate without touching attempts or the dead-man", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  let calls = 0;
  r.ctx.substrate = "claude";
  r.ctx.substrateReaders = {
   claude: () => Promise.reject(new Error("claude probe must not decide this")),
   codex: async () => ({
    substrate: "codex",
    readAt: new Date(),
    windows: [{ kind: "seven_day", usedPct: 5, resetsAt: resetsAt + 86_400 }],
    capped: false,
    cappedUntil: null,
   }),
  };
  r.ctx.worker = async (prompt, opts) => {
   calls += 1;
   if (calls === 1) {
    // A half-done session, then Claude's own stream says the limit hit.
    writeFileSync(join(opts.cwd as string, "half-done.ts"), "// capped mid-session\n");
    return {
     code: 1,
     stdout: `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAt}}}\n`,
     stderr: "",
    };
   }
   return runCmd(implementWorker, ["build", prompt], opts);
  };

  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("awaiting-merge");
  expect(calls).toBe(2);
  expect(r.journal.deadmanCount()).toBe(0);
  const row = r.journal.getWorker("20");
  expect(row?.attempts).toBe(0);
  expect(row?.substrate).toBe("codex");
  expect(r.journal.getSubstrateReading("claude")?.cappedUntil).toBe(new Date(resetsAt * 1000).toISOString());

  const events = r.journal.listEvents("acme/widgets", 200);
  const capped = events.filter((e) => e.kind === "substrate-capped");
  expect(capped).toHaveLength(1);
  expect(capped[0].detail).toContain("claude hit its limit");
  const starts = events.filter((e) => e.kind === "worker-start" && e.detail?.startsWith("substrate "));
  expect(starts.map((e) => e.detail?.split(" ")[1]).reverse()).toEqual(["claude", "codex"]);
  expect(starts[0].detail).toContain("codex 7d 5%");

  // The capped session's leftovers were dropped; the pushed head is Codex's.
  const head = await r.github.sha("node/20-add-the-feature-module");
  expect(r.journal.headSubstrate(head)).toBe("codex");
  const files = await runCmd("git", ["ls-tree", "-r", "--name-only", head], { cwd: r.origin });
  expect(files.stdout).not.toContain("half-done.ts");
 }, 60_000);

 test("a review capped on its substrate resumes cross-model without touching attempts or the dead-man", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  r.ctx.substrate = "claude";
  // Codex reads eligible for the review's selection, then capped once sage fails on it.
  let codexReads = 0;
  r.ctx.substrateReaders = {
   claude: () => Promise.reject(new Error("probe down")),
   codex: async () => {
    codexReads += 1;
    const capped = codexReads > 1;
    return {
     substrate: "codex",
     readAt: new Date(),
     windows: [{ kind: "five_hour", usedPct: capped ? 100 : 10, resetsAt }],
     capped,
     cappedUntil: capped ? resetsAt : null,
    };
   },
  };
  const scripted = r.ctx.reviewer!;
  const reviewSubstrates: (string | undefined)[] = [];
  r.ctx.reviewer = async (repo, pr, token, opts) => {
   reviewSubstrates.push(opts?.substrate);
   if (reviewSubstrates.length === 1) throw new ReviewError("sage exited 1: usage limit");
   return scripted(repo, pr, token, opts);
  };

  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("awaiting-merge");
  // Claude wrote the head: the review goes to Codex first; once Codex caps
  // (and Claude is unread), the resumed review falls back to Pi.
  expect(reviewSubstrates).toEqual(["codex", "pi"]);
  expect(r.journal.deadmanCount()).toBe(0);
  expect(r.journal.getWorker("20")?.attempts).toBe(0);
  expect(r.journal.getSubstrateReading("codex")?.cappedUntil).toBe(new Date(resetsAt * 1000).toISOString());

  const events = r.journal.listEvents("acme/widgets", 200);
  const capped = events.filter((e) => e.kind === "substrate-capped");
  expect(capped).toHaveLength(1);
  expect(capped[0].detail).toContain("codex hit its limit");
  const reviewed = events.filter((e) => e.kind === "reviewed");
  expect(reviewed).toHaveLength(1);
  expect(reviewed[0].detail).toContain("on pi (head by claude;");

  const markers = (r.github.comments.get(1) ?? []).filter((c) => c.body.includes("ranger:review"));
  expect(markers).toHaveLength(1);
  expect(markers[0].body).toContain("substrate=pi -->");
 }, 60_000);

 test("a codex failure that only prints 'rate limit' is an ordinary failure (no spoofed cap)", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  r.ctx.substrate = "codex";
  r.ctx.substrateReaders = {
   claude: () => Promise.reject(new Error("down")),
   codex: async () => ({ substrate: "codex", readAt: new Date(), windows: [], capped: false, cappedUntil: null }),
  };
  r.ctx.worker = async () => ({ code: 1, stdout: "Error: rate limit reached\nrateLimitReachedType", stderr: "Rate limit" });

  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toContain("worker exited 1");
  expect(r.journal.deadmanCount()).toBe(1);
  expect(r.journal.listEvents("acme/widgets", 200).some((e) => e.kind === "substrate-capped")).toBe(false);
 }, 60_000);
});
