import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { runCmd, type RunOptions, type RunResult } from "./exec.ts";
import {
 assertNoClosingKeywords,
 commitsAhead,
 fastForwardCanonical,
 findClosingKeyword,
 gitConfigSnapshot,
 headSha,
 vettedPush,
} from "./git-ops.ts";
import * as gh from "./github.ts";
import type { CheckRun, IssueComment, PullRequest } from "./github.ts";
import { GRAPH_CALL_TIMEOUT_MS, type NodeResult } from "./graph.ts";
import { graphClose, graphDecisions, type CloseResult } from "./graph-write.ts";
import type { ImplementPhase, Journal } from "./journal.ts";
import { assembleImplementPrompt } from "./prompt.ts";
import { sageReview, type ReviewVerdict } from "./review.ts";
import { workerEnv } from "./worker-env.ts";

/**
 * The implement lane (design §4 task/build SOP, build-path step 4, node #23).
 *
 * The worker session only implements and commits — it never holds a
 * credential. The supervisor drives everything outward as a phase machine:
 *
 *   implement → (install, worker, tests, vetted push, draft PR)
 *   review    → (offline sage review at the pushed head; fix pass; cap)
 *   awaiting-merge → (PR ready; the tick's merge desk posts the one-tap card)
 *   close     → (after the principal's merge: fast-forward canonical, gated
 *                close citing CI, decisions --write)
 *
 * Phases are resumable (#23 amendment F2, the OpenRig restore-packet
 * pattern): on every run-node start GitHub wins — the PR found by head branch
 * and the bot-authored review markers on it say where to pick up, so a crash
 * mid-review neither restarts the work nor resets the round cap. Every
 * outward action is fenced by the occupant generation (F1).
 */

/** The GitHub surface the lane uses — injectable so tests run without a forge. */
export interface GitHubPort {
 findPrByHead(repo: string, branch: string, token: string): Promise<PullRequest | null>;
 getPr(repo: string, n: number, token: string): Promise<PullRequest>;
 createDraftPr(
  repo: string,
  pr: { head: string; base: string; title: string; body: string },
  token: string,
 ): Promise<PullRequest>;
 updatePrBody(repo: string, n: number, body: string, token: string): Promise<void>;
 markReady(repo: string, pr: PullRequest, token: string): Promise<void>;
 checkRunsFor(repo: string, sha: string, token: string): Promise<CheckRun[]>;
 postComment(repo: string, n: number, body: string, token: string): Promise<number>;
 listComments(repo: string, n: number, token: string): Promise<IssueComment[]>;
}

export const realGitHub: GitHubPort = gh;

export type Reviewer = (
 repo: string,
 prNumber: number,
 readOnlyToken: string,
) => Promise<ReviewVerdict>;

export type WorkerRun = (prompt: string, opts: RunOptions) => Promise<RunResult>;

export interface ImplementContext {
 config: RangerConfig;
 map: RangerMapConfig;
 token: string;
 /** The map's read-only token — the reviewer reads the PR under it (node #8). */
 readOnlyToken: string;
 botIdentity: string;
 journal: Journal;
 node: NodeResult;
 rootNode: NodeResult;
 canonical: string;
 worktree: string;
 branch: string;
 generation: number;
 /** auto: probes + CI close the node. merge: the principal's merge ratifies it (#23 ruling). */
 ratify: "auto" | "merge";
 workerRun: WorkerRun;
 github?: GitHubPort;
 reviewer?: Reviewer;
}

export interface ImplementOutcome {
 status: "success" | "failed" | "refused" | "parked" | "awaiting-merge";
 detail: string;
 workerExit: number | null;
 close?: CloseResult;
 prNumber?: number;
}

/** A failure that parks the node for the principal instead of counting toward the dead-man. */
export class ParkSignal extends Error {
 override readonly name = "ParkSignal";
}

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const TEST_TIMEOUT_MS = 20 * 60 * 1000;

