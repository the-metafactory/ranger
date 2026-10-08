import { createShadowTestBackend, type ShadowComparison } from "../src/remote-test/shadow.ts";
import { githubCiVerdict } from "../src/github-ci.ts";
import type { CiPurpose, MergeState } from "../src/forge.ts";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
 copyFileSync,
 existsSync,
 mkdirSync,
 mkdtempSync,
 readdirSync,
 readFileSync,
 realpathSync,
 rmSync,
 writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { runCmd } from "../src/exec.ts";
import type { IssueComment, ChangeRequest } from "../src/forge.ts";
import type { CheckRun } from "../src/github.ts";
import { baseMergeMarker, recordedBaseMerges, recordedReviews, reviewMarker, type ForgePort } from "../src/implement.ts";
import { Database } from "bun:sqlite";
import { openJournal, type Journal } from "../src/journal.ts";
import { ReviewError, type ReviewVerdict } from "../src/review.ts";
import { LAST_IMPLEMENT_MAP } from "../src/maps.ts";
import { sweepMap } from "../src/sweep.ts";
import { bootstrapWorktree, runNode, type RunNodeContext } from "../src/worker.ts";
import { keyLabel } from "../src/git-ops.ts";
import { trustCurrentGitState } from "../src/git-trust.ts";
import { baseConfigLines, createCanonicalRepo, fakeDiscord, GIT_ENV, takesRawByteNames } from "./support.ts";
import { saveViewsRecord, viewsDirectory } from "../src/views.ts";
import { DiscordAnnouncer } from "../src/announce.ts";
import { EscalationDiscord } from "../src/discord.ts";
import { workerLogFile } from "../src/worker-log.ts";
import type { TestBackend, TestRequest } from "../src/remote-test/supervisor-backend.ts";
import type { RemoteTestJob, RemoteTestStatus } from "../src/remote-test/contract.ts";
import { randomUUID } from "node:crypto";

const fixturesBin = join(import.meta.dir, "fixtures", "bin");
const dataDir = join(import.meta.dir, "fixtures", "data");
const implementWorker = join(fixturesBin, "implement-worker");
const BOT = "ivy-bot";
const DEAD_PID = 2_147_483_646;

/** In-memory forge over the real bare origin: a PR's head is the origin branch's tip. */
class FakeGitHub implements ForgePort {
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

 private async view(n: number): Promise<ChangeRequest> {
  const pr = this.prs.get(n);
  if (pr === undefined) throw new Error(`no PR #${n}`);
  return {
   iid: n,
   state: pr.merged ? "merged" : pr.state,
   draft: pr.draft,
   title: pr.title,
   mergedBy: pr.mergedBy,
   headRef: pr.head,
   headSha: pr.mergedSha ?? (await this.sha(pr.head)),
   baseRef: pr.base,
   mergeState: pr.merged ? "mergeable" : await this.mergeability(pr.head),
   mergeCommitSha: pr.mergedSha,
   webUrl: `https://github.com/acme/widgets/pull/${n}`,
   author: BOT,
  };
 }

 /** Like GitHub: a trial merge of the head into origin main decides mergeability. */
 private async mergeability(head: string): Promise<MergeState> {
  const trial = await runCmd("git", ["merge-tree", "--write-tree", "main", `refs/heads/${head}`], { cwd: this.origin });
  return trial.code === 0 ? "mergeable" : "conflict";
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
 async markReady(_repo: string, pr: ChangeRequest) {
  const stored = this.prs.get(pr.iid);
  if (stored) stored.draft = false;
 }
 async ciVerdictFor(_repo: string, _sha: string, _token: string, purpose?: CiPurpose) {
  return githubCiVerdict(_repo, this.checkRuns, purpose);
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
 onReview?: (round: number) => void | Promise<void>,
 majors: number[] = [0],
) {
 const calls: number[] = [];
 const reviewer = async (_repo: string, pr: number): Promise<ReviewVerdict> => {
  const round = calls.length + 1;
  calls.push(pr);
  await onReview?.(round);
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
 onReview?: (round: number) => void | Promise<void>;
 /** commands.probe for the map (a fake-probe invocation). */
 probe?: string;
 /** commands.probeRetry for the map. */
 probeRetry?: string;
 /** commands.install for the map. */
 install?: string;
 /** commands.test for the map (default: test -f src/feature.ts). */
 test?: string;
 autoMerge?: boolean;
}): Promise<Rig & { calls: number[]; announced: string[] }> {
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
   `      test: '${opts.test ?? "test -f src/feature.ts"}'`,
   ...(opts.probe === undefined ? [] : [`      probe: '${opts.probe}'`]),
   ...(opts.probeRetry === undefined ? [] : [`      probeRetry: '${opts.probeRetry}'`]),
   ...(opts.install === undefined ? [] : [`      install: '${opts.install}'`]),
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
 const announced: string[] = [];
 const ctx: RunNodeContext = {
  config,
  map: config.maps.find(m => m.root === (opts.root ?? 1))!,
  hostLoad: () => ({ load: 0, cores: 1 }), // a quiet host: the probe tier never waits
  announce: async (text) => announced.push(text),
  token: "ghp_write",
  botIdentity: BOT,
  journal,
  workerCommand: [implementWorker, "build"],
  github,
  reviewer,
  readOnlyToken: "ghp_readonly",
 };
 return { dir, origin, canonical, journal, statePath, ctx, github, calls, announced };
}

/** Inject the backend contract at the real supervisor/adoption seam. */
function remoteBackend(r: Rig, opts: { status?: RemoteTestStatus; mutate?: (request: TestRequest) => Promise<void>; wrongHead?: boolean; infra?: boolean } = {}) {
 const requests: TestRequest[] = [];
 const backend: TestBackend = { kind: "ssh", async run(request) {
  requests.push(request);
  if (opts.infra) return { result: { code: 1, stdout: "", stderr: "Remote infrastructure unavailable" } };
  const tree = await runCmd("git", ["rev-parse", `${request.head}^{tree}`], { cwd: request.worktree });
  const job: RemoteTestJob = { version: 1, jobId: randomUUID(), correlationId: request.correlationId, repositoryId: request.repositoryId, commitDigest: opts.wrongHead ? "f".repeat(40) : request.head, treeDigest: tree.stdout.trim(), bundleDigest: `sha256:${"b".repeat(64)}`, profileId: "fixture", profileDigest: `sha256:${"c".repeat(64)}`, lockDigest: `sha256:${"d".repeat(64)}`, imageDigest: `sha256:${"e".repeat(64)}`, platform: "linux-arm64", deadline: Date.now() + 60_000, generation: request.generation };
  const status = opts.status ?? "passed", receipt = { version: 1 as const, identity: job, executorId: "fixture", status, completedAt: Date.now(), exitCode: status === "passed" ? 0 : 1 };
  const path = join(r.dir, `receipt-${job.jobId}.json`); writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 });
  await opts.mutate?.(request);
  return { result: { code: status === "passed" ? 0 : 1, stdout: "", stderr: `remote ${status}` }, evidence: { job, receipt, path, validUntil: job.deadline } };
 } };
 r.ctx.testBackend = backend;
 return requests;
}

