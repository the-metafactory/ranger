import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { runCmd } from "../src/exec.ts";
import type { ChangeRequest, CiFailedRun, CiPurpose, IssueComment, MergeState } from "../src/forge.ts";
import type { CheckRun } from "../src/github.ts";
import { githubCiVerdict } from "../src/github-ci.ts";
import type { ForgePort } from "../src/implement.ts";
import { openJournal, type Journal } from "../src/journal.ts";
import type { ReviewVerdict } from "../src/review.ts";
import type { RunNodeContext } from "../src/worker.ts";
import { eligibleCodexReading } from "./fixtures/substrate-readings.ts";
import { baseConfigLines, createCanonicalRepo, GIT_ENV } from "./support.ts";

export const fixturesBin = join(import.meta.dir, "fixtures", "bin");
const dataDir = join(import.meta.dir, "fixtures", "data");
export const implementWorker = join(fixturesBin, "implement-worker");

/** A load reader that yields `loads` in order, then repeats the last. */
export const loadSequence = (loads: number[], cores: number) => () => ({ load: loads.length > 1 ? (loads.shift() as number) : loads[0], cores });
export const BOT = "ivy-bot";

/** In-memory forge over the real bare origin: a PR's head is the origin branch's tip. */
export class FakeGitHub implements ForgePort {
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
   body: pr.body,
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
 /** Heads whose merge CI is red (a lint job failed), whatever `checkRuns` says. */
 redHeads = new Set<string>();
 /** Every head a CI fix pass's log was read for. */
 logReads: number[][] = [];
 async ciVerdictFor(_repo: string, sha: string, _token: string, purpose?: CiPurpose) {
  if ((purpose ?? "merge") === "merge" && this.redHeads.has(sha)) {
   return githubCiVerdict(_repo, [...this.checkRuns, { id: 202, name: "lint", status: "completed", conclusion: "failure" }], purpose);
  }
  return githubCiVerdict(_repo, this.checkRuns, purpose);
 }
 async ciFailureLog(_repo: string, runs: CiFailedRun[]) {
  this.logReads.push(runs.map((r) => r.id));
  return "### lint (failure)\nsrc/feature.ts:1:1 error  no-unused-vars";
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
  return { status: "merged" as const };
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
 behavior: number[] = [0],
) {
 const calls: number[] = [];
 const reviewer = async (_repo: string, pr: number): Promise<ReviewVerdict> => {
  const round = calls.length + 1;
  calls.push(pr);
  await onReview?.(round);
  const head = (await github.getPr("acme/widgets", pr)).headSha;
  const b = blockers[Math.min(round - 1, blockers.length - 1)];
  const m = majors[Math.min(round - 1, majors.length - 1)];
  const impact = behavior[Math.min(round - 1, behavior.length - 1)];
  return {
   verdict: b + m > 0 ? "changes-requested" : "approved",
   summary: `round ${round}`,
   commitId: head,
   blockers: b,
   majors: m,
   nits: 2,
   body: `## Sage\n\nRound ${round}: ${b} blocker(s), ${m} major(s).\n\nRound impact: behavior ${impact}, checks 0, prose 2; unclassified impact 0; prior-round surface 0; restated from earlier rounds 0.`,
  };
 };
 return { reviewer, calls };
}

export interface Rig {
 dir: string;
 origin: string;
 canonical: string;
 journal: Journal;
 statePath: string;
 ctx: RunNodeContext;
 github: FakeGitHub;
}

export const savedEnv = { ...process.env };

/** Put process.env back to what it was before `rig` changed it. */
export function restoreEnv(): void {
 for (const key of Object.keys(process.env)) if (!(key in savedEnv)) Reflect.deleteProperty(process.env, key);
 Object.assign(process.env, savedEnv);
}

export async function rig(opts: {
 nodeId?: string;
 root?: number;
 autonomy?: "auto" | "propose";
 author?: string;
 body?: (node: { title: string; kind: string; checkpointId: string; autonomy: string; probes: unknown }) => string;
 blockers?: number[];
 majors?: number[];
 behavior?: number[];
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
 /** The node's probes (default: src/feature.ts exists on main). */
 probes?: { type: string; [key: string]: unknown }[];
}): Promise<Rig & { calls: number[]; announced: string[] }> {
 const nodeId = opts.nodeId ?? "20";
 const dir = mkdtempSync(join(tmpdir(), "ranger-implement-"));
 const { origin, canonical } = await createCanonicalRepo(dir);

 const data = join(dir, "data");
 mkdirSync(data);
 copyFileSync(join(dataDir, "acme__widgets-node-1.json"), join(data, "acme__widgets-node-1.json"));
 const probes = opts.probes ?? [{ type: "artifact-exists", path: "src/feature.ts", atRef: "main" }];
 const node = {
  id: nodeId,
  title: "Add the feature module",
  kind: "task",
  checkpointId: "feature-shipped",
  autonomy: opts.autonomy ?? "auto",
  probes,
 };
 writeFileSync(
  join(data, `acme__widgets-node-${nodeId}.json`),
  JSON.stringify({
   repo: "acme/widgets",
   ref: { id: nodeId },
   node,
   status: "open",
   assignees: [BOT],
   blockedBy: [],
   author: opts.author ?? "alice",
   url: `https://github.com/acme/widgets/issues/${nodeId}`,
   typed: true,
   parent: { id: "1" },
   body: opts.body?.(node) ?? "## Task\n\nAdd src/feature.ts and its test.",
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
 const { reviewer, calls } = scriptedReviewer(github, opts.blockers ?? [0], opts.onReview, opts.majors ?? [0], opts.behavior ?? [0]);
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
  substrateReaders: {
   claude: () => Promise.reject(new Error("probe down")),
   codex: eligibleCodexReading,
  },
 };
 return { dir, origin, canonical, journal, statePath, ctx, github, calls, announced };
}