/** The review-round marker ranger writes into each review comment it posts. */
export function reviewMarker(round: number, v: ReviewVerdict): string {
 return `<!-- ranger:review round=${round} sha=${v.commitId} blockers=${v.blockers} majors=${v.majors} nits=${v.nits} -->`;
}

export interface RecordedReview {
 round: number;
 sha: string;
 blockers: number;
 majors: number;
 nits: number;
 /** The review text, without the marker — the fix pass's input on a resume. */
 body: string;
}

const MARKER = /<!-- ranger:review round=(\d+) sha=([0-9a-f]{7,64}) blockers=(\d+) majors=(\d+) nits=(\d+) -->/;

/**
 * The durable review record on the PR: markers in comments the MACHINE
 * ACCOUNT wrote. A marker in anyone else's comment is ignored — otherwise a
 * third party could forge a clean verdict or reset the round cap.
 */
export function recordedReviews(
 comments: IssueComment[],
 botIdentity: string,
): RecordedReview[] {
 const out: RecordedReview[] = [];
 for (const c of comments) {
  if (c.author !== botIdentity) continue;
  const m = c.body.match(MARKER);
  if (m === null) continue;
  out.push({
   round: Number(m[1]),
   sha: m[2],
   blockers: Number(m[3]),
   majors: Number(m[4]),
   nits: Number(m[5]),
   body: c.body.replace(MARKER, "").trim(),
  });
 }
 return out.sort((a, b) => a.round - b.round);
}

/**
 * The branch the lane works on. A declared `git-merged-into` probe names the
 * branch the close checks, so it wins; otherwise the worktree branch.
 */
export function implementBranchFor(
 node: { probes?: { type: string; ref?: string }[] },
 fallback: string,
): string {
 const merged = (node.probes ?? []).find(
  (p) => p.type === "git-merged-into" && typeof p.ref === "string" && p.ref.length > 0,
 );
 return merged?.ref ?? fallback;
}

/** Resolve where to pick up, from GitHub first (F2). */
export function resolvePhase(pr: PullRequest | null): ImplementPhase | "pr-closed" {
 if (pr === null) return "implement";
 if (pr.merged) return "close";
 if (pr.state === "closed") return "pr-closed";
 return "review";
}