describe("remote supervisor backend integration", () => {
 const cleanup: string[] = [];
 afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
 });
 test("busy-host local retry records the final shadow parity without promoting remote authority", async () => {
  const r = await rig({}); cleanup.push(r.dir);
  const requests = remoteBackend(r), remote = r.ctx.testBackend!, reports: ShadowComparison[] = [];
  const selection = { kind: "shadow" as const, configFile: join(r.dir,"private-ssh.json"), stateRoot: r.dir, reportRoot: r.dir, profileId: "fixture", lockFile: "bun.lock", deadlineSeconds: 660 };
  r.ctx.map.testBackend = selection;
  r.ctx.testBackend = createShadowTestBackend(selection, { remote, write: async report => { reports.push(report); } });
  r.ctx.hostLoad = () => ({ load: 20, cores: 1 }); r.ctx.quietHost = { pollMs: 1, maxMs: 1 };
  let localCalls = 0;
  r.ctx.shellRun = async () => ({ code: ++localCalls === 1 ? 1 : 0, stdout: "", stderr: "real 1.0\nuser 0.5\nsys 0.1\n" });
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(localCalls).toBe(2); expect(requests).toHaveLength(2);
  expect(reports.map(r=>r.parity)).toEqual(["different","same"]);
 }, 60_000);
 test("shadow source mutation refuses push through the real supervisor", async () => {
  const r = await rig({}); cleanup.push(r.dir);
  remoteBackend(r, { mutate: async request => { writeFileSync(join(request.worktree,"src/feature.ts"),"mutated source"); } });
  const remote = r.ctx.testBackend!;
  const selection = { kind: "shadow" as const, configFile: join(r.dir,"private-ssh.json"), stateRoot: r.dir, reportRoot: r.dir, profileId: "fixture", lockFile: "bun.lock", deadlineSeconds: 660 };
  r.ctx.map.testBackend = selection;
  r.ctx.testBackend = createShadowTestBackend(selection, { remote, write: async () => {} });
  expect((await runNode("20", r.ctx)).status).toBe("failed"); expect(r.github.prs.size).toBe(0);
 }, 60_000);
 test("shadow map refuses an injected SSH-authoritative backend", async () => {
  const r = await rig({}); cleanup.push(r.dir);
  remoteBackend(r);
  r.ctx.map.testBackend = { kind: "shadow", configFile: join(r.dir,"private-ssh.json"), stateRoot: r.dir, reportRoot: r.dir, profileId: "fixture", lockFile: "bun.lock", deadlineSeconds: 660 };
  expect((await runNode("20", r.ctx)).status).not.toBe("awaiting-merge");
  expect(r.github.prs.size).toBe(0);
 }, 60_000);
 for (const localFails of [false, true]) {
  test(`shadow keeps local ${localFails ? "failure" : "success"} authoritative through the real supervisor`, async () => {
   const r = await rig({ test: localFails ? "exit 7" : "test -f src/feature.ts" }); cleanup.push(r.dir);
   const requests = remoteBackend(r, { status: localFails ? "passed" : "test_failed" });
   const remote = r.ctx.testBackend!, reports: ShadowComparison[] = [];
   const selection = { kind: "shadow" as const, configFile: join(r.dir,"private-ssh.json"), stateRoot: r.dir, reportRoot: r.dir, profileId: "fixture", lockFile: "bun.lock", deadlineSeconds: 660 };
   r.ctx.map.testBackend = selection;
   r.ctx.testBackend = createShadowTestBackend(selection, { remote, write: async report => { reports.push(report); } });
   const outcome = await runNode("20", r.ctx);
   expect(outcome.status).toBe(localFails ? "failed" : "awaiting-merge");
   expect(r.github.prs.size).toBe(localFails ? 0 : 1);
   expect(requests).toHaveLength(1); expect(reports).toHaveLength(1);
   expect(reports[0]!.parity).toBe("different");
   expect(reports[0]!.local.laptopCpuSeconds).toBeGreaterThanOrEqual(0);
   expect(r.journal.listEvents("acme/widgets",200).some(e=>e.detail?.includes("remote matched; outcome different; coverage pending; report saved"))).toBe(true);
   expect(r.journal.listEvents("acme/widgets",200).some(e=>e.detail?.startsWith("remote supervisor tests: passed"))).toBe(false);
  }, 60_000);
 }
 test("opt-in skips local install/test calls and pushes only the validated committed HEAD", async () => {
  const r = await rig({ install: "exit 91", test: "exit 92" }); cleanup.push(r.dir);
  r.ctx.map.testBackend = { kind: "ssh", configFile: join(r.dir, "private-ssh.json"), stateRoot: join(r.dir, "private-state"), profileId: "fixture", lockFile: "bun.lock", deadlineSeconds: 660 };
  const prompts: string[] = [];
  r.ctx.worker = async (prompt, options) => {
   prompts.push(prompt);
   expect(JSON.stringify(options.env)).not.toContain("private-ssh.json");
   expect(JSON.stringify(options.env)).not.toContain("private-state");
   return runCmd(implementWorker, ["build", prompt], options);
  };
  const requests = remoteBackend(r);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(requests).toHaveLength(1);
  expect(prompts[0]).toContain("Do not run those commands locally");
  expect(prompts[0]).not.toContain("private-ssh.json");
  expect((await r.github.getPr("acme/widgets", 1)).headSha).toBe(requests[0]!.head);
  const events = r.journal.listEvents("acme/widgets", 200).map(e => e.detail ?? "");
  expect(events.filter(d => d.startsWith("remote supervisor tests:")).length).toBe(1);
  expect(events.find(d => d.startsWith("remote supervisor tests:"))).toMatch(/^remote supervisor tests: passed; receipt /);
 }, 60_000);
 for (const failure of ["wrong-head", "dirty", "moved-head", "infra", "test-failed"] as const) {
  test(`${failure} refuses before push and never retries locally even on a busy host`, async () => {
   const r = await rig({}); cleanup.push(r.dir); r.ctx.hostLoad = () => ({ load: 20, cores: 1 }); r.ctx.quietHost = { pollMs: 1, maxMs: 1 };
   const requests = remoteBackend(r, { wrongHead: failure === "wrong-head", infra: failure === "infra", ...(failure === "test-failed" ? { status: "test_failed" as const } : {}),
    mutate: failure === "dirty" ? async request => { writeFileSync(join(request.worktree, "dirty"), "x"); } : failure === "moved-head" ? async request => { await runCmd("git", ["commit", "--allow-empty", "-m", "HEAD moved"], { cwd: request.worktree, env: { ...process.env, ...GIT_ENV } }); } : undefined });
   let local = 0; r.ctx.shellRun = async () => { local++; return { code: 0, stdout: "", stderr: "" }; };
   expect((await runNode("20", r.ctx)).status).toBe("failed"); expect(r.github.prs.size).toBe(0); expect(requests).toHaveLength(1); expect(local).toBe(0);
  }, 60_000);
 }
 test("resume adopts an existing clean commit with remote tests and no local install/retry/restore", async () => {
  const r = await rig({ test: "exit 1" }); cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("failed");
  r.ctx.map.commands.install = "exit 91";
  const requests = remoteBackend(r);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge"); expect(requests).toHaveLength(1);
  expect(r.journal.listEvents("acme/widgets", 200).some(e => e.detail?.startsWith("adopting "))).toBe(true);
 }, 60_000);
 test("an adoption infrastructure failure stops without a fresh coding session", async () => {
  const r = await rig({ test: "exit 1" }); cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("failed");
  const requests = remoteBackend(r, { infra: true }); let workers = 0;
  r.ctx.worker = async () => { workers++; return { code: 0, stdout: "", stderr: "" }; };
  expect((await runNode("20", r.ctx)).status).toBe("failed"); expect(requests).toHaveLength(1); expect(workers).toBe(0); expect(r.github.prs.size).toBe(0);
 }, 60_000);
 test("a superseded remote test generation cannot push or record success", async () => {
  const r = await rig({}); cleanup.push(r.dir);
  const requests = remoteBackend(r, { mutate: async () => { r.journal.beginGeneration("20", "acme/widgets"); } });
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("refused"); expect(requests).toHaveLength(1); expect(r.github.prs.size).toBe(0);
  expect(r.journal.listEvents("acme/widgets", 200).some(e => e.detail?.startsWith("remote supervisor tests: passed"))).toBe(false);
 }, 60_000);
 test("remote tests cannot tamper with trusted Git config before push", async () => {
  const r = await rig({}); cleanup.push(r.dir);
  const requests = remoteBackend(r, { mutate: async request => { await runCmd("git", ["config", "http.sslVerify", "false"], { cwd: request.worktree }); } });
  expect((await runNode("20", r.ctx)).status).toBe("parked"); expect(requests).toHaveLength(1); expect(r.github.prs.size).toBe(0);
 }, 60_000);
 test("remote fix pass tests its new commit and publishes it without local installs/tests", async () => {
  const r = await rig({ blockers: [1, 0], install: "exit 91", test: "exit 92" }); cleanup.push(r.dir);
  const requests = remoteBackend(r);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge"); expect(requests).toHaveLength(2);
  expect(requests[0]!.head).not.toBe(requests[1]!.head);
  expect((await r.github.getPr("acme/widgets", 1)).headSha).toBe(requests[1]!.head);
  expect(r.calls).toHaveLength(2);
 }, 60_000);
 test("remote base-merge pass tests and publishes merged source without local reinstall", async () => {
  let r!: Rig & { calls: number[]; announced: string[] };
  r = await rig({ install: "exit 91", test: "exit 92", onReview: async round => { if (round === 1) await moveBaseUnder(r); } }); cleanup.push(r.dir);
  r.ctx.mergeablePoll = { pollMs: 1, attempts: 2 };
  const requests = remoteBackend(r);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge"); expect(requests).toHaveLength(2);
  expect(requests[0]!.head).not.toBe(requests[1]!.head);
  expect((await r.github.getPr("acme/widgets", 1)).headSha).toBe(requests[1]!.head);
  expect((await r.github.getPr("acme/widgets", 1)).mergeState).toBe("mergeable");
  expect(r.calls).toHaveLength(2);
 }, 60_000);
 test("tampered persisted fix-pass receipt is refused by the second pre-push gate", async () => {
  const r = await rig({ blockers: [1, 0] }); cleanup.push(r.dir);
  const requests = remoteBackend(r), record = r.journal.recordEvent.bind(r.journal);
  let accepted = 0;
  const spy = spyOn(r.journal, "recordEvent").mockImplementation((kind, event) => {
   const result = record(kind, event);
   const prefix = "remote supervisor tests: passed; receipt ";
   // This hook runs after backend validation, before publishPass. The
   // ordinary build push succeeds; only the later fix receipt is changed.
   const detail = event?.detail;
   if (detail?.startsWith(prefix) && ++accepted === 2) {
    const path = detail.slice(prefix.length), receipt = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...receipt, status: "test_failed", exitCode: 1 }));
   }
   return result;
  });
  try {
   const outcome = await runNode("20", r.ctx);
   expect(outcome.status).toBe("parked"); expect(outcome.detail).toContain("receipt is no longer current");
   expect(requests).toHaveLength(2);
   expect((await r.github.getPr("acme/widgets", 1)).headSha).toBe(requests[0]!.head);
  } finally { spy.mockRestore(); }
 }, 60_000);
});

/** Land the probes (default scripts/probe-hud.mjs) on origin's main and fetch them, so the merge base has them. */
async function seedProbeOnBase(r: Rig, names: string[] = ["probe-hud.mjs"]): Promise<void> {
 const seed = join(r.dir, "seed");
 const git = (args: string[], cwd: string) => runCmd("git", args, { cwd, env: { ...process.env, ...GIT_ENV } });
 mkdirSync(join(seed, "scripts"), { recursive: true });
 for (const name of names) writeFileSync(join(seed, "scripts", name), `// ${name}\n`);
 await git(["add", "-A"], seed);
 await git(["commit", "-m", "add the probes"], seed);
 expect((await git(["push", r.origin, "main"], seed)).code).toBe(0);
 expect((await git(["fetch", "origin"], r.canonical)).code).toBe(0);
}

