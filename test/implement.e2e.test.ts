import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { Database } from "bun:sqlite";
import { openJournal, type Journal } from "../src/journal.ts";
import { ReviewError, type ReviewVerdict } from "../src/review.ts";
import { LAST_IMPLEMENT_MAP } from "../src/maps.ts";
import { sweepMap } from "../src/sweep.ts";
import { runNode, type RunNodeContext } from "../src/worker.ts";
import { baseConfigLines, createCanonicalRepo, GIT_ENV } from "./support.ts";
import { saveViewsRecord, viewsDirectory } from "../src/views.ts";
import { DiscordAnnouncer } from "../src/announce.ts";

const fixturesBin = join(import.meta.dir, "fixtures", "bin");
const dataDir = join(import.meta.dir, "fixtures", "data");
const implementWorker = join(fixturesBin, "implement-worker");
const BOT = "ivy-bot";
const DEAD_PID = 2_147_483_646;

/** In-memory forge over the real bare origin: a PR's head is the origin branch's tip. */
class FakeGitHub implements GitHubPort {
 async workflowRunsFor() { return []; }
 async commitStatusesFor() { return []; }
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
 root?: number;
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
 if (opts.root === 460) {
  config.maps.push({ ...config.maps[0], root: 460 });
  const mapNode = JSON.parse(readFileSync(join(data, "acme__widgets-node-1.json"), "utf8"));
  mapNode.node.title = "Gameplay map 460";
  mapNode.ref.id = "460";
  mapNode.body = "## Constraints\n\nGAMEPLAY_460_ONLY: preserve gameplay authority.";
  writeFileSync(join(data, "acme__widgets-node-460.json"), JSON.stringify(mapNode));
 }

 Object.assign(process.env, GIT_ENV, {
  PATH: `${fixturesBin}:${savedEnv.PATH ?? ""}`,
  FAKE_SOMA_DIR: data,
  FAKE_SOMA_STATE: statePath,
 });
 delete process.env.RANGER_DISCORD_TOKEN; // park cards are best-effort