export async function runImplement(ctx: ImplementContext): Promise<ImplementOutcome> {
 const { config, map, journal, node, token, botIdentity, branch, worktree } = ctx;
 const github = ctx.github ?? realGitHub;
 const repo = map.repo;
 const nodeId = node.ref.id;
 const base = map.base;
 const fence = (action: string) =>
  journal.assertGeneration(nodeId, ctx.generation, action);

 const testCommand = map.commands.test;
 if (testCommand === undefined) {
  return {
   status: "refused",
   detail: `map ${repo} declares no commands.test — the implement lane will not push untested work`,
   workerExit: null,
  };
 }

 let pr = await github.findPrByHead(repo, branch, token);
 const phase = resolvePhase(pr);
 journal.recordEvent("worker-start", {
  nodeId,
  repo,
  detail: `implement lane resumes at phase ${phase} (branch ${branch}${pr === null ? "" : `, PR #${pr.number}`})`,
 });

 if (phase === "pr-closed") {
  throw new ParkSignal(
   `PR #${pr?.number} for ${branch} was closed without merging — a human declined it; ranger will not reopen or re-propose it`,
  );
 }
 if (phase === "close") {
  return closeAfterMerge(ctx, github, pr as PullRequest);
 }

 // ---- implement ----
 let workerExit: number | null = null;
 if (phase === "implement") {
  journal.updateWorker(nodeId, { phase: "implement" });
  if (map.commands.install !== undefined) {
   const install = await runShell(map.commands.install, worktree, ctx, INSTALL_TIMEOUT_MS);
   if (install.code !== 0) {
    return {
     status: "failed",
     detail: `install (${map.commands.install}) exited ${install.code}: ${tail(install)}`,
     workerExit: null,
    };
   }
  }
  const built = await workerPass(ctx, testCommand, undefined);
  workerExit = built.workerExit;
  if (built.failure !== undefined) return built.failure;

  fence("push");
  await vettedPush({
   worktree,
   canonical: ctx.canonical,
   branch,
   token,
   configSnapshot: built.snapshot,
  });
  journal.recordEvent("pushed", { nodeId, repo, detail: `${branch} @ ${built.sha.slice(0, 8)}` });

  const title = prTitle(node);
  fence("open PR");
  pr = await github.createDraftPr(
   repo,
   { head: branch, base, title, body: draftBody(ctx) },
   token,
  );
  journal.updateWorker(nodeId, { phase: "review", prNumber: pr.number });
  journal.recordEvent("pr-opened", { nodeId, repo, detail: `PR #${pr.number} (draft) ${pr.url}` });
 }

 // ---- review loop ----
 const open = pr as PullRequest;
 journal.updateWorker(nodeId, { phase: "review", prNumber: open.number });
 const cap = config.workers.reviewRounds;
 let reviews = recordedReviews(
  await github.listComments(repo, open.number, token),
  botIdentity,
 );
 for (;;) {
  const live = await github.getPr(repo, open.number, token);
  let current = reviews.find((r) => r.sha === live.headSha);
  if (current === undefined) {
   if (reviews.length >= cap) {
    throw new ParkSignal(
     `review cap reached: ${reviews.length} sage round(s) on PR #${open.number} and the head moved since the last one — a further round is the principal's call (design §4)`,
    );
   }
   const round = reviews.length + 1;
   fence("review");
   const verdict = await (ctx.reviewer ?? sageReview)(repo, open.number, ctx.readOnlyToken);
   if (verdict.commitId !== live.headSha) {
    throw new ParkSignal(
     `sage reviewed ${verdict.commitId.slice(0, 8)} but PR #${open.number}'s head is ${live.headSha.slice(0, 8)} — the head moved during review`,
    );
   }
   fence("post review");
   await github.postComment(
    repo,
    open.number,
    `${reviewMarker(round, verdict)}\n**Sage review — round ${round}** (offline, machine evidence; not a human sign-off)\n\n${verdict.body}`,
    token,
   );
   current = {
    round,
    sha: verdict.commitId,
    blockers: verdict.blockers,
    majors: verdict.majors,
    nits: verdict.nits,
    body: verdict.body,
   };
   reviews = [...reviews, current];
   journal.recordEvent("reviewed", {
    nodeId,
    repo,
    detail: `round ${round} @ ${verdict.commitId.slice(0, 8)}: ${verdict.verdict}, ${verdict.blockers} blocker(s), ${verdict.majors} major(s)`,
   });
  }
  journal.updateWorker(nodeId, {
   reviewRound: current.round,
   verdictSha: current.sha,
   verdictBlockers: current.blockers,
  });
  if (current.blockers === 0) break;
  if (current.round >= cap) {
   throw new ParkSignal(
    `${current.blockers} blocker(s) remain after ${current.round} sage round(s) on PR #${open.number} — good-enough is the principal's call (design §4/§7)`,
   );
  }
  // One fix pass per review that found blockers. On a resume the review is
  // re-read from its PR comment, so a crash between review and fix loses nothing.
  const fixed = await workerPass(ctx, testCommand, {
   round: current.round,
   body: current.body,
  });
  workerExit = fixed.workerExit;
  if (fixed.failure !== undefined) return fixed.failure;
  fence("push fix");
  await vettedPush({
   worktree,
   canonical: ctx.canonical,
   branch,
   token,
   configSnapshot: fixed.snapshot,
  });
  journal.recordEvent("pushed", {
   nodeId,
   repo,
   detail: `fix pass ${current.round} @ ${fixed.sha.slice(0, 8)}`,
  });
 }

 // ---- ready → awaiting merge ----
 fence("mark ready");
 const final = reviews[reviews.length - 1];
 await github.updatePrBody(repo, open.number, readyBody(ctx, final, reviews.length), token);
 await github.markReady(repo, await github.getPr(repo, open.number, token), token);
 journal.updateWorker(nodeId, {
  status: "awaiting-merge",
  phase: "awaiting-merge",
  workerPgid: null,
 });
 journal.recordEvent("awaiting-merge", {
  nodeId,
  repo,
  detail: `PR #${open.number} ready; sage clean at ${final.sha.slice(0, 8)} — the merge card follows once CI is green`,
 });
 return {
  status: "awaiting-merge",
  detail: `PR #${open.number} is ready and waits on the principal's merge`,
  workerExit,
  prNumber: open.number,
 };
}