/** Land a commit on origin's main that conflicts with the worker's src/feature.ts (the base moved under the node). */
async function moveBaseUnder(r: Rig): Promise<void> {
 const seed = join(r.dir, "seed");
 const git = (args: string[]) => runCmd("git", args, { cwd: seed, env: { ...process.env, ...GIT_ENV } });
 await git(["pull", "-q", r.origin, "main"]);
 mkdirSync(join(seed, "src"), { recursive: true });
 writeFileSync(join(seed, "src", "feature.ts"), "export const fromMain = true;\n");
 await git(["add", "-A"]);
 await git(["commit", "-m", "main lands its own feature.ts"]);
 expect((await git(["push", r.origin, "HEAD:main"])).code).toBe(0);
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

 test("the worker session and the test command get one per-session temp journal, never the live one (node #66)", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  const workerJournals: (string | undefined)[] = [];
  const shellCalls: { command: string; journal: string | undefined }[] = [];
  r.ctx.worker = async (prompt, opts) => {
   workerJournals.push(opts.env?.RANGER_JOURNAL_PATH);
   return runCmd(implementWorker, ["build", prompt], opts);
  };
  r.ctx.shellRun = (command, opts) => {
   shellCalls.push({ command, journal: opts.env?.RANGER_JOURNAL_PATH });
   return runCmd("/bin/sh", ["-c", command], opts);
  };
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(workerJournals).toHaveLength(1);
  const session = workerJournals[0] as string;
  expect(session.startsWith(tmpdir())).toBe(true);
  expect(session).not.toBe(r.journal.path);
  expect(session).not.toContain(join(".config", "ranger"));
  const test = shellCalls.find((c) => c.command === "test -f src/feature.ts");
  expect(test?.journal).toBe(session);
  for (const call of shellCalls) expect(call.journal).toBe(session);
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

 // Node #81: the supervisor's tests run worker-written code. A failed run's
 // change to the shared git config must not become the next run's trusted
 // starting point.
 describe("known-good git state across runs (node #81)", () => {
  const TAMPER = "git config http.sslVerify false; exit 1";
  const git = (args: string[], cwd: string) => runCmd("git", args, { cwd, env: { ...process.env, ...GIT_ENV } });
  const fetchedMain = async (r: Rig) => (await git(["rev-parse", "refs/remotes/origin/main"], r.canonical)).stdout.trim();
  /** Move origin main, so a credentialed fetch by the next run would show. */
  const moveOriginMain = async (r: Rig) => {
   const seed = join(r.dir, "seed");
   writeFileSync(join(seed, "NOTES.md"), "later\n");
   await git(["add", "-A"], seed);
   await git(["commit", "-m", "later on main"], seed);
   expect((await git(["push", r.origin, "HEAD:main"], seed)).code).toBe(0);
  };

  test("a failed test run that sets http.sslVerify parks the resume at the implement phase before any credentialed git call", async () => {
   const r = await rig({});
   cleanup.push(r.dir);
   r.ctx.map.commands.test = TAMPER;
   const first = await runNode("20", r.ctx);
   expect(first.status).toBe("failed");
   expect(first.detail).toContain("tests (");
   expect((await git(["config", "--get", "http.sslVerify"], r.canonical)).stdout.trim()).toBe("false");

   r.ctx.map.commands.test = "test -f src/feature.ts";
   await moveOriginMain(r);
   const fetched = await fetchedMain(r);
   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   const resumed = await runNode("20", r.ctx);
   expect(resumed.status).toBe("parked");
   expect(resumed.detail).toContain("http.sslverify (new)");
   expect(resumed.detail).toContain("ranger trust-git --map acme/widgets#1");
   expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("parked");
   expect(r.journal.getWorker("20", "acme/widgets")?.outcome).toContain("http.sslverify");
   expect(r.journal.deadmanCount()).toBe(1); // the failed run only; a park is not a crash
   // Nothing ran under the credential: no fetch, no push, no PR.
   expect(await fetchedMain(r)).toBe(fetched);
   expect(await r.github.sha("node/20-add-the-feature-module")).toBe("");
   expect(r.github.prs.size).toBe(0);

   // Parked again on the next resume: the changed state was not adopted.
   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   expect((await runNode("20", r.ctx)).status).toBe("parked");

   // The operator vets the change and trusts it; the node then runs (from a
   // clean branch: the fake worker cannot commit the same build twice).
   const { hash } = await trustCurrentGitState(r.journal, r.canonical, "acme/widgets");
   await trustCurrentGitState(r.journal, r.canonical, "acme/widgets", hash);
   await git(["reset", "--hard", "refs/remotes/origin/main"], join(r.canonical, ".worktrees", "node-20"));
   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
   expect(await fetchedMain(r)).not.toBe(fetched);
  }, 60_000);

  test("a failed test run that sets http.sslVerify parks the adoption of its committed work before any credentialed git call", async () => {
   const r = await rig({});
   cleanup.push(r.dir);
   r.ctx.map.commands.test = TAMPER;
   expect((await runNode("20", r.ctx)).status).toBe("failed"); // built and committed; the tests tamper and fail
   expect((await git(["config", "--get", "http.sslVerify"], r.canonical)).stdout.trim()).toBe("false");

   r.ctx.map.commands.test = "test -f src/feature.ts"; // the committed work would now pass adoption
   r.ctx.workerCommand = [implementWorker, "noop"]; // a worker session would commit nothing and fail, not park
   await moveOriginMain(r);
   const fetched = await fetchedMain(r);
   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   const resumed = await runNode("20", r.ctx);
   expect(resumed.status).toBe("parked");
   expect(resumed.detail).toContain("http.sslverify (new)");
   const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
   expect(events.some((d) => d.startsWith("adopting "))).toBe(false);
   expect(await fetchedMain(r)).toBe(fetched);
   expect(await r.github.sha("node/20-add-the-feature-module")).toBe("");
   expect(r.github.prs.size).toBe(0);
  }, 60_000);

  test("a failed fix-pass test run that sets http.sslVerify parks the resume at the review phase before its push", async () => {
   const r = await rig({ blockers: [1, 0] });
   cleanup.push(r.dir);
   // Passes on the build; the fix pass's tests change the config and fail.
   r.ctx.map.commands.test = `test -f src/feature.ts && if grep -q fixed src/feature.ts; then ${TAMPER}; fi`;
   const first = await runNode("20", r.ctx);
   expect(first.status).toBe("failed");
   expect(first.detail).toContain("tests (");
   const pushed = await r.github.sha("node/20-add-the-feature-module");
   expect(pushed).not.toBe("");
   expect(r.github.comments.get(1)).toHaveLength(1); // round 1

   r.ctx.map.commands.test = "test -f src/feature.ts";
   await moveOriginMain(r);
   const fetched = await fetchedMain(r);
   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   const resumed = await runNode("20", r.ctx);
   expect(resumed.status).toBe("parked");
   expect(resumed.detail).toContain("http.sslverify (new)");
   expect(await fetchedMain(r)).toBe(fetched);
   expect(await r.github.sha("node/20-add-the-feature-module")).toBe(pushed);
   expect(r.github.comments.get(1)).toHaveLength(1);
   expect(r.calls).toHaveLength(1);
  }, 60_000);

  test("a parallel node's worktree created between runs parks nothing", async () => {
   const r = await rig({});
   cleanup.push(r.dir);
   // An operator setting under which a tracked branch gains a rebase line
   // beside the remote + merge pair, which the node #63 filter keeps.
   expect((await git(["config", "branch.autoSetupRebase", "always"], r.canonical)).code).toBe(0);
   r.ctx.workerCommand = [implementWorker, "noop"];
   expect((await runNode("20", r.ctx)).status).toBe("failed");

   await bootstrapWorktree(r.canonical, "21", "another-node", "tok");
   expect((await git(["config", "--get-regexp", "^branch\\.node/21-"], r.canonical)).stdout.trim()).toBe("");

   r.ctx.workerCommand = [implementWorker, "build"];
   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  }, 60_000);

  // Git copies the main config.worktree into each new worktree when
  // extensions.worktreeConfig is on; the copy is not a change.
  test("a checkout with per-worktree config runs through, and a parallel node's worktree between runs parks nothing", async () => {
   const r = await rig({});
   cleanup.push(r.dir);
   expect((await git(["config", "extensions.worktreeConfig", "true"], r.canonical)).code).toBe(0);
   expect((await git(["config", "--worktree", "ranger.probe", "kept"], r.canonical)).code).toBe(0);
   r.ctx.workerCommand = [implementWorker, "noop"];
   expect((await runNode("20", r.ctx)).status).toBe("failed");
   expect(readFileSync(join(r.canonical, ".git", "worktrees", "node-20", "config.worktree"), "utf8")).toContain("probe = kept");

   await bootstrapWorktree(r.canonical, "21", "another-node", "tok");
   r.ctx.workerCommand = [implementWorker, "build"];
   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  }, 60_000);

  test("a credential-bearing key added between runs parks the node without its text reaching the outcome or the journal", async () => {
   const r = await rig({});
   cleanup.push(r.dir);
   r.ctx.workerCommand = [implementWorker, "noop"];
   expect((await runNode("20", r.ctx)).status).toBe("failed");

   expect((await git(["config", "url.https://bot:SECRETTOKEN@github.com/.insteadOf", "https://github.com/"], r.canonical)).code).toBe(0);
   r.ctx.workerCommand = [implementWorker, "build"];
   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   const parked = await runNode("20", r.ctx);
   expect(parked.status).toBe("parked");
   expect(parked.detail).toMatch(/url\.<[0-9a-f]{12}>\.insteadof \(new\)/);
   expect(parked.detail).not.toContain("SECRETTOKEN");
   expect(r.journal.getWorker("20", "acme/widgets")?.outcome).not.toContain("SECRETTOKEN");
   expect(r.journal.knownGoodGitState(r.canonical)).not.toContain("SECRETTOKEN");
   for (const event of r.journal.listEvents("acme/widgets", 500)) expect(JSON.stringify(event)).not.toContain("SECRETTOKEN");
  }, 60_000);

  // Includes fail closed: no code follows an include path, the key parks.
  test("a failed test run that adds an include.path to the shared config parks the resume before any credentialed git call, naming the key", async () => {
   const r = await rig({});
   cleanup.push(r.dir);
   r.ctx.map.commands.test = "git config include.path /tmp/evil.gitconfig; exit 1";
   expect((await runNode("20", r.ctx)).status).toBe("failed");

   r.ctx.map.commands.test = "test -f src/feature.ts";
   await moveOriginMain(r);
   const fetched = await fetchedMain(r);
   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   const resumed = await runNode("20", r.ctx);
   expect(resumed.status).toBe("parked");
   expect(resumed.detail).toStartWith("git config include refused: include.path in config");
   expect(await fetchedMain(r)).toBe(fetched);
   expect(await r.github.sha("node/20-add-the-feature-module")).toBe("");
   // trust-git cannot adopt it: the operator removes the line.
   await expect(trustCurrentGitState(r.journal, r.canonical, "acme/widgets")).rejects.toThrow(/include refused/);
  }, 60_000);

  test("an includeIf.<cond>.path in the main config.worktree parks the next run before its push, naming the key", async () => {
   const r = await rig({});
   cleanup.push(r.dir);
   expect((await git(["config", "extensions.worktreeConfig", "true"], r.canonical)).code).toBe(0);
   r.ctx.workerCommand = [implementWorker, "noop"];
   expect((await runNode("20", r.ctx)).status).toBe("failed");

   expect((await git(["config", "--worktree", "includeIf.onbranch:main.path", "/tmp/evil.gitconfig"], r.canonical)).code).toBe(0);
   r.ctx.workerCommand = [implementWorker, "build"];
   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   const parked = await runNode("20", r.ctx);
   expect(parked.status).toBe("parked");
   expect(parked.detail).toContain(`${keyLabel("includeif.onbranch:main.path")} in config.worktree`);
   expect(await r.github.sha("node/20-add-the-feature-module")).toBe("");
   expect(r.github.prs.size).toBe(0);
  }, 60_000);

  // Sage round 5 on node #86: a state ranger cannot read to vet threw past
  // the park, so the run counted as a crash toward the dead-man pause.
  // APFS refuses names that are not UTF-8 (EILSEQ); ext4 (CI) takes them.
  test.skipIf(!takesRawByteNames())("a hook name that is not UTF-8 between runs parks the node, outside the dead-man", async () => {
   const r = await rig({});
   cleanup.push(r.dir);
   r.ctx.workerCommand = [implementWorker, "noop"];
   expect((await runNode("20", r.ctx)).status).toBe("failed");
   const deadman = r.journal.deadmanCount();

   writeFileSync(Buffer.concat([Buffer.from(join(r.canonical, ".git", "hooks", "pre-push")), Buffer.from([0xfe])]), "#!/bin/sh\n");
   r.ctx.workerCommand = [implementWorker, "build"];
   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   const parked = await runNode("20", r.ctx);
   expect(parked.status).toBe("parked");
   expect(parked.detail).toMatch(/not UTF-8/);
   expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("parked");
   expect(r.journal.deadmanCount()).toBe(deadman);
   expect(await r.github.sha("node/20-add-the-feature-module")).toBe("");
  }, 60_000);

  test("a journal without a record keeps today's behaviour: the run records the state and says so", async () => {
   const r = await rig({});
   cleanup.push(r.dir);
   expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
   const trust = r.journal.listEvents("acme/widgets", 500).filter((e) => e.kind === "git-trust");
   expect(trust).toHaveLength(1);
   expect(trust[0].detail).toContain("no known-good git state recorded");
   const record = JSON.parse(r.journal.knownGoodGitState(r.canonical) as string);
   expect(record.source).toBe("vetted push");
  }, 60_000);
 });

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

 for (const startStatus of ["resume", "failed", "parked", "awaiting-merge"] as const) {
  const viaSweep = startStatus !== "resume";
  for (const prState of ["merged", "open", "closed"] as const) {
   test(`closed elsewhere: ${viaSweep ? `sweep ${startStatus} row` : "resume close"} with ${prState} PR finishes without graphClose`, async () => {
    const r = await rig({}); cleanup.push(r.dir);
    expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
    if (prState === "merged") await r.github.merge(1);
    else if (prState === "closed") r.github.prs.get(1)!.state = "closed";
    const file = join(r.dir, "data", "acme__widgets-node-20.json");
    const node = JSON.parse(readFileSync(file, "utf8"));
    node.status = "closed";
    node.node.completion = { closer: "jcfischer", receiptCommentId: "900", closedAt: new Date().toISOString() };
    writeFileSync(file, JSON.stringify(node));
    r.journal.updateWorker("20", "acme/widgets", { status: startStatus === "resume" ? "failed" : startStatus, phase: "close", outcome: "HTTP 500" });
    if (startStatus === "failed" && prState === "merged") r.journal.updateWorker("20", "acme/widgets", { prNumber: null });
    const callsFile = join(r.dir, "graph-calls"); process.env.FAKE_SOMA_CALLS = callsFile;
    const ci = spyOn(r.github, "ciVerdictFor").mockImplementation(async () => { throw new Error("HTTP 500"); });
    try {
     if (viaSweep) {
      await sweepMap({ ...r.ctx, phase: "liveness", respawn: async () => { throw new Error("must not spawn"); } });
     } else {
      expect((await runNode("20", r.ctx)).status).toBe(prState === "merged" ? "success" : "released");
     }
     expect(r.journal.getWorker("20", "acme/widgets")).toMatchObject({ status: prState === "merged" ? "success" : "released", pid: null, workerPgid: null });
     expect(r.journal.getWorker("20", "acme/widgets")?.finishedAt).not.toBeNull();
     expect(readFileSync(callsFile, "utf8")).not.toContain("close acme/widgets");
     expect(ci).not.toHaveBeenCalled();
     const events = r.journal.listEvents("acme/widgets", 500).filter(e => e.kind === "closed-elsewhere");
     expect(events).toHaveLength(1);
     expect(events[0]?.detail).toContain("jcfischer");
     expect(events[0]?.detail).toContain("https://github.com/acme/widgets/issues/20#issuecomment-900");
     if (prState === "merged") expect(existsSync(join(r.canonical, ".worktrees", "node-20"))).toBe(false);
    } finally { ci.mockRestore(); }
   }, 60_000);
  }
 }

 test.each(["resume", "sweep"])("closed research node discovers its merged PR without a recorded number via %s", async via => {
  const r = await rig({}); cleanup.push(r.dir);
  const branch = "research/api-survey";
  const worktree = await bootstrapWorktree(r.canonical, "20", "api-survey", r.ctx.token, branch);
  expect((await runCmd("git", ["push", "origin", branch], { cwd: worktree })).code).toBe(0);
  await r.github.createDraftPr("acme/widgets", { head: branch, base: "main", title: "Survey API", body: "Findings" });
  await r.github.merge(1);
  const file = join(r.dir, "data", "acme__widgets-node-20.json");
  const node = JSON.parse(readFileSync(file, "utf8"));
  node.status = "closed"; node.node.kind = "research";
  node.node.probes = [{ type: "git-ref-exists", ref: branch }];
  node.node.completion = { closer: "jcfischer", receiptCommentId: "900", closedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(node));
  r.journal.updateWorker("20", "acme/widgets", { status: "failed", phase: "close", lane: "research", worktree, prNumber: null });
  const calls = join(r.dir, "graph-calls"); process.env.FAKE_SOMA_CALLS = calls;
  r.ctx.worker = async () => { throw new Error("must not start another research session"); };
  if (via === "resume") expect((await runNode("20", r.ctx)).status).toBe("success");
  else await sweepMap({ ...r.ctx, phase: "liveness" });
  expect(r.journal.getWorker("20", "acme/widgets")).toMatchObject({ status: "success", worktree: null });
  expect(existsSync(worktree)).toBe(false);
  expect(readFileSync(calls, "utf8")).not.toContain("close acme/widgets");
 }, 60_000);

 test.each(["resume", "sweep"])("recovers ranger's own graph close honestly via %s", async via => {
  const r = await rig({}); cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  await r.github.merge(1);
  const file = join(r.dir, "data", "acme__widgets-node-20.json");
  const node = JSON.parse(readFileSync(file, "utf8")); node.status = "closed";
  node.node.completion = { closer: BOT, receiptCommentId: "901", closedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(node));
  r.journal.updateWorker("20", "acme/widgets", { status: "failed", phase: "close" });
  const calls = join(r.dir, "calls"); process.env.FAKE_SOMA_CALLS = calls;
  if (via === "resume") expect((await runNode("20", r.ctx)).status).toBe("success");
  else await sweepMap({ ...r.ctx, phase: "liveness" });
  expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("success");
  expect(r.journal.listEvents("acme/widgets", 500).some(e => e.kind === "closed-elsewhere")).toBe(false);
  expect(r.journal.listEvents("acme/widgets", 500).find(e => e.kind === "closed")?.detail).toContain(`recovered ranger close by ${BOT}`);
  expect(readFileSync(calls, "utf8")).not.toContain("close acme/widgets");
  expect(existsSync(join(r.canonical, ".worktrees", "node-20"))).toBe(false);
 }, 60_000);

 test.each([undefined, "jcfischer", BOT])("close phase re-reads closure before CI and preserves external deadman (closer %s)", async closer => {
  const r = await rig({}); cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  await r.github.merge(1);
  r.journal.bumpDeadman(); r.journal.bumpDeadman();
  const file = join(r.dir, "data", "acme__widgets-node-20.json");
  const getPr = r.github.getPr.bind(r.github);
  const prSpy = spyOn(r.github, "getPr").mockImplementation(async (...args) => {
   const node = JSON.parse(readFileSync(file, "utf8")); node.status = "closed";
   if (closer !== undefined) node.node.completion = { closer, receiptCommentId: "900", closedAt: new Date().toISOString() };
   writeFileSync(file, JSON.stringify(node));
   return getPr(...args);
  });
  const ciSpy = spyOn(r.github, "ciVerdictFor").mockImplementation(async () => { throw new Error("HTTP 500"); });
  const callsFile = join(r.dir, "calls"); process.env.FAKE_SOMA_CALLS = callsFile;
  try {
   expect((await runNode("20", r.ctx)).status).toBe("success");
   expect(ciSpy).not.toHaveBeenCalled();
   expect(r.journal.deadmanCount()).toBe(closer === BOT ? 0 : 2);
   expect(readFileSync(callsFile, "utf8")).not.toContain("close acme/widgets");
  } finally { prSpy.mockRestore(); ciSpy.mockRestore(); }
 }, 60_000);

 test("close-phase budget deferral records failed and allows sweep recovery without a deadman failure", async () => {
  const r = await rig({}); cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  await r.github.merge(1);
  process.env.FAKE_GH_GRAPHQL_REMAINING = "0";
  r.journal.bumpDeadman();
  const ci = spyOn(r.github, "ciVerdictFor").mockImplementation(async () => { throw new Error("must defer before CI"); });
  try {
   const outcome = await runNode("20", r.ctx);
   expect(outcome.status).toBe("failed");
   expect(outcome.detail).toContain("GraphQL");
   expect(r.journal.getWorker("20", "acme/widgets")).toMatchObject({
    status: "failed", phase: "close", pid: null, workerPgid: null, outcome: outcome.detail,
   });
   expect(r.journal.getWorker("20", "acme/widgets")?.finishedAt).not.toBeNull();
   expect(r.journal.deadmanCount()).toBe(1);
   expect(ci).not.toHaveBeenCalled();
   delete process.env.FAKE_GH_GRAPHQL_REMAINING;
   const cooldown = JSON.parse(r.journal.getHealth("ratelimit:write-token")!);
   cooldown.until = new Date(Date.now() - 1).toISOString();
   r.journal.setHealth("ratelimit:write-token", JSON.stringify(cooldown));
   const file = join(r.dir, "data", "acme__widgets-node-20.json");
   const node = JSON.parse(readFileSync(file, "utf8")); node.status = "closed";
   node.node.completion = { closer: "jcfischer", receiptCommentId: "900", closedAt: new Date().toISOString() };
   writeFileSync(file, JSON.stringify(node));
   await sweepMap({ ...r.ctx, phase: "liveness" });
   expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("success");
   expect(r.journal.deadmanCount()).toBe(1);
   expect(ci).not.toHaveBeenCalled();
  } finally { ci.mockRestore(); }
 }, 60_000);

 test.each([false, true])("sweep finishes a failed worker and closes its escalation card exactly once (Discord outage: %s)", async deferCard => {
  const r = await rig({}); cleanup.push(r.dir);
  const discord = fakeDiscord();
  try {
   expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
   await r.github.merge(1);
   const file = join(r.dir, "data", "acme__widgets-node-20.json");
   const node = JSON.parse(readFileSync(file, "utf8")); node.status = "closed";
   node.node.completion = { closer: "jcfischer", receiptCommentId: "900", closedAt: new Date().toISOString() };
   writeFileSync(file, JSON.stringify(node));
   process.env.RANGER_DISCORD_TOKEN = "fake-token";
   process.env.RANGER_DISCORD_API_BASE = `http://127.0.0.1:${discord.port}`;
   process.env.RANGER_DISCORD_ALLOW_TEST_OVERRIDE = "1";
   process.env.RANGER_DISCORD_MIN_INTERVAL_MS = "1";
   r.journal.upsertEscalation({ key: "acme/widgets:20", repo: "acme/widgets", root: 1, nodeId: "20", title: "Feature", channelId: r.ctx.map.discord!.channelId,
    messageId: "existing-card", createdAt: new Date().toISOString(), status: "open" });
   r.journal.updateWorker("20", "acme/widgets", { status: "failed", phase: "close" });
   if (deferCard) {
    const edit = spyOn(EscalationDiscord.prototype, "edit").mockImplementation(async () => { throw new Error("Discord unavailable"); });
    try {
     await sweepMap({ ...r.ctx, phase: "liveness" });
     expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("success");
     expect(r.journal.getEscalation("acme/widgets", "20")?.status).toBe("open");
     expect(discord.edits).toHaveLength(0);
    } finally { edit.mockRestore(); }
   }
   await sweepMap({ ...r.ctx, phase: "liveness" });
   expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("success");
   expect(r.journal.getEscalation("acme/widgets", "20")?.status).toBe("closed");
   expect(discord.edits).toHaveLength(1);
   expect(r.journal.getEscalation("acme/widgets", "20")?.lastContent).toContain("closed on the graph");
   await sweepMap({ ...r.ctx, phase: "liveness" });
   expect(discord.edits).toHaveLength(1);
   expect(r.journal.listEvents("acme/widgets", 500).filter(e => e.kind === "closed-elsewhere")).toHaveLength(1);
  } finally { discord.stop(); }
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
  expect(s.lastClose.evidence.map((e: { pointer: string }) => e.pointer)).toEqual([
   "https://github.com/acme/widgets/pull/1", "https://github.com/acme/widgets/runs/101",
  ]);
  const kinds = r.journal.listEvents("acme/widgets", 500).map((e) => e.kind);
  expect(kinds.filter((k) => k === "decisions-written")).toHaveLength(1);
  expect(kinds).not.toContain("decisions-failed");
 }, 60_000);

 test("propose close cites the forge's change-request and CI URLs", async () => {
  const r = await rig({ autonomy: "propose" });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  await r.github.merge(1);
  const changeUrl = "https://forge.example/group/widgets/changes/1";
  const runUrl = "https://forge.example/group/widgets/jobs/101";
  const getPr = r.github.getPr.bind(r.github);
  const getCi = r.github.ciVerdictFor.bind(r.github);
  const prSpy = spyOn(r.github, "getPr").mockImplementation(async (...args) => ({ ...await getPr(...args), webUrl: changeUrl }));
  const ciSpy = spyOn(r.github, "ciVerdictFor").mockImplementation(async (...args) => {
   const ci = await getCi(...args);
   return ci.state === "green" ? { ...ci, runUrl } : ci;
  });
  try {
   r.journal.updateWorker("20", "acme/widgets", { status: "running" });
   expect((await runNode("20", r.ctx)).status).toBe("success");
   expect(state(r.statePath).lastClose.evidence.map((e: { pointer: string }) => e.pointer)).toEqual([changeUrl, runUrl]);
  } finally {
   prSpy.mockRestore();
   ciSpy.mockRestore();
  }
 }, 60_000);

 test("a failed decisions write after the close records decisions-failed only, and the close still succeeds (node #108)", async () => {
  const r = await rig({ autonomy: "propose" });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  await r.github.merge(1);
  r.journal.updateWorker("20", "acme/widgets", { status: "running" });
  // Scoped to this run: the finally removes it, and afterEach restores
  // process.env from savedEnv besides, so no later test sees a failing write.
  process.env.FAKE_SOMA_DECISIONS_FAIL = "1";
  let closed: Awaited<ReturnType<typeof runNode>>;
  try {
   closed = await runNode("20", r.ctx);
  } finally {
   delete process.env.FAKE_SOMA_DECISIONS_FAIL;
  }
  expect(closed.status).toBe("success");
  expect(state(r.statePath).nodes["20"].status).toBe("closed");
  expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("success");
  const events = r.journal.listEvents("acme/widgets", 500);
  expect(events.map((e) => e.kind)).not.toContain("decisions-written");
  const failed = events.filter((e) => e.kind === "decisions-failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]?.detail).toContain("HTTP 504");
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
 test("probes red at the merge base too do not gate: the record passes, names them, and the channel hears once", async () => {
  const r = await rig({ probe: "fake-probe red {node}", probeRetry: "fake-probe red {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const probe = (r.github.comments.get(1) ?? []).find((c) => c.body.includes("ranger:probes"));
  expect(probe?.body).toContain("result=pass selected=2 mode=semantic base-red=probe-hud.mjs -->");
  expect(r.github.prs.get(1)?.body).toContain("Not gating: probe-hud.mjs failed here and fail at the merge base too.");
  expect(r.announced).toHaveLength(1);
  expect(r.announced[0]).toContain("**main was red**");
  expect(r.announced[0]).toContain("probe-hud.mjs");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("probe-hud.mjs fail at the merge base"))).toBe(true);
  // The base worktree is gone again.
  const worktrees = await runCmd("git", ["worktree", "list"], { cwd: r.canonical });
  expect(worktrees.stdout).not.toContain("ranger-probe-base-");
 }, 60_000);

 test("cached base-red assertions certify a later PR with journal and PR cache provenance", async () => {
  const r = await rig({ probe: "fake-probe red {node}", probeRetry: "fake-probe red {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r);
  const sha = await r.github.sha("main");
  r.journal.setHealth(`base-red-checks.acme/widgets.${sha}.probe-hud.mjs`, JSON.stringify(["the hud draws"]));
  const calls = watchBaseRuns(r);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(calls.filter((c) => c.cwd.includes("ranger-probe-base-"))).toEqual([]);
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes(`base result from cache at ${sha.slice(0, 8)}: probe-hud.mjs`))).toBe(true);
  expect(events.some((d) => d.includes("the merge-base probe run"))).toBe(false);
  const record = (r.github.comments.get(1) ?? []).find((c) => c.body.includes("ranger:probes"))?.body ?? "";
  expect(record).toContain(`base-red-cache-sha=${sha} base-red-cache=probe-hud.mjs`);
  expect(record).toContain(`Base result from cache at ${sha.slice(0, 8)}: probe-hud.mjs.`);
  expect(r.github.prs.get(1)?.body).toContain(`Base result from cache at ${sha.slice(0, 8)}`);
 }, 60_000);

 for (const [name, confirmation] of [
  ["passes", { code: 0, stdout: "ok   probe-hud.mjs (0.1s)\n", stderr: "" }],
  ["different checks", {
   code: 1, stderr: "",
   stdout: "FAIL probe-hud.mjs (0.1s) exit=1 assert\n     │  FAIL  another check — detail\nFAILED: probe-hud.mjs\n",
  }],
 ] as const) {
  test(`base confirmation ${name} is retained in journal, PR record, body and log without changing this PR's verdict`, async () => {
   const r = await rig({ probe: "fake-probe red {node}", probeRetry: "fake-probe red {node} {failed}" });
   cleanup.push(r.dir);
   await seedProbeOnBase(r);
   const sha = await r.github.sha("main");
   let baseRuns = 0;
   r.ctx.shellRun = async (command, opts) => {
    if (opts.cwd?.includes("ranger-probe-base-") && ++baseRuns === 2) return confirmation;
    return runCmd("/bin/sh", ["-c", command], opts);
   };
   expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
   expect(baseRuns).toBe(2);
   expect(r.journal.getHealth(`base-red-checks.acme/widgets.${sha}.probe-hud.mjs`)).toBeNull();
   const observation = `Base confirmation at ${sha.slice(0, 8)} ${confirmation.code === 0 ? "passed" : "exited 1 without repeating identical assertion failures"}: probe-hud.mjs`;
   const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
   expect(events.some((d) => d.includes(observation))).toBe(true);
   expect(events.some((d) => d.startsWith("probes passed") && d.includes("inheritance uses the first base comparison or confirmed cache"))).toBe(true);
   if (name === "different checks") expect(events.some((d) => d.includes("another check"))).toBe(true);
   const record = (r.github.comments.get(1) ?? []).find((c) => c.body.includes("ranger:probes"))?.body ?? "";
   expect(record).toContain("result=pass");
   expect(record).toContain(`base-red-unconfirmed-sha=${sha} base-red-unconfirmed-exit=${confirmation.code} base-red-unconfirmed=probe-hud.mjs`);
   expect(record).toContain(observation);
   expect(record).toContain("this PR uses the first base comparison");
   expect(r.github.prs.get(1)?.body).toContain(observation);
   expect(r.announced).toHaveLength(1);
   expect(r.announced[0]).toContain(observation);
   expect(r.announced[0]).toContain("this PR uses the first base comparison");
   expect(r.announced[0]).not.toContain("Branches off this commit do not gate on them");
   const log = workerLogs(r);
   expect(log).toContain("probe confirmation");
   expect(log).toContain(confirmation.stdout.trim());
  }, 60_000);
 }

 test("unresolved fresh base probes gate and remain visible alongside cache provenance", async () => {
  const r = await rig({ probe: "fake-probe red {node}", probeRetry: "fake-probe red {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r, ["probe-hud.mjs", "probe-weapon.mjs"]);
  const sha = await r.github.sha("main");
  r.journal.setHealth(`base-red-checks.acme/widgets.${sha}.probe-hud.mjs`, JSON.stringify(["the hud draws"]));
  r.ctx.shellRun = async (command, opts) => {
   if (opts.cwd?.includes("ranger-probe-base-")) return { code: -1, stdout: "", stderr: "timeout" };
   if (command.startsWith("fake-probe")) return {
    code: 1, stderr: "",
    stdout: [
     "probe selection: semantic", "selected: 2",
     "FAIL probe-hud.mjs (0.1s) exit=1 assert",
     "     │  FAIL  the hud draws — detail",
     "FAIL probe-weapon.mjs (0.1s) exit=1 assert",
     "     │  FAIL  the weapon fires — detail",
     "FAILED: probe-hud.mjs · probe-weapon.mjs",
    ].join("\n"),
   };
   return runCmd("/bin/sh", ["-c", command], opts);
  };
  expect((await runNode("20", r.ctx)).status).toBe("parked");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes(`base result from cache at ${sha.slice(0, 8)}: probe-hud.mjs`) &&
   d.includes("probe-weapon.mjs have no base result — they gate"))).toBe(true);
  const record = (r.github.comments.get(1) ?? []).find((c) => c.body.includes("ranger:probes"))?.body ?? "";
  expect(record).toContain("result=fail");
  expect(record).toContain(`base-red-cache-sha=${sha} base-red-cache=probe-hud.mjs`);
  expect(r.github.prs.get(1)?.draft).toBe(true);
  expect(r.journal.getHealth(`base-red-checks.acme/widgets.${sha}.probe-weapon.mjs`)).toBeNull();
 }, 60_000);

 test("a probe red only on the branch still parks, and the park says the base passes it", async () => {
  const r = await rig({ probe: "fake-probe branch-red {node}", probeRetry: "fake-probe branch-red {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("probe failure class: assertion");
  expect(outcome.detail).toContain("FAILED: probe-hud.mjs");
  expect(outcome.detail).not.toContain("red on the merge base too");
  expect(r.announced).toEqual([]);
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("pass at the merge base") && d.includes("the failure is this branch's"))).toBe(true);
 }, 60_000);

 test("a probe the branch edited gates even when the base fails it too: the base runs another probe under that name", async () => {
  const r = await rig({ probe: "fake-probe red {node}", probeRetry: "fake-probe red {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r);
  r.ctx.workerCommand = [implementWorker, "probe-edit"];
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("FAILED: probe-hud.mjs");
  expect(r.announced).toEqual([]);
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("probe-hud.mjs are new or changed on this branch — they gate"))).toBe(true);
 }, 60_000);

 test("a probe red at the merge base on other checks gates: the branch broke a check of its own", async () => {
  const r = await rig({ probe: "fake-probe branch-other {node}", probeRetry: "fake-probe branch-other {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(r.announced).toEqual([]);
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("probe-hud.mjs fail at the merge base") && d.includes("but not the same way — they gate"))).toBe(true);
 }, 60_000);

 /** Record every repo command with its directory; on a busy host that never quiets, so any quiet-host wait shows in the journal. */
 function watchBaseRuns(r: Rig): { command: string; cwd: string }[] {
  const calls: { command: string; cwd: string }[] = [];
  r.ctx.shellRun = (command, opts) => {
   calls.push({ command, cwd: opts.cwd ?? "" });
   return runCmd("/bin/sh", ["-c", command], opts);
  };
  r.ctx.hostLoad = () => ({ load: 14, cores: 10 });
  r.ctx.quietHost = { pollMs: 1, maxMs: 5 };
  return calls;
 }

 test("a probe that fails the inherited check and then crashes on the branch gates, without a merge-base run", async () => {
  const r = await rig({ probe: "fake-probe branch-crash {node}", probeRetry: "fake-probe branch-crash {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r);
  const calls = watchBaseRuns(r);
  expect((await runNode("20", r.ctx)).status).toBe("parked");
  expect(r.announced).toEqual([]);
  expect(calls.filter((c) => c.cwd.includes("ranger-probe-base-"))).toEqual([]);
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("probe-hud.mjs ended in a crash, kill, timeout or an unreadable kind at the head") && d.includes("they gate"))).toBe(true);
  expect(events.some((d) => d.includes("the merge-base probe run"))).toBe(false);
 }, 60_000);

 test("head failures that all crashed gate at once: no merge-base run, no quiet-host wait for one", async () => {
  const r = await rig({ probe: "fake-probe crash {node}", probeRetry: "fake-probe crash {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r, ["probe-hud.mjs", "probe-weapon.mjs"]);
  const calls = watchBaseRuns(r);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("probe failure class: infrastructure");
  expect(outcome.detail).toContain("FAILED: probe-hud.mjs · probe-weapon.mjs");
  expect(outcome.detail).not.toContain("red on the merge base too");
  expect(r.announced).toEqual([]);
  expect(calls.filter((c) => c.cwd.includes("ranger-probe-base-"))).toEqual([]);
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("probe-hud.mjs, probe-weapon.mjs ended in a crash, kill, timeout or an unreadable kind at the head"))).toBe(true);
  expect(events.some((d) => d.includes("the merge-base probe run"))).toBe(false);
 }, 60_000);

 test("a mix of assertion failures and crashes reruns only the assertion failures at the base; the crash gates though the rest is the base's", async () => {
  const r = await rig({ probe: "fake-probe mixed {node}", probeRetry: "fake-probe mixed {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r, ["probe-hud.mjs", "probe-weapon.mjs"]);
  const calls = watchBaseRuns(r);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("red on the merge base too: probe-hud.mjs");
  expect(r.announced).toEqual([]);
  const base = calls.filter((c) => c.cwd.includes("ranger-probe-base-")).map((c) => c.command);
  expect(base).toEqual(["fake-probe mixed 20 probe-hud.mjs", "fake-probe mixed 20 probe-hud.mjs"]);
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("probe-hud.mjs fail at the merge base") && d.includes("probe-weapon.mjs ended in a crash, kill, timeout or an unreadable kind at the head"))).toBe(true);
 }, 60_000);

 test("a failure whose kind the runner did not print fails closed: it gates without a merge-base run", async () => {
  const r = await rig({ probe: "fake-probe no-kind {node}", probeRetry: "fake-probe no-kind {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r);
  const calls = watchBaseRuns(r);
  expect((await runNode("20", r.ctx)).status).toBe("parked");
  expect(r.announced).toEqual([]);
  expect(calls.filter((c) => c.cwd.includes("ranger-probe-base-"))).toEqual([]);
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("probe-hud.mjs ended in a crash, kill, timeout or an unreadable kind at the head"))).toBe(true);
 }, 60_000);

 test("a probe the base does not have gates: nothing to compare it with", async () => {
  const r = await rig({ probe: "fake-probe red {node}", probeRetry: "fake-probe red {node} {failed}" });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("parked");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("probe-hud.mjs are new or changed on this branch — they gate"))).toBe(true);
 }, 60_000);

 /** A failing probe run whose one failed check prints first, ahead of more than 20,000 characters of passing probes. */
 const LONG_FAILURE = [
  "probe selection: semantic",
  "selected: 2",
  "FAIL probe-hud.mjs (0.1s) exit=1 assert peak load 1.0",
  '     │  FAIL  the hud draws — {"drawn":false}',
  ...Array.from({ length: 600 }, (_, i) => `ok   probe-filler-${i}.mjs (0.1s) every check passed`),
  "FAILED: probe-hud.mjs",
 ].join("\n");

 /** Probe commands answer with LONG_FAILURE at the head and pass at the merge base; the rest run for real. */
 function longProbeOutput(r: Rig): void {
  r.ctx.shellRun = (command, opts) => {
   if (!command.startsWith("fake-probe ")) return runCmd("/bin/sh", ["-c", command], opts);
   const atBase = (opts.cwd ?? "").includes("ranger-probe-base-");
   return Promise.resolve(
    atBase ? { code: 0, stdout: "ok   probe-hud.mjs (0.1s)\n", stderr: "" } : { code: 1, stdout: LONG_FAILURE, stderr: "" },
   );
  };
 }

 /** Every worker log the rig's journal directory holds, concatenated. */
 function workerLogs(r: Rig): string {
  const dir = dirname(workerLogFile(r.journal.path, "acme/widgets", "20", 0));
  return readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
 }

 test("a failing assertion early in long probe output is kept whole in the log, and the PR record names it before the tail (node #107)", async () => {
  const r = await rig({ probe: "fake-probe red {node}", probeRetry: "fake-probe red {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r);
  longProbeOutput(r);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("FAILED: probe-hud.mjs\nfailing: probe-hud.mjs (assert): the hud draws\n");

  // Both attempts and the merge-base run, labelled, each with its whole output.
  const log = workerLogs(r);
  const sections = log.split(/^===== /m).filter((s) => s.includes("fake-probe"));
  expect(sections.map((s) => s.split("\n")[0].replace(/^\S+ /, ""))).toEqual([
   "probe run 1 (fake-probe red 20) — exit 1",
   "probe run 2 (the retry) (fake-probe red 20 probe-hud.mjs) — exit 1",
   expect.stringMatching(/^merge base [0-9a-f]{8}: probe run \(fake-probe red 20 probe-hud\.mjs\) — exit 0$/),
  ]);
  for (const s of sections.slice(0, 2)) {
   expect(s).toContain('FAIL  the hud draws — {"drawn":false}');
   expect(s).toContain("ok   probe-filler-599.mjs");
  }

  // The record names the probe, its kind and the check before the output, whose tail no longer holds it.
  const record = (r.github.comments.get(1) ?? []).find((c) => c.body.includes("ranger:probes"))?.body ?? "";
  expect(record).toContain("result=fail");
  const named = record.indexOf("probe-hud.mjs (assert): the hud draws");
  const output = record.indexOf("<details><summary>output</summary>");
  expect(named).toBeGreaterThan(-1);
  expect(named).toBeLessThan(output);
  expect(record.slice(output)).not.toContain("the hud draws");
  expect(record).toContain("worker log `acme__widgets-20-g");

  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => /^probes FAILED at [0-9a-f]{8} .* — failing: probe-hud\.mjs \(assert\): the hud draws$/.test(d))).toBe(true);
  expect(events.some((d) => d.includes("could not write the worker log"))).toBe(false);
 }, 60_000);

 test("an unwritable log directory changes no gate: certification proceeds and the journal says the log was not written (node #107)", async () => {
  const r = await rig({ probe: "fake-probe red {node}", probeRetry: "fake-probe red {node} {failed}" });
  cleanup.push(r.dir);
  await seedProbeOnBase(r);
  longProbeOutput(r);
  const logs = dirname(dirname(workerLogFile(r.journal.path, "acme/widgets", "20", 0)));
  rmSync(logs, { recursive: true, force: true });
  writeFileSync(logs, "a file where the log directory should be\n");
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("failing: probe-hud.mjs (assert): the hud draws");
  const record = (r.github.comments.get(1) ?? []).find((c) => c.body.includes("ranger:probes"))?.body ?? "";
  expect(record).toContain("result=fail");
  // The record names no log it could not write.
  expect(record).not.toContain("The full output of every run is in ranger's worker log");
  expect(record).toContain("Ranger could not write its worker log for every run");
  const failed = r.journal.listEvents("acme/widgets", 200).filter((e) => e.kind === "log-failed").map((e) => e.detail ?? "");
  expect(failed.some((d) => d.startsWith("could not write the worker log (build pass)"))).toBe(true);
  expect(failed.some((d) => d.startsWith("could not write the worker log (probe run 1 (fake-probe red 20))"))).toBe(true);
  expect(failed.some((d) => d.startsWith("could not write the worker log (probe run 2 (the retry)"))).toBe(true);
 }, 60_000);

 test("a PR that conflicts with its moved base gets a base merge pass, a new round, then goes ready (seelite #692)", async () => {
  // The base moves while round 1 reads the branch: #686/#687 landed while 491 was in review.
  let r!: Rig & { calls: number[]; announced: string[] };
  const installs = join(tmpdir(), `ranger-installs-${Date.now()}.log`);
  r = await rig({
   install: `echo install >> ${installs}`,
   onReview: async (round) => { if (round === 1) await moveBaseUnder(r); },
  });
  cleanup.push(r.dir);
  r.ctx.mergeablePoll = { pollMs: 1, attempts: 2 };
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  // Installed for the build, and again after the merge brought the base's lockfile in.
  expect(readFileSync(installs, "utf8").trim().split("\n")).toHaveLength(2);
  rmSync(installs, { force: true });
  expect(r.calls).toHaveLength(2); // round 1 on the conflicting head, round 2 on the merged one
  const markers = (r.github.comments.get(1) ?? []).filter((c) => c.body.includes("ranger:base-merge"));
  expect(markers).toHaveLength(1);
  const head = await r.github.sha("node/20-add-the-feature-module");
  const inside = await runCmd("git", ["merge-base", "--is-ancestor", "main", head], { cwd: r.origin });
  expect(inside.code).toBe(0);
  expect((await r.github.getPr("acme/widgets", 1)).mergeState).toBe("mergeable");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.startsWith("PR conflicts with origin/main in src/feature.ts"))).toBe(true);
  expect(events.some((d) => d.startsWith("base merge pass 1 @"))).toBe(true);
 }, 60_000);

 test("a base merge pass that merges nothing fails without pushing or marking", async () => {
  let r!: Rig & { calls: number[]; announced: string[] };
  r = await rig({ onReview: async (round) => { if (round === 1) await moveBaseUnder(r); } });
  cleanup.push(r.dir);
  r.ctx.mergeablePoll = { pollMs: 1, attempts: 2 };
  r.ctx.workerCommand = [implementWorker, "merge-noop"];
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toContain("base merge pass committed nothing — the conflict with origin/main stands");
  expect((r.github.comments.get(1) ?? []).some((c) => c.body.includes("ranger:base-merge"))).toBe(false);
  expect((await r.github.getPr("acme/widgets", 1)).mergeState).toBe("conflict");
 }, 60_000);

 test("an install after the base merge that rewrites a tracked file fails the pass before the tests, and nothing is pushed", async () => {
  let r!: Rig & { calls: number[]; announced: string[] };
  let before = "";
  // Only the merged tree has src/feature.ts at install time: the build's install leaves the tree alone.
  r = await rig({
   install: "if [ -f src/feature.ts ]; then echo regenerated >> README.md; fi",
   onReview: async (round) => {
    if (round !== 1) return;
    before = await r.github.sha("node/20-add-the-feature-module");
    await moveBaseUnder(r);
   },
  });
  cleanup.push(r.dir);
  r.ctx.mergeablePoll = { pollMs: 1, attempts: 2 };
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toContain("uncommitted or untracked file(s) ( M README.md)");
  expect(before).not.toBe("");
  expect(await r.github.sha("node/20-add-the-feature-module")).toBe(before);
 }, 60_000);

 test("a worker that moves origin/<base> onto its own commit does not pass for a merge", async () => {
  let r!: Rig & { calls: number[]; announced: string[] };
  let before = "";
  r = await rig({
   onReview: async (round) => {
    if (round !== 1) return;
    before = await r.github.sha("node/20-add-the-feature-module");
    await moveBaseUnder(r);
   },
  });
  cleanup.push(r.dir);
  r.ctx.mergeablePoll = { pollMs: 1, attempts: 2 };
  r.ctx.workerCommand = [implementWorker, "merge-forge"];
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toMatch(/^base merge pass committed, but origin\/main as fetched \([0-9a-f]{8}\) is not in node\/20-/);
  expect(await r.github.sha("node/20-add-the-feature-module")).toBe(before);
  expect((r.github.comments.get(1) ?? []).some((c) => c.body.includes("ranger:base-merge"))).toBe(false);
 }, 60_000);

 test("a resumed run drops an unpushed merge from a crashed one, and its markers grant nothing", async () => {
  let r!: Rig & { calls: number[]; announced: string[] };
  r = await rig({ onReview: async (round) => { if (round === 1) await moveBaseUnder(r); } });
  cleanup.push(r.dir);
  r.ctx.mergeablePoll = { pollMs: 1, attempts: 2 };
  r.ctx.workerCommand = [implementWorker, "merge-noop"];
  expect((await runNode("20", r.ctx)).status).toBe("failed"); // round 1 clean, the PR conflicts, nothing merged

  // The crashed run: it merged in the node's worktree and posted its markers, then died before the push.
  const wt = join(r.canonical, ".worktrees", "node-20");
  const git = (args: string[]) => runCmd("git", args, { cwd: wt, env: { ...process.env, ...GIT_ENV } });
  await git(["merge", "--no-edit", "origin/main"]);
  writeFileSync(join(wt, "src", "feature.ts"), "export const feature = () => 1; // crashed run\n");
  await git(["add", "-A"]);
  await git(["commit", "-q", "--no-edit"]);
  const stranded = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await r.github.postComment("acme/widgets", 1, baseMergeMarker(stranded, "main"));
  await r.github.postComment("acme/widgets", 1, baseMergeMarker("f".repeat(40), "release/1.0+hotfix"));

  r.ctx.workerCommand = [implementWorker, "build"];
  r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
  // Counted naively, two markers would use up both merge passes and park it.
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const head = await r.github.sha("node/20-add-the-feature-module");
  expect(head).not.toBe(stranded);
  expect((await runCmd("git", ["merge-base", "--is-ancestor", "main", head], { cwd: r.origin })).code).toBe(0);
  expect(r.calls).toHaveLength(2);
  const markers = recordedBaseMerges(r.github.comments.get(1) ?? [], BOT);
  expect(markers.map((m) => m.sha)).toEqual([stranded, "f".repeat(40), head]); // the release/… base still parses
 }, 60_000);

 test("a ready PR whose base moves under it is sent back for a base merge, not left pending on CI", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  r.ctx.mergeablePoll = { pollMs: 1, attempts: 2 };
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  await moveBaseUnder(r);
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
  expect(spawned).toEqual(["20"]);
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("conflicts with main") && d.includes("run-node resumes"))).toBe(true);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect((await r.github.getPr("acme/widgets", 1)).mergeState).toBe("mergeable");
 }, 60_000);

 test("a failed supervisor test run names its failing test and keeps its whole output in the node's log", async () => {
  // Red on the branch only: the base has no src/feature.ts.
  const r = await rig({ test: "if [ -f src/feature.ts ]; then echo \"(fail) the hud draws [3.00ms]\" >&2; echo \" 1 fail\" >&2; exit 1; fi" });
  cleanup.push(r.dir);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toContain("failed after the worker (exit 1) — failing: the hud draws:");
  const log = /\(worker log: ([^)]+)\)/.exec(outcome.detail)?.[1] ?? "";
  expect(readFileSync(log, "utf8")).toContain("build pass: supervisor tests");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("failed on a busy host"))).toBe(false); // a quiet host: no retry
  expect(events.some((d) => /at the merge base [0-9a-f]{40} passes — not red there, they gate: the hud draws$/.test(d))).toBe(true);
 }, 60_000);

 // node #164: a failing test the merge base fails too is the base's, not the branch's.
 describe("supervisor tests red at the merge base", () => {
  /** The merge base the node's branch shares with origin/main. */
  async function mergeBase(r: Rig): Promise<string> {
   const worktree = join(r.canonical, ".worktrees", "node-20");
   return (await runCmd("git", ["merge-base", "HEAD", "origin/main"], { cwd: worktree })).stdout.trim();
  }
  /** Record every repo command with its directory, running it for real. */
  function watchRuns(r: Rig): { command: string; cwd: string }[] {
   const calls: { command: string; cwd: string }[] = [];
   r.ctx.shellRun = (command, opts) => {
    calls.push({ command, cwd: opts.cwd ?? "" });
    return runCmd("/bin/sh", ["-c", command], opts);
   };
   return calls;
  }
  const baseRuns = (calls: { command: string; cwd: string }[]) => calls.filter((c) => c.cwd.includes("ranger-test-base-"));
  const reviewed = (r: Rig) => r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");

  test("every failing test red at the merge base too: not gating, the lane carries on and restores the worktree", async () => {
   const r = await rig({ test: "echo \"(fail) claude-code install [5000.00ms]\"; echo \"(fail) git trust\" >&2; echo \" 2 fail\" >&2; exit 1" });
   cleanup.push(r.dir);
   const calls = watchRuns(r);
   expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
   const sha = await mergeBase(r);
   expect(sha).toMatch(/^[0-9a-f]{40}$/);
   const events = reviewed(r);
   expect(events).toContain(`tests (echo "(fail) claude-code install [5000.00ms]"; echo "(fail) git trust" >&2; echo " 2 fail" >&2; exit 1) at the merge base ${sha}: red on the merge base too, not gating: claude-code install; git trust`);
   expect(events.some((d) => d.startsWith("restored the worktree to "))).toBe(true);
   expect(baseRuns(calls).map((c) => c.command)).toEqual([r.ctx.map.commands.test!]);
   expect(r.github.prs.size).toBe(1);
  }, 60_000);

  test("after a failed busy-host retry the base run waits for a quiet host, then clears the shared failure", async () => {
   const r = await rig({ test: "echo \"(fail) a flake at load\"; echo \" 1 fail\"; exit 1" });
   cleanup.push(r.dir);
   const calls = watchRuns(r);
   const loads = [14, 13, 2, 14, 13, 2]; // retry: at the failure, waiting, quiet; base run: busy, waiting, quiet
   r.ctx.hostLoad = () => ({ load: loads.length > 1 ? (loads.shift() as number) : loads[0], cores: 10 });
   r.ctx.quietHost = { pollMs: 1, maxMs: 60_000 };
   expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
   const events = reviewed(r).reverse(); // oldest first
   const retry = events.findIndex((d) => d.includes("failed on a busy host (load 14.0 on 10 cores) — retrying once"));
   const wait = events.findIndex((d) => d.startsWith("the merge-base test run waits for the host"));
   const starts = events.findIndex((d) => d.startsWith("the merge-base test run starts after"));
   const red = events.findIndex((d) => d.endsWith("red on the merge base too, not gating: a flake at load"));
   expect(retry).toBeGreaterThanOrEqual(0);
   expect(wait).toBeGreaterThan(retry);
   expect(starts).toBeGreaterThan(wait);
   expect(red).toBeGreaterThan(starts);
   expect(calls.filter((c) => c.cwd.includes("ranger-test-retry-")).length).toBeGreaterThan(0);
   expect(baseRuns(calls).length).toBe(1);
  }, 60_000);

  test("a base that fails another set gates, naming the failures the base did not share", async () => {
   const r = await rig({ test: "echo \"(fail) shared\"; if [ -f src/feature.ts ]; then echo \"(fail) branch only\"; echo \" 2 fail\"; fi; exit 1" });
   cleanup.push(r.dir);
   const outcome = await runNode("20", r.ctx);
   expect(outcome.status).toBe("failed");
   expect(outcome.detail).toContain("failing: shared; branch only:");
   const sha = await mergeBase(r);
   expect(reviewed(r).some((d) => d.endsWith(`at the merge base ${sha} fails another set (exit 1) — not red there, they gate: branch only`))).toBe(true);
   expect(r.github.prs.size).toBe(0);
  }, 60_000);

  test("the comparison uses every failing name, not the three the journal line keeps", async () => {
   const r = await rig({ test: "echo \"(fail) one\"; echo \"(fail) two\"; echo \"(fail) three\"; if [ -f src/feature.ts ]; then echo \"(fail) four\"; echo \" 4 fail\"; fi; exit 1" });
   cleanup.push(r.dir);
   const outcome = await runNode("20", r.ctx);
   expect(outcome.status).toBe("failed");
   expect(outcome.detail).toContain("failing: one; two; three:");
   expect(reviewed(r).some((d) => d.endsWith("not red there, they gate: four"))).toBe(true);
   expect(r.github.prs.size).toBe(0);
  }, 60_000);

  test("a failure that names no test gets no base run", async () => {
   const r = await rig({ test: "test ! -f src/feature.ts" });
   cleanup.push(r.dir);
   const calls = watchRuns(r);
   expect((await runNode("20", r.ctx)).status).toBe("failed");
   expect(baseRuns(calls)).toEqual([]);
   expect(reviewed(r).some((d) => d.includes("merge base") || d.includes("merge-base"))).toBe(false);
  }, 60_000);

  test("a killed or timed-out run gets no base run, even with (fail) lines", async () => {
   const r = await rig({});
   cleanup.push(r.dir);
   const calls: { command: string; cwd: string }[] = [];
   r.ctx.shellRun = (command, opts) => {
    calls.push({ command, cwd: opts.cwd ?? "" });
    if (command === r.ctx.map.commands.test) return Promise.resolve({ code: -1, stdout: "(fail) a shared flake\n 1 fail\n", stderr: "timed out" });
    return runCmd("/bin/sh", ["-c", command], opts);
   };
   expect((await runNode("20", r.ctx)).status).toBe("failed");
   expect(baseRuns(calls)).toEqual([]);
   expect(reviewed(r).some((d) => d.includes("merge base") || d.includes("merge-base"))).toBe(false);
  }, 60_000);

  test("a branch run a signal ended (exit 143) gets no base run, even with (fail) lines", async () => {
   const r = await rig({ test: "echo \"(fail) shared\"; echo \" 1 fail\"; exit 143" });
   cleanup.push(r.dir);
   const calls = watchRuns(r);
   expect((await runNode("20", r.ctx)).status).toBe("failed");
   expect(baseRuns(calls)).toEqual([]);
   expect(reviewed(r).some((d) => d.includes("merge base") || d.includes("merge-base"))).toBe(false);
  }, 60_000);

  test("a base run a signal ended (exit 143) is no base result: the failures gate", async () => {
   const r = await rig({ test: "echo \"(fail) shared\"; echo \" 1 fail\"; if [ -f src/feature.ts ]; then exit 1; fi; exit 143" });
   cleanup.push(r.dir);
   const outcome = await runNode("20", r.ctx);
   expect(outcome.status).toBe("failed");
   const sha = await mergeBase(r);
   expect(reviewed(r).some((d) => d.endsWith(`at the merge base ${sha} were ended by a signal (exit 143) — not a base result, the failures gate`))).toBe(true);
   expect(reviewed(r).some((d) => d.includes("red on the merge base too"))).toBe(false);
   expect(r.github.prs.size).toBe(0);
  }, 60_000);

  for (const [what, extra] of [
   ["an unhandled error between tests", "echo \"# Unhandled error between tests\"; echo \" 1 fail\"; echo \" 1 error\""],
   ["a file that does not load (counted, unnamed)", "echo \"error: Cannot find module ./nope\"; echo \" 2 fail\""],
   ["no bun summary at all", "true"],
  ] as const) {
   test(`a shared named failure beside ${what} gets no base run: the failures gate`, async () => {
    const r = await rig({ test: `echo "(fail) shared"; if [ -f src/feature.ts ]; then ${extra}; else echo " 1 fail"; fi; exit 1` });
    cleanup.push(r.dir);
    const calls = watchRuns(r);
    expect((await runNode("20", r.ctx)).status).toBe("failed");
    expect(baseRuns(calls)).toEqual([]);
    expect(reviewed(r).some((d) => d.endsWith("failures no (fail) line names (an error outside a test, or a count the names do not cover); the merge-base check did not run — the failures gate"))).toBe(true);
    expect(r.github.prs.size).toBe(0);
   }, 60_000);
  }

  for (const [what, opts] of [
   ["whose install failed", { install: "case \"$PWD\" in *ranger-test-retry-*) echo \"(fail) shared\"; echo \" 1 fail\"; exit 3 ;; esac", test: "echo \"(fail) shared\"; echo \" 1 fail\"; exit 1" }],
   ["that changed tracked content", { test: "case \"$PWD\" in *ranger-test-retry-*) echo x >> src/feature.ts ;; esac; echo \"(fail) shared\"; echo \" 1 fail\"; exit 1" }],
  ] as const) {
   test(`a busy-host retry ${what} certifies nothing: its shared failures gate without a base run`, async () => {
    const r = await rig(opts);
    cleanup.push(r.dir);
    const calls = watchRuns(r);
    const loads = [14, 13, 2];
    r.ctx.hostLoad = () => ({ load: loads.length > 1 ? (loads.shift() as number) : loads[0], cores: 10 });
    r.ctx.quietHost = { pollMs: 1, maxMs: 60_000 };
    expect((await runNode("20", r.ctx)).status).toBe("failed");
    expect(calls.filter((c) => c.cwd.includes("ranger-test-retry-")).length).toBeGreaterThan(0);
    expect(baseRuns(calls)).toEqual([]);
    expect(reviewed(r).some((d) => d.includes("red on the merge base too"))).toBe(false);
    expect(r.github.prs.size).toBe(0);
   }, 60_000);
  }

  test("a base install that fails gates, and says why the base check did not run", async () => {
   const r = await rig({
    install: "case \"$PWD\" in *ranger-test-base-*) exit 3 ;; esac",
    test: "echo \"(fail) shared\"; echo \" 1 fail\"; exit 1",
   });
   cleanup.push(r.dir);
   const outcome = await runNode("20", r.ctx);
   expect(outcome.status).toBe("failed");
   expect(outcome.detail).toContain("failing: shared:");
   const sha = await mergeBase(r);
   expect(reviewed(r)).toContain(`tests (echo "(fail) shared"; echo " 1 fail"; exit 1) failed; the merge-base check at ${sha} did not run: install for the merge-base run failed — the failures gate`);
  }, 60_000);

  test("a run that moves origin/main onto the branch's own head cannot make its failures the base's", async () => {
   // The failed run points origin/main at HEAD: a base check read from that ref
   // would run the branch itself and call its failure the base's.
   const r = await rig({ test: "git update-ref refs/remotes/origin/main HEAD; if [ -f src/feature.ts ]; then echo \"(fail) branch only\"; echo \" 1 fail\"; exit 1; fi" });
   cleanup.push(r.dir);
   const outcome = await runNode("20", r.ctx);
   expect(outcome.status).toBe("failed");
   expect(reviewed(r).some((d) => d.includes("red on the merge base too"))).toBe(false);
   expect(reviewed(r).some((d) => d.endsWith("passes — not red there, they gate: branch only"))).toBe(true);
   expect(r.github.prs.size).toBe(0);
  }, 60_000);

  test("a merge base that cannot be resolved gates, and says why the base check did not run", async () => {
   // The branch shares no history with origin/main: no merge base to compare with.
   const r = await rig({ test: "echo \"(fail) shared\"; echo \" 1 fail\"; exit 1" });
   cleanup.push(r.dir);
   r.ctx.workerCommand = [implementWorker, "orphan"];
   const calls = watchRuns(r);
   const outcome = await runNode("20", r.ctx);
   expect(outcome.status).toBe("failed");
   expect(baseRuns(calls)).toEqual([]);
   expect(reviewed(r).some((d) => d.includes("the merge-base check did not run: no merge base with origin/main") && d.endsWith("— the failures gate"))).toBe(true);
  }, 60_000);
 });

 test("supervisor tests that fail on a busy host are retried once it quiets, and pass", async () => {
  const flag = join(tmpdir(), `ranger-flaky-tests-${Date.now()}`);
  const r = await rig({ test: `if [ -f ${flag} ]; then test -f src/feature.ts; else touch ${flag}; exit 1; fi` });
  cleanup.push(r.dir);
  const loads = [14, 13, 2]; // at the failure, while waiting, then quiet
  r.ctx.hostLoad = () => ({ load: loads.length > 1 ? (loads.shift() as number) : loads[0], cores: 10 });
  r.ctx.quietHost = { pollMs: 1, maxMs: 60_000 };
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("failed on a busy host (load 14.0 on 10 cores) — retrying once, in a fresh checkout of "))).toBe(true);
  expect(events.some((d) => d.endsWith("passed on the retry in a fresh checkout"))).toBe(true);
  rmSync(flag, { force: true });
 }, 60_000);

 /** Exclude *.fixture through the shared repo's info/exclude, so a fixture is ignored rather than untracked. */
 const IGNORE_FIXTURES = "x=\"$(git rev-parse --git-common-dir)/info\"; mkdir -p \"$x\"; grep -qx \"*.fixture\" \"$x/exclude\" 2>/dev/null || echo \"*.fixture\" >> \"$x/exclude\"";

 // Each failed run leaves something behind in the node's worktree that a
 // retry there would pass on. The retry runs in a fresh checkout of the
 // committed head instead, so none of it reaches the retry, which fails.
 for (const [what, install, cmd] of [
  ["an untracked fixture", undefined, "if [ -f src/fixed.ts ]; then exit 0; else touch src/fixed.ts; exit 1; fi"],
  ["a new ignored fixture", IGNORE_FIXTURES, `${IGNORE_FIXTURES}; if [ -f t.fixture ]; then exit 0; else touch t.fixture; exit 1; fi`],
  ["a rewritten ignored fixture", `${IGNORE_FIXTURES}; echo old > t.fixture`, `${IGNORE_FIXTURES}; if grep -qx new t.fixture; then exit 0; else echo new > t.fixture; exit 1; fi`],
  ["an ignored fixture whose name git quotes", `${IGNORE_FIXTURES}; echo old > "a ü.fixture"`, `${IGNORE_FIXTURES}; if grep -qx new "a ü.fixture"; then exit 0; else echo new > "a ü.fixture"; exit 1; fi`],
  ["a tracked file hidden by --skip-worktree", undefined, "if grep -qx new README.md; then exit 0; else git update-index --skip-worktree README.md; echo new > README.md; exit 1; fi"],
  ["a replacement ref for the head commit", undefined, "if grep -qx replaced README.md; then exit 0; else plant-replace README.md replaced; exit 1; fi"],
  ["a tag", undefined, "if git rev-parse -q --verify refs/tags/tests-ok >/dev/null; then exit 0; else git tag -f tests-ok; exit 1; fi"],
 ] as const) {
  test(`a test retry on a busy host never sees ${what} the failed run left: it runs in a fresh checkout`, async () => {
   const r = await rig({ ...(install === undefined ? {} : { install }), test: cmd });
   cleanup.push(r.dir);
   r.ctx.hostLoad = () => ({ load: 14, cores: 10 });
   r.ctx.quietHost = { pollMs: 1, maxMs: 5 };
   expect((await runNode("20", r.ctx)).status).toBe("failed");
   const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
   expect(events.some((d) => d.includes("— retrying once, in a fresh checkout of "))).toBe(true);
   expect(events.some((d) => d.includes("passed on the retry"))).toBe(false);
   expect(r.github.prs.size).toBe(0);
   const worktrees = await runCmd("git", ["worktree", "list"], { cwd: r.canonical });
   expect(worktrees.stdout).not.toContain("ranger-test-retry-");
  }, 60_000);
 }

 test("after a retry passes in a fresh clone, the worktree is restored before the probes run in it", async () => {
  const flag = join(tmpdir(), `ranger-restore-${Date.now()}`);
  // The failed run leaves src/leftover.ts behind; the probe fails while it is there.
  const r = await rig({
   test: `if [ -f ${flag} ]; then test -f src/feature.ts; else touch ${flag}; touch src/leftover.ts; exit 1; fi`,
   probe: "test ! -e src/leftover.ts",
  });
  cleanup.push(r.dir);
  const loads = [14, 13, 2];
  r.ctx.hostLoad = () => ({ load: loads.length > 1 ? (loads.shift() as number) : loads[0], cores: 10 });
  r.ctx.quietHost = { pollMs: 1, maxMs: 60_000 };
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.startsWith("restored the worktree to "))).toBe(true);
  expect(existsSync(join(r.canonical, ".worktrees", "node-20", "src", "leftover.ts"))).toBe(false);
  rmSync(flag, { force: true });
 }, 60_000);

 test("built and committed work a failed run left unpushed is adopted on resume, with no new worker session", async () => {
  const flag = join(tmpdir(), `ranger-adopt-${Date.now()}`);
  const r = await rig({ test: `test -f ${flag}` });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("failed"); // built and committed; the supervisor's tests fail
  expect(r.github.prs.size).toBe(0);
  writeFileSync(flag, ""); // whatever broke the tests is gone
  r.ctx.workerCommand = [implementWorker, "noop"]; // a worker session would commit nothing and fail
  r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.startsWith("adopting ") && d.includes("no new worker session"))).toBe(true);
  expect(r.github.prs.size).toBe(1);
  rmSync(flag, { force: true });
 }, 60_000);

 test("an adopted head is credited to the substrate that wrote it, not to a later session that committed nothing", async () => {
  const flag = join(tmpdir(), `ranger-adopt-author-${Date.now()}`);
  const r = await rig({ test: `test -f ${flag}` });
  cleanup.push(r.dir);
  delete r.ctx.workerCommand;
  let mode = "build";
  let sessions = 0;
  r.ctx.worker = async (prompt, opts) => {
   sessions += 1;
   return runCmd(implementWorker, [mode, prompt], opts);
  };
  r.ctx.substrate = "claude";
  expect((await runNode("20", r.ctx)).status).toBe("failed"); // Claude built it; the tests fail
  r.ctx.substrate = "codex";
  mode = "noop";
  r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
  expect((await runNode("20", r.ctx)).status).toBe("failed"); // still failing: Codex's session commits nothing
  writeFileSync(flag, "");
  r.ctx.substrate = "pi";
  r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  expect(sessions).toBe(2); // the third run adopted: no session
  const head = await r.github.sha("node/20-add-the-feature-module");
  expect(r.journal.headSubstrate("acme/widgets", head)).toBe("claude");
  rmSync(flag, { force: true });
 }, 60_000);

 test("adoption tests the commit in a fresh clone: an ignored fixture the failed run left cannot make it pass", async () => {
  const r = await rig({ test: `${IGNORE_FIXTURES}; if [ -f t.fixture ]; then exit 0; else touch t.fixture; exit 1; fi` });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("failed"); // the failed run leaves t.fixture behind
  r.ctx.workerCommand = [implementWorker, "noop"];
  r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
  expect((await runNode("20", r.ctx)).status).toBe("failed"); // not adopted; the worker has nothing to add
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("on the work a previous run committed") && d.endsWith("— the worker continues"))).toBe(true);
  expect(events.some((d) => d.startsWith("adopting "))).toBe(false);
  expect(r.github.prs.size).toBe(0);
 }, 60_000);

 test("adoption tests that fail on a busy host get one retry, and the work is adopted", async () => {
  const counter = join(tmpdir(), `ranger-adopt-busy-${Date.now()}`);
  // Run 0 (the build's own) and run 1 (adoption) fail; run 2 (the adoption retry) passes.
  const r = await rig({ test: `n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n + 1)) > ${counter}; [ "$n" -ge 2 ]` });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("failed"); // quiet host: no retry
  r.ctx.workerCommand = [implementWorker, "noop"];
  const loads = [14, 13, 2];
  r.ctx.hostLoad = () => ({ load: loads.length > 1 ? (loads.shift() as number) : loads[0], cores: 10 });
  r.ctx.quietHost = { pollMs: 1, maxMs: 60_000 };
  r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.startsWith("adoption tests failed on a busy host (load 14.0 on 10 cores)"))).toBe(true);
  expect(events.some((d) => d.startsWith("adopting "))).toBe(true);
  rmSync(counter, { force: true });
 }, 60_000);

 test("adopted work that fails the supervisor's tests goes to the worker, which fixes it", async () => {
  const r = await rig({ test: "test -f src/fixed.ts" });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("failed");
  r.ctx.workerCommand = [implementWorker, "add-fixed"];
  r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("on the work a previous run committed") && d.endsWith("— the worker continues"))).toBe(true);
  expect(events.some((d) => d.startsWith("adopting "))).toBe(false);
 }, 60_000);

 test("a retry whose install rewrites tracked source certifies nothing: the repair is not in the pushed commit", async () => {
  const r = await rig({
   // Only the retry checkout gets "repaired"; the tests pass only on the repair.
   install: "case \"$PWD\" in *ranger-test-retry-*) echo repaired >> README.md ;; esac",
   test: "grep -q repaired README.md",
  });
  cleanup.push(r.dir);
  r.ctx.hostLoad = () => ({ load: 14, cores: 10 });
  r.ctx.quietHost = { pollMs: 1, maxMs: 5 };
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("failed");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => d.includes("passed on the retry"))).toBe(false);
  expect(r.github.prs.size).toBe(0);
 }, 60_000);

 test("install and tests run niced, the probe run at the walker's own priority", async () => {
  const own = Number((await runCmd("/bin/sh", ["-c", "ps -o nice= -p $PPID"])).stdout.trim());
  // The OS clamps at its own maximum (20 on macOS, 19 on Linux): ask it.
  const max = Number((await runCmd("/bin/sh", ["-c", "ps -o nice= -p $$"], { nice: 100 })).stdout.trim());
  const niced = Math.min(own + 10, max);
  const r = await rig({
   install: `[ $(ps -o nice= -p $$) -eq ${niced} ]`,
   test: `[ $(ps -o nice= -p $$) -eq ${niced} ] && test -f src/feature.ts`,
   probe: `[ $(ps -o nice= -p $$) -eq ${own} ]`,
  });
  cleanup.push(r.dir);
  r.ctx.config.workers.niceness = 10; // the suite's fixtures run un-niced (support.ts)
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
 }, 60_000);

 test("a probe run killed partway retries only the selected probes it had not passed", async () => {
  const r = await rig({ probe: "fake-probe dies {node}", probeRetry: "fake-probe ok {node} {failed}" });
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events.some((d) => /^probe run 1 failed \(exit -?\d+\) — retrying only the 1 probe\(s\) it had not passed when it stopped$/.test(d))).toBe(true);
  const probe = (r.github.comments.get(1) ?? []).find((c) => c.body.includes("ranger:probes"));
  expect(probe?.body).toContain("`fake-probe ok 20 probe-b.mjs`");
 }, 60_000);

 test("a busy host delays the probe run until the load drops", async () => {
  const r = await rig({ probe: "fake-probe ok {node}" });
  cleanup.push(r.dir);
  const loads = [12, 11, 3];
  r.ctx.hostLoad = () => ({ load: loads.length > 1 ? (loads.shift() as number) : loads[0], cores: 10 });
  r.ctx.quietHost = { pollMs: 1, maxMs: 60_000 };
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const events = r.journal.listEvents("acme/widgets", 200).map((e) => e.detail ?? "");
  expect(events).toContain("probe run 1 waits for the host: load 12.0 on 10 cores");
  expect(events.some((d) => /^probe run 1 starts after \d+s: load 3\.0 on 10 cores$/.test(d))).toBe(true);
 }, 60_000);

 test("a hook that stops the worker before its first turn parks the node as policy-blocked, outside the dead-man", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  r.ctx.workerCommand = [implementWorker, "hook-stop"];
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toMatch(/^policy-blocked: a hook stopped the build pass before its first turn \(Runtime policy denied this action: security-disable-request\.\)/);
  expect(r.journal.deadmanCount()).toBe(0);
  expect(r.github.prs.size).toBe(0);
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

 for (const [why, majors, status] of [
  ["a clean one is ready with no new sage round", 0, "awaiting-merge"],
  ["one with a major still parks at the cap", 1, "parked"],
 ] as const) {
  test(`node #106 — newest-same-head-review-wins: a resume over a newer review on the parked head uses it; ${why}`, async () => {
   // Round 1 parks at a cap of 1 on a major (an errored lens reads as one).
   const r = await rig({ blockers: [0], majors: [1] });
   cleanup.push(r.dir);
   r.ctx.config.workers.reviewRounds = 1;
   expect((await runNode("20", r.ctx)).status).toBe("parked");
   const head = await r.github.sha("node/20-add-the-feature-module");
   // Round 2 stands in for a rerun posted under the machine account: the
   // loop never reviews a head that already has a review.
   await r.github.postComment("acme/widgets", 1, `${reviewMarker(2, { verdict: "commented", summary: "", commitId: head, blockers: 0, majors, nits: 0, body: "" })}\nround two`);

   r.journal.updateWorker("20", "acme/widgets", { status: "claimed" });
   const outcome = await runNode("20", r.ctx);
   expect(outcome.status).toBe(status);
   if (majors > 0) expect(outcome.detail).toContain("0 blocker(s) and 1 major(s) remain after 2 sage round(s)");
   expect(r.calls).toHaveLength(1); // round 2 was read back, not re-run
   expect(r.journal.getWorker("20", "acme/widgets")).toMatchObject({ reviewRound: 2, verdictSha: head });
   // A clean round 2 that set round 1's major aside is named once in the
   // journal; a major standing in round 2 sets nothing aside.
   const setAside = r.journal.listNodeEvents("acme/widgets", "20")
    .filter((e) => e.kind === "reviewed" && (e.detail ?? "").includes("superseded by the clean round 2"));
   expect(setAside).toHaveLength(majors === 0 ? 1 : 0);
   // History intact: round 1 still stands on the PR, unchanged.
   const rounds = recordedReviews(r.github.comments.get(1) ?? [], BOT).map((x) => `${x.round}:${x.majors}`);
   expect(rounds).toEqual(["1:1", `2:${majors}`]);
  }, 60_000);
 }

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