 const journal = openJournal(config);
 journal.upsertWorker({ root: opts.root ?? 1, nodeId, repo: "acme/widgets", status: "claimed", lane: "implement" });
 const github = new FakeGitHub(origin);
 const { reviewer, calls } = scriptedReviewer(github, opts.blockers ?? [0], opts.onReview, opts.majors ?? [0]);
 const ctx: RunNodeContext = {
  config,
  map: config.maps.find(m => m.root === (opts.root ?? 1))!,
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

/** The node's substrate sessions (node #56), oldest first: [substrate, kind, outcome]. */
function sessions(journal: Journal): [string, string, string | null][] {
 return (journal.listSubstrateSessions(new Date(0)) ?? []).map((s) => {
  expect(s.endedAt).not.toBeNull();
  return [s.substrate, s.kind, s.outcome];
 });
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

 test("two maps: gameplay prompt, merge recovery and decision projection stay on root 460", async () => {
  const r = await rig({ root: 460 });
  cleanup.push(r.dir);
  const callsFile = join(r.dir, "root-calls.log");
  process.env.FAKE_SOMA_ROOT_CALLS = callsFile;
  const prompts: string[] = [];
  r.ctx.worker = async (prompt, opts) => {
   prompts.push(prompt);
   return runCmd(implementWorker, ["build", prompt], opts);
  };
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Gameplay map 460");
  expect(prompts[0]).toContain("GAMEPLAY_460_ONLY");
  expect(prompts[0]).not.toContain("A widgets platform");
  expect(r.journal.getWorker("20", "acme/widgets")?.root).toBe(460);
  const posts: string[] = [];
  const spawns: string[] = [];
  const sweep = (root: number) => sweepMap({
   config: r.ctx.config, journal: r.journal,
   map: r.ctx.config.maps.find(m => m.root === root)!,
   token: "ghp_write", botIdentity: BOT, github: r.github,
   post: async content => { posts.push(content); return "merge-card"; },
   respawn: async (id, repo, root) => { spawns.push(repo + "#" + root + ":" + id); return DEAD_PID; },
  });
  expect((await sweep(1)).mergeDesk).toBeUndefined();
  expect((await sweep(460)).mergeDesk?.cards).toEqual(["20"]);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain("map: acme/widgets#460");
  await r.github.merge(1);
  await sweep(1);
  expect((await sweep(460)).mergeDesk?.resumed).toEqual(["20"]);
  expect(spawns).toEqual(["acme/widgets#460:20"]);
  r.journal.setHealth(LAST_IMPLEMENT_MAP, "acme/widgets#1");
  r.journal.setHealth(`${LAST_IMPLEMENT_MAP}.headless`, "acme/widgets#1");
  expect((await runNode("20", r.ctx)).status).toBe("success");
  expect(r.journal.getHealth(LAST_IMPLEMENT_MAP)).toBe("acme/widgets#1");
  expect(r.journal.getHealth(`${LAST_IMPLEMENT_MAP}.headless`)).toBe("acme/widgets#1");
  const rootCalls = readFileSync(callsFile, "utf8");
  expect(rootCalls).toContain("decisions acme/widgets 460");
  expect(rootCalls).not.toContain("decisions acme/widgets 1\n");
  expect(prompts).toHaveLength(1);
  r.journal.close();
 }, 60_000);

 test("auto node end to end: build → draft PR → review r1 blockers → fix → r2 clean → ready → merge card once → merge → gated close citing CI", async () => {
  const r = await rig({ blockers: [1, 0] });
  cleanup.push(r.dir);

  const first = await runNode("20", r.ctx);
  expect(first.status).toBe("awaiting-merge");
  expect(first.prNumber).toBe(1);
  const row = r.journal.getWorker("20", "acme/widgets");
  expect(row?.status).toBe("awaiting-merge");
  expect(row?.reviewRound).toBe(2);
  expect(row?.verdictBlockers).toBe(0);
  expect(r.calls).toHaveLength(2);
  // Quota reads fail closed under the injected worker, so every session ran on Pi (node #56).
  expect(sessions(r.journal)).toEqual([
   ["pi", "worker", "ok"],
   ["pi", "review", "ok"],
   ["pi", "fix-pass", "ok"],
   ["pi", "review", "ok"],
  ]);
  // Each row carries the supervisor generation that ran it: the panel's liveness check.
  expect(new Set(r.journal.listSubstrateSessions(new Date(0))?.map((s) => s.generation))).toEqual(
   new Set([row!.generation]),
  );

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
  expect(r.journal.getWorker("20", "acme/widgets")?.attempts).toBe(0); // the resume is not a crash

  const closed = await runNode("20", r.ctx);
  expect(closed.status).toBe("success");
  const s = state(r.statePath);
  expect(s.nodes["20"].status).toBe("closed");
  expect(s.lastClose.ci).toBe(`101@${merged}`);
  expect(s.lastClose.evidence.map((e: { kind: string }) => e.kind)).toEqual(["judged"]);
  expect(realpathSync(s.lastCloseCwd)).toBe(realpathSync(r.canonical));
  expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("success");
  expect(r.journal.getWorker("20", "acme/widgets")?.pid).toBeNull();
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
  r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
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
  expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("parked");
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

 test("a transient GitHub error at review is not counted and leaves the row for the sweep (found live on #45)", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  r.ctx.reviewer = async () => {
   throw new Error(
    "sage review acme/widgets#1 exited 1: gh: We couldn't respond to your request in time. Sorry about that. (https://api.github.com/graphql)",
   );
  };
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("failed");
  expect(r.journal.deadmanCount()).toBe(0);
  // Still running under this supervisor's PID: when it exits, the sweep sees a crash and respawns.
  expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("running");
  expect(r.journal.listEvents().some((e) => e.kind === "transient")).toBe(true);
  // The pushed work and the PR survive for the respawn to pick up.
  expect(r.github.prs.size).toBe(1);
 }, 60_000);

 test("propose node: merge is the ratification — the close carries tested evidence and no --ci", async () => {
  const r = await rig({ autonomy: "propose" });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(r.github.prs.get(1)?.body).toContain("merging this PR is the ratification");
  await r.github.merge(1);
  r.journal.updateWorker("20", "acme/widgets", { status: "running" });
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
   r.journal.beginGeneration("20", "acme/widgets"); // a newer occupant arrives mid-run
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
  expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("parked");

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
  r.journal.updateWorker("20", "acme/widgets", { status: "awaiting-merge", phase: "awaiting-merge", mergeMessageId: "old-card" });
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
  expect(r.journal.getWorker("20", "acme/widgets")?.mergeMessageId).toBeNull();
  // The resumed run-node reworks the major and runs round 2.
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(r.calls).toHaveLength(2);
 }, 60_000);
 test("a send-back waits for the implement lane, after withdrawing the stale card", async () => {
  const r = await rig({ blockers: [0], majors: [1, 0] });
  cleanup.push(r.dir);
  r.ctx.config.workers.reviewRounds = 1;
  expect((await runNode("20", r.ctx)).status).toBe("parked");
  r.journal.updateWorker("20", "acme/widgets", { status: "awaiting-merge", phase: "awaiting-merge", mergeMessageId: "old-card" });
  r.ctx.config.workers.reviewRounds = 2;
  // Another implement worker holds the lane.
  r.journal.upsertWorker({ root: 1, nodeId: "99", repo: "acme/widgets", status: "running", lane: "implement" });

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
  expect(r.journal.getWorker("20", "acme/widgets")?.mergeMessageId).toBeNull();

  // The lane frees; the next tick sends it back, without a second withdrawal.
  r.journal.updateWorker("99", "acme/widgets", { status: "success" });
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

 test("needs-eye capture refusal posts its reason on the merge card and PR without parking", async () => {
  const r = await rig({ autoMerge: true, probe: "fake-probe ok {node}" });
  cleanup.push(r.dir);
  r.github.labels.set(20, ["ranger:needs-eye"]);
  Object.assign(r.ctx.map.commands, { views: "capture {label} {out} {origin}", viewsServe: "serve {port}", viewsDiff: "diff {out} {a} {b}" });
  let stopped = false;
  let captures = 0;
  r.ctx.viewsDependencies = {
   freePort: async () => 45678,
   startServer: async () => ({ stop: async () => { stopped = true; } }),
   run: async (_bin, _args, opts) => {
    expect((r.github.comments.get(1) ?? []).some(c => c.body.includes("ranger:probes") && c.body.includes("result=pass"))).toBe(true);
    expect(opts?.env?.RANGER_WRITE_TEST).toBeUndefined();
    captures++;
    return { code: 1, stdout: "", stderr: "software renderer refused" };
   },
  };
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("awaiting-merge");
  expect(captures).toBe(1);
  expect(stopped).toBe(true);
  const comments = r.github.comments.get(1) ?? [];
  expect(comments.find(c => c.body.includes("ranger:views"))?.body).toContain("software renderer refused");
  const posts: string[] = [];
  const tick = await sweepMap({
   config: r.ctx.config, journal: r.journal, map: r.ctx.map, token: "ghp_write", botIdentity: BOT, github: r.github,
   post: async (content) => { posts.push(content); return "views-failure-card"; },
   respawn: async () => DEAD_PID,
  });
  expect(tick.mergeDesk?.cards).toEqual(["20"]);
  expect(tick.mergeDesk?.parked).toEqual([]);
  expect(r.journal.getWorker("20", r.ctx.map.repo)?.status).toBe("awaiting-merge");
  expect(posts[0]).toContain("Sheet could not be made");
  expect(posts[0]).toContain("software renderer refused");
  expect(r.github.merges).toEqual([]);
 }, 60_000);

 test("unconfigured manual map posts its card without a label read or views evidence", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  r.github.labels.set(20, ["ranger:needs-eye"]);
  r.github.issueLabels = async () => { throw new Error("unconfigured map must not read labels"); };
  r.ctx.viewsDependencies = {
   run: async () => { throw new Error("must not capture"); },
  };
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect((r.github.comments.get(1) ?? []).some(c => c.body.includes("ranger:views"))).toBe(false);
  const posts: string[] = [];
  const tick = await sweepMap({
   config: r.ctx.config, journal: r.journal, map: r.ctx.map, token: "ghp_write", botIdentity: BOT, github: r.github,
   post: async content => { posts.push(content); return "unconfigured-card"; },
   respawn: async () => DEAD_PID,
  });
  expect(tick.mergeDesk?.cards).toEqual(["20"]);
  expect(tick.mergeDesk?.errors).toEqual([]);
  expect(posts[0]).not.toContain("Sheet could not be made");
 }, 60_000);

 test.each([false, true])("label outage with views configured: autoMerge=%s", async (autoMerge) => {
  const r = await rig({ autoMerge });
  cleanup.push(r.dir);
  r.ctx.map.commands.views = "capture {label} {out} {origin}";
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  let reads = 0;
  r.github.issueLabels = async () => { reads++; throw new Error("labels unavailable"); };
  const posts: string[] = [];
  const tick = await sweepMap({
   config: r.ctx.config, journal: r.journal, map: r.ctx.map, token: "ghp_write", botIdentity: BOT, github: r.github,
   post: async content => { posts.push(content); return "label-outage-card"; },
   respawn: async () => DEAD_PID,
  });
  expect(reads).toBe(1);
  expect(tick.mergeDesk?.merged).toEqual([]);
  expect(tick.mergeDesk?.parked).toEqual([]);
  expect(r.github.merges).toEqual([]);
  expect(r.journal.getWorker("20", r.ctx.map.repo)?.status).toBe("awaiting-merge");
  if (autoMerge) {
   expect(tick.mergeDesk?.cards).toEqual([]);
   expect(tick.mergeDesk?.errors).toEqual(["#20: labels unavailable"]);
   expect(posts).toEqual([]);
   expect(r.journal.getWorker("20", r.ctx.map.repo)?.mergeMessageId).toBeNull();
  } else {
   expect(tick.mergeDesk?.cards).toEqual(["20"]);
   expect(tick.mergeDesk?.errors).toEqual([]);
   expect(posts[0]).toContain("**merge needed**");
   expect(posts[0]).not.toContain("Visual evidence");
   expect(r.journal.getWorker("20", r.ctx.map.repo)?.mergeMessageId).toBe("label-outage-card");
   expect(r.journal.listEvents().some(e => e.kind === "merge-card" && e.detail?.includes("label lookup failed (informational): Error: labels unavailable"))).toBe(true);
  }
 }, 60_000);

 test.each([413, 400])("evidence rejected with HTTP %s falls back to a text merge card once", async status => {
  const r = await rig({ autoMerge: true });
  cleanup.push(r.dir);
  r.github.labels.set(20, ["ranger:needs-eye"]);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  r.ctx.map.commands.views = "capture {label} {out} {origin}";
  const pr = await r.github.getPr(r.ctx.map.repo, 1);
  const out = viewsDirectory(r.journal.path, r.ctx.map.repo, "20", pr.headSha);
  // 413 exercises multipart files; 400 exercises embeds with no files.
  const rows = status === 413 ? [{ view: "hull", change: 2, noise: 0.1 }]
   : Array.from({ length: 40 }, (_, i) => ({ view: `quiet-view-${i}`, change: 0, noise: 0 }));
  if (status === 413) {
   for (const label of ["before", "after"]) {
    mkdirSync(join(out, label), { recursive: true });
    writeFileSync(join(out, label, "hull.png"), "PNG");
   }
  }
  saveViewsRecord(out, { sha: pr.headSha, status: "ok", rows });
  const requests: RequestInit[] = [];
  const fetchFn = (async (_url, init) => {
   requests.push(init!);
   if (requests.length === 1) {
    if (status === 413) expect(init!.body).toBeInstanceOf(FormData);
    else expect(JSON.parse(init!.body as string).embeds.length).toBeGreaterThan(0);
    return new Response("rejected evidence", { status });
   }
   const body = JSON.parse(init!.body as string);
   expect(body.attachments).toBeUndefined();
   expect(body.embeds).toBeUndefined();
   expect(body.content).toContain("**merge needed**");
   expect(body.content).toContain("your eye is the check");
   expect(body.content).toContain("Visual evidence could not be delivered:");
   expect(body.content).toContain(`discord post returned HTTP ${status}`);
   expect(body.content.length).toBeLessThanOrEqual(2000);
   return new Response(JSON.stringify({ id: "text-fallback-card" }), { status: 200 });
  }) as typeof fetch;
  const announcer = new DiscordAnnouncer("fake-token", "channel", "https://discord.test", fetchFn);
  const sweep = () => sweepMap({
   config: r.ctx.config, journal: r.journal, map: r.ctx.map, token: "ghp_write", botIdentity: BOT, github: r.github,
   post: (content, label, files, embeds) => announcer.post(content, label, files, embeds),
   respawn: async () => DEAD_PID,
  });
  const tick = await sweep();
  expect(tick.mergeDesk?.errors).toEqual([]);
  expect(tick.mergeDesk?.cards).toEqual(["20"]);
  expect(tick.mergeDesk?.parked).toEqual([]);
  expect(r.journal.getWorker("20", r.ctx.map.repo)?.status).toBe("awaiting-merge");
  expect(r.journal.getWorker("20", r.ctx.map.repo)?.mergeMessageId).toBe("text-fallback-card");
  expect(r.journal.listEvents().some(e => e.detail?.includes("views delivery failed (informational)"))).toBe(true);
  expect(r.github.merges).toEqual([]);
  expect((await sweep()).mergeDesk?.cards).toEqual([]);
  expect(requests).toHaveLength(2);
 }, 60_000);

 test("failure of the text fallback leaves the card unrecorded for a later tick without parking", async () => {
  const r = await rig({ autoMerge: true });
  cleanup.push(r.dir);
  r.github.labels.set(20, ["ranger:needs-eye"]);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  r.ctx.map.commands.views = "capture {label} {out} {origin}";
  const pr = await r.github.getPr(r.ctx.map.repo, 1);
  saveViewsRecord(viewsDirectory(r.journal.path, r.ctx.map.repo, "20", pr.headSha), {
   sha: pr.headSha, status: "ok",
   rows: Array.from({ length: 40 }, (_, i) => ({ view: `quiet-view-${i}`, change: 0, noise: 0 })),
  });
  let attempts = 0;
  const sweep = () => sweepMap({
   config: r.ctx.config, journal: r.journal, map: r.ctx.map, token: "ghp_write", botIdentity: BOT, github: r.github,
   post: async (_content, _label, files, embeds) => {
    attempts++;
    if (attempts === 1) { expect(embeds?.length).toBeGreaterThan(0); throw new Error("embed rejected"); }
    if (attempts === 2) { expect(files).toBeUndefined(); expect(embeds).toBeUndefined(); throw new Error("Discord unavailable"); }
    return "retry-card";
   },
   respawn: async () => DEAD_PID,
  });
  const tick = await sweep();
  expect(tick.mergeDesk?.cards).toEqual([]);
  expect(tick.mergeDesk?.errors).toEqual(["#20: Discord unavailable"]);
  expect(tick.mergeDesk?.parked).toEqual([]);
  expect(r.journal.getWorker("20", r.ctx.map.repo)?.mergeMessageId).toBeNull();
  expect(r.journal.getWorker("20", r.ctx.map.repo)?.status).toBe("awaiting-merge");
  expect(attempts).toBe(2);
  expect((await sweep()).mergeDesk?.cards).toEqual(["20"]);
  expect(r.journal.getWorker("20", r.ctx.map.repo)?.mergeMessageId).toBe("retry-card");
 }, 60_000);

 test("needs-eye evidence captures after probes and reaches the card in most-changed pairs with full PR table", async () => {
  const r = await rig({ probe: "fake-probe ok {node}" });
  cleanup.push(r.dir);
  r.github.labels.set(20, ["ranger:needs-eye"]); // manual-merge maps carry evidence too
  Object.assign(r.ctx.map.commands, { views: "capture {label} {out} {origin}", viewsServe: "serve {port}", viewsDiff: "diff {out} {a} {b}" });
  const labels: string[] = [];
  const capturedCwds: string[] = [];
  let stops = 0;
  r.ctx.viewsDependencies = {
   freePort: async () => 45678,
   startServer: async () => ({ stop: async () => { stops++; } }),
   run: async (_bin, args, opts) => {
    expect((r.github.comments.get(1) ?? []).some(c => c.body.includes("ranger:probes") && c.body.includes("result=pass"))).toBe(true);
    expect(r.github.prs.get(1)?.draft).toBe(true); // before ready
    expect(opts?.env?.RANGER_WRITE_TEST).toBeUndefined();
    const command = args[1];
    if (command.startsWith("capture")) {
     const [, label, out] = command.match(/^capture '([^']+)' '([^']+)'/)!;
     labels.push(label);
     capturedCwds.push(opts!.cwd!);
     mkdirSync(join(out, label), { recursive: true });
     for (const view of ["hull", "station", "sky"]) writeFileSync(join(out, label, `${view}.png`), "PNG");
     writeFileSync(join(out, "index.html"), "full contact sheet");
    }
    const noise = command.endsWith("'after' 'after2'");
    return { code: 0, stderr: "", stdout: command.startsWith("diff") ?
     `hull moved >24/255: ${noise ? 0.1 : 2}% any change: 3%\nstation moved >24/255: ${noise ? 0.2 : 5}% any change: 6%\nsky moved >24/255: 0% any change: 0%\n` : "" };
   },
  };
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(labels).toEqual(["before", "after", "after2"]);
  expect(stops).toBe(2);
  expect(capturedCwds[0]).not.toBe(capturedCwds[1]);
  expect(capturedCwds[1]).toBe(capturedCwds[2]);
  expect(existsSync(capturedCwds[0])).toBe(false);
  const pr = await r.github.getPr("acme/widgets", 1);
  const out = viewsDirectory(r.journal.path, r.ctx.map.repo, "20", pr.headSha);
  const comment = (r.github.comments.get(1) ?? []).find(c => c.body.includes("ranger:views"))!.body;
  expect(comment).toContain(`<!-- ranger:views sha=${pr.headSha} -->`);
  expect(comment).toContain("| station | 5.00% | 0.20% |");
  expect(comment).toContain(`${out}/index.html`);
  const posts: { content: string; names: string[] }[] = [];
  const tick = await sweepMap({
   config: r.ctx.config, journal: r.journal, map: r.ctx.map, token: "ghp_write", botIdentity: BOT, github: r.github,
   post: async (content, _label, files) => { posts.push({ content, names: files?.map(f => f.name) ?? [] }); return "views-card"; },
   respawn: async () => DEAD_PID,
  });
  expect(tick.mergeDesk?.cards).toEqual(["20"]);
  expect(posts[0].names).toEqual(["station-before.png", "station-after.png", "hull-before.png", "hull-after.png"]);
  expect(posts[0].content).toContain("sky (change does not exceed single control sample)");

  r.journal.updateWorker("20", r.ctx.map.repo, { mergeMessageId: null });
  const announcer = new DiscordAnnouncer("fake-token", "channel");
  const fromMap = spyOn(DiscordAnnouncer, "fromMap").mockReturnValue(announcer);
  const post = spyOn(announcer, "post").mockResolvedValue("announcer-card");
  try {
   const next = await sweepMap({
    config: r.ctx.config, journal: r.journal, map: r.ctx.map, token: "ghp_write", botIdentity: BOT, github: r.github,
    respawn: async () => DEAD_PID,
   });
   expect(next.mergeDesk?.cards).toEqual(["20"]);
   expect(post).toHaveBeenCalledTimes(1);
   const [, label, files] = post.mock.calls[0];
   expect(label).toBe("merge card for #20");
   expect(files?.map(f => f.name)).toEqual(posts[0].names);
  } finally {
   post.mockRestore();
   fromMap.mockRestore();
  }
 }, 60_000);

 test("configured views do nothing on a non-needs-eye node or after failed probes", async () => {
  for (const probeFails of [false, true]) {
   const r = await rig({ probe: probeFails ? "fake-probe fail {node}" : "fake-probe ok {node}" });
   cleanup.push(r.dir);
   if (probeFails) r.github.labels.set(20, ["ranger:needs-eye"]);
   Object.assign(r.ctx.map.commands, { views: "capture {label} {out} {origin}", viewsServe: "serve {port}", viewsDiff: "diff {out} {a} {b}" });
   r.ctx.viewsDependencies = {
    run: async () => { throw new Error("capture must not run"); },
    startServer: async () => { throw new Error("server must not start"); },
   };
   expect((await runNode("20", r.ctx)).status).toBe(probeFails ? "parked" : "awaiting-merge");
   expect((r.github.comments.get(1) ?? []).some(c => c.body.includes("ranger:views"))).toBe(false);
  }
 }, 60_000);
 // ---- substrate caps (node #45) ----

 test("a session capped mid-build resumes on the next substrate without touching attempts or the dead-man", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  let calls = 0;
  r.ctx.substrate = "claude";
  // The session runs through ctx.worker; without a fixed command, ranger
  // builds each substrate's own and names its pinned model (node #60).
  delete r.ctx.workerCommand;
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
  const row = r.journal.getWorker("20", "acme/widgets");
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
  // The Codex session names the model ranger pins; Claude's is not pinned.
  expect(starts[0].detail).toStartWith("substrate codex (gpt-6.1-sol, high) (");
  expect(starts[1].detail).toStartWith("substrate claude (fixed by the caller)");

  // The capped session's leftovers were dropped; the pushed head is Codex's.
  const head = await r.github.sha("node/20-add-the-feature-module");
  expect(r.journal.headSubstrate("acme/widgets", head)).toBe("codex");
  const files = await runCmd("git", ["ls-tree", "-r", "--name-only", head], { cwd: r.origin });
  expect(files.stdout).not.toContain("half-done.ts");
  // The capped Claude session and the Codex one that finished are both recorded (node #56).
  expect(sessions(r.journal).slice(0, 2)).toEqual([
   ["claude", "worker", "capped"],
   ["codex", "worker", "ok"],
  ]);
  // The session rows carry the pinned model (node #60); the sage rounds do not.
  const db = new Database(join(r.dir, "state.sqlite"), { readonly: true });
  try {
   const models = db.query("SELECT substrate, kind, model FROM substrate_sessions ORDER BY id").all();
   expect(models.slice(0, 2)).toEqual([
    { substrate: "claude", kind: "worker", model: null },
    { substrate: "codex", kind: "worker", model: "gpt-6.1-sol" },
   ]);
   expect(models.filter((m) => (m as { kind: string }).kind === "review").every((m) => (m as { model: unknown }).model === null)).toBe(true);
  } finally {
   db.close();
  }
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
  expect(r.journal.getWorker("20", "acme/widgets")?.attempts).toBe(0);
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
  expect(sessions(r.journal)).toEqual([
   ["claude", "worker", "ok"],
   ["codex", "review", "capped"],
   ["pi", "review", "ok"],
  ]);
 }, 60_000);

 test("a RANGER_WORKER_CMD session runs unlabelled and its review still selects on real quota", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  delete r.ctx.workerCommand;
  // afterEach restores process.env from savedEnv, so this never leaks.
  process.env.RANGER_WORKER_CMD = implementWorker;
  r.ctx.substrateReaders = {
   claude: () => Promise.reject(new Error("down")),
   codex: async () => ({
    substrate: "codex",
    readAt: new Date(),
    windows: [{ kind: "five_hour", usedPct: 10, resetsAt: Math.floor(Date.now() / 1000) + 3600 }],
    capped: false,
    cappedUntil: null,
   }),
  };
  const scripted = r.ctx.reviewer!;
  const reviewSubstrates: (string | undefined)[] = [];
  r.ctx.reviewer = async (repo, pr, token, opts) => {
   reviewSubstrates.push(opts?.substrate);
   return scripted(repo, pr, token, opts);
  };

  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("awaiting-merge");
  // The override's substrate is unknown: no head label (it counts as Pi's),
  // and the review runs on the eligible strong substrate, not on Pi.
  expect(reviewSubstrates).toEqual(["codex"]);
  expect(r.journal.getWorker("20", "acme/widgets")?.substrate).toBeNull();
  const head = await r.github.sha("node/20-add-the-feature-module");
  expect(r.journal.headSubstrate("acme/widgets", head)).toBeNull();
  const start = r.journal
   .listEvents("acme/widgets", 200)
   .find((e) => e.kind === "worker-start" && e.detail?.startsWith("substrate "));
  expect(start?.detail).toContain("substrate unknown (RANGER_WORKER_CMD override");
  // A session on an unknown substrate is not recorded; its review is.
  expect(sessions(r.journal)).toEqual([["codex", "review", "ok"]]);
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
  expect(sessions(r.journal)).toEqual([["codex", "worker", "failed"]]);
 }, 60_000);
});