interface PassResult {
 workerExit: number | null;
 snapshot: string;
 sha: string;
 failure?: ImplementOutcome;
}

/** One worker session (build or fix), then the supervisor's own test + keyword checks. */
async function workerPass(
 ctx: ImplementContext,
 testCommand: string,
 review: { round: number; body: string } | undefined,
): Promise<PassResult> {
 const { config, map, journal, node, worktree, branch, botIdentity } = ctx;
 const nodeId = node.ref.id;
 const snapshot = gitConfigSnapshot(ctx.canonical);
 const before = await headSha(worktree);
 const prompt = assembleImplementPrompt({
  repo: map.repo,
  node: {
   id: nodeId,
   title: node.node.title,
   body: node.body ?? "",
   kind: node.node.kind,
   autonomy: node.node.autonomy,
   checkpointId: node.node.checkpointId,
   url: node.url,
  },
  map: { title: ctx.rootNode.node.title, body: ctx.rootNode.body ?? "" },
  branch,
  worktree,
  botIdentity,
  testCommand,
  review,
 });
 ctx.journal.assertGeneration(nodeId, ctx.generation, "spawn the worker");
 const result = await ctx.workerRun(prompt, {
  cwd: worktree,
  timeoutMs: config.workers.wallClockMin * 60_000,
  env: workerEnv(config, map.repo),
  processGroup: true,
  onSpawn: (pgid) => journal.updateWorker(nodeId, { workerPgid: pgid }),
 });
 journal.updateWorker(nodeId, { workerPgid: null });
 const fail = (detail: string): PassResult => ({
  workerExit: result.code,
  snapshot,
  sha: before,
  failure: { status: "failed", detail, workerExit: result.code },
 });
 if (result.code !== 0) {
  return fail(`worker exited ${result.code}: ${tail(result)}`);
 }
 const sha = await headSha(worktree);
 if (sha === before || (await commitsAhead(worktree, map.base)) === 0) {
  return fail(
   review === undefined
    ? "worker exited 0 but committed nothing — nothing to push"
    : `fix pass ${review.round} committed nothing — the blockers stand`,
  );
 }
 const tests = await runShell(testCommand, worktree, ctx, TEST_TIMEOUT_MS);
 if (tests.code !== 0) {
  return fail(`tests (${testCommand}) failed after the worker (exit ${tests.code}): ${tail(tests)}`);
 }
 await assertNoClosingKeywords(worktree, map.base);
 return { workerExit: result.code, snapshot, sha };
}

/**
 * A repo command (install/test) — it executes worker-written code, so it runs
 * in the worker's env (no credential) and its own process group.
 */
function runShell(
 command: string,
 cwd: string,
 ctx: ImplementContext,
 timeoutMs: number,
): Promise<RunResult> {
 return runCmd("/bin/sh", ["-c", command], {
  cwd,
  env: workerEnv(ctx.config, ctx.map.repo),
  timeoutMs,
  processGroup: true,
 });
}

/** After the principal's merge: fast-forward, gated close citing CI, decisions --write. */
async function closeAfterMerge(
 ctx: ImplementContext,
 github: GitHubPort,
 pr: PullRequest,
): Promise<ImplementOutcome> {
 const { map, journal, node, token, botIdentity } = ctx;
 const repo = map.repo;
 const nodeId = node.ref.id;
 journal.updateWorker(nodeId, { phase: "close", prNumber: pr.number });

 await fastForwardCanonical(ctx.canonical, map.base, token);

 const runs = await github.checkRunsFor(repo, pr.headSha, token);
 const success = runs.find((r) => r.status === "completed" && r.conclusion === "success");
 if (success === undefined) {
  throw new ParkSignal(
   `PR #${pr.number} merged, but no successful check run on its head ${pr.headSha.slice(0, 8)} — nothing for the close to cite`,
  );
 }
 const reviews = recordedReviews(await github.listComments(repo, pr.number, token), botIdentity);
 const final = reviews[reviews.length - 1];

 const resolution = closeResolution(ctx, pr, final, reviews.length, success);
 const resolutionFile = join(tmpdir(), `ranger-close-${repo.replace("/", "__")}-${nodeId}.md`);
 writeFileSync(resolutionFile, resolution, "utf8");

 const prRef = `https://github.com/${repo}/pull/${pr.number}`;
 const evidence: { kind: string; summary: string; pointer: string }[] = [];
 if (final !== undefined) {
  evidence.push({
   kind: "judged",
   summary: `sage review round ${final.round} at ${final.sha.slice(0, 8)}: ${final.blockers} blockers, ${final.majors} majors (machine evidence)`,
   pointer: prRef,
  });
 }
 if (ctx.ratify === "merge") {
  // `tested` is reserved on auto nodes (soma derives it); on a propose node
  // it is informational, and the merged PR is the externally checkable pointer.
  evidence.push({
   kind: "tested",
   summary: `CI check run ${success.name} succeeded at ${pr.headSha.slice(0, 8)}; the principal merged PR #${pr.number} (merge = ratification, #23 ruling)`,
   pointer: `https://github.com/${repo}/runs/${success.id}`,
  });
 }

 journal.assertGeneration(nodeId, ctx.generation, "close the node");
 const close = await graphClose(
  repo,
  nodeId,
  botIdentity,
  token,
  {
   resolutionFile,
   gist: gistLine(node.node.title, pr.number),
   checkpointId: node.node.checkpointId,
   ...(ctx.ratify === "auto" ? { ci: `${success.id}@${pr.headSha}` } : {}),
   evidence,
  },
  { cwd: ctx.canonical, timeoutMs: GRAPH_CALL_TIMEOUT_MS },
 );
 if (!close.closed) {
  throw new ParkSignal(`close refused after merge: ${close.detail.slice(0, 600)}`);
 }
 journal.recordEvent("closed", { nodeId, repo, detail: close.detail.slice(0, 400) });

 let decisionsDetail = "decisions --write after confirmed close";
 try {
  journal.assertGeneration(nodeId, ctx.generation, "write decisions");
  await graphDecisions(repo, String(map.root), token, {
   cwd: ctx.canonical,
   timeoutMs: GRAPH_CALL_TIMEOUT_MS,
  });
 } catch (error) {
  decisionsDetail = `decisions --write FAILED after close: ${error instanceof Error ? error.message : String(error)}`;
  journal.recordEvent("decisions-failed", { nodeId, repo, detail: decisionsDetail.slice(0, 400) });
 }
 journal.recordEvent("decisions-written", { nodeId, repo, detail: decisionsDetail.slice(0, 400) });

 // The merged branch's worktree is ranger's scratch; drop it.
 await runCmd("git", ["worktree", "remove", "--force", ctx.worktree], {
  cwd: ctx.canonical,
  timeoutMs: 60_000,
 });
 rmSync(resolutionFile, { force: true });

 return {
  status: "success",
  detail: close.detail.slice(0, 400),
  workerExit: null,
  close,
  prNumber: pr.number,
 };
}

function tail(result: RunResult): string {
 return (result.stderr.trim() || result.stdout.trim()).slice(-600);
}

/** The node title, refused if it would carry a closing keyword into the squash message. */
function prTitle(node: NodeResult): string {
 const title = `${node.node.title} (node #${node.ref.id})`;
 const hit = findClosingKeyword(title);
 if (hit !== null) {
  throw new ParkSignal(
   `the node title carries a GitHub closing keyword ("${hit}") — as a PR title it would auto-close the node on merge (#588); retitle the node`,
  );
 }
 return title;
}

function nodeLink(ctx: ImplementContext): string {
 return `orienteer node ${ctx.map.repo} #${ctx.node.ref.id}`;
}

function draftBody(ctx: ImplementContext): string {
 return [
  `Draft by ranger's implement lane for ${nodeLink(ctx)}.`,
  "",
  "Ranger reviews this draft with sage (offline) before marking it ready. The real",
  "description replaces this text then.",
 ].join("\n");
}

function readyBody(
 ctx: ImplementContext,
 final: RecordedReview,
 rounds: number,
): string {
 const ratify =
  ctx.ratify === "merge"
   ? "This node is `propose`: **merging this PR is the ratification**. Ranger closes the node after the merge."
   : "Ranger closes the node after the merge, through its declared probes and this PR's CI run.";
 return [
  `Implements ${nodeLink(ctx)}: ${ctx.node.node.title}`,
  "",
  `- Tests: \`${ctx.map.commands.test}\` passed in the supervisor before every push.`,
  `- Sage: ${rounds} offline round(s); the last, at \`${final.sha.slice(0, 8)}\`, found ${final.blockers} blockers, ${final.majors} majors, ${final.nits} nits. Machine review evidence, not a human sign-off.`,
  `- Merge: ranger never merges. ${ratify}`,
  "",
  "Squash-merge keeps one commit per node. The node is not referenced with a closing keyword on purpose: the close goes through the graph's gate.",
 ].join("\n");
}

function closeResolution(
 ctx: ImplementContext,
 pr: PullRequest,
 final: RecordedReview | undefined,
 rounds: number,
 ci: CheckRun,
): string {
 const deferred =
  final === undefined || final.majors + final.nits === 0
   ? "None."
   : `${final.majors} major(s) and ${final.nits} nit(s) from the last sage round were not gating and are not filed back yet (the Scribe, design §6, is a follow-up); they are on the PR.`;
 return [
  `Implemented by ranger's implement lane in PR #${pr.number} (${pr.url || `https://github.com/${ctx.map.repo}/pull/${pr.number}`}), merged by the principal${pr.mergeCommitSha === null ? "" : ` as ${pr.mergeCommitSha.slice(0, 8)}`}.`,
  "",
  `- Tests: \`${ctx.map.commands.test}\` passed before every push; CI check run "${ci.name}" (${ci.id}) succeeded on the PR head ${pr.headSha.slice(0, 8)}.`,
  final === undefined
   ? "- Sage: no recorded review round."
   : `- Sage: ${rounds} offline round(s); the last at ${final.sha.slice(0, 8)} found ${final.blockers} blockers, ${final.majors} majors, ${final.nits} nits (machine evidence).`,
  `- Ratification: ${ctx.ratify === "merge" ? "the principal's merge of the PR (propose node, #23 ruling)." : "auto node; declared probes and CI."}`,
  `- Unfixed review findings: ${deferred}`,
 ].join("\n");
}

function gistLine(title: string, pr: number): string {
 const raw = `${title} — PR #${pr}`;
 return raw.length > 140 ? `${raw.slice(0, 137)}…` : raw;
}
