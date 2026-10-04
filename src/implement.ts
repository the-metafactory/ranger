import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { runCmd, type RunOptions, type RunResult } from "./exec.ts";
import {
 assertGitUntouched,
 assertNoClosingKeywords,
 commitsAhead,
 dirtyFiles,
 fastForwardCanonical,
 findClosingKeyword,
 gitConfigSnapshot,
 headSha,
 safeGit,
 vettedPush,
} from "./git-ops.ts";
import * as gh from "./github.ts";
import type { CheckRun, IssueComment, PullRequest } from "./github.ts";
import { GRAPH_CALL_TIMEOUT_MS, type NodeResult } from "./graph.ts";
import { graphClose, graphDecisions, type CloseResult } from "./graph-write.ts";
import type { ImplementPhase, Journal } from "./journal.ts";
import { assembleImplementPrompt } from "./prompt.ts";
import { ReviewError, sageReview, type ReviewVerdict } from "./review.ts";
import {
 confirmCap,
 selectSubstrate,
 workerOutputFor,
 type CapSignal,
 type SubstrateName,
 type SubstrateReaders,
} from "./substrate.ts";
import { selectForReview } from "./substrate-policy.ts";
import { workerEnv } from "./worker-env.ts";
import { saveWorkerLog } from "./worker-log.ts";

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
 mergePr(repo: string, n: number, sha: string, title: string, token: string): Promise<void>;
 issueLabels(repo: string, n: number, token: string): Promise<string[]>;
 postComment(repo: string, n: number, body: string, token: string): Promise<number>;
 listComments(repo: string, n: number, token: string): Promise<IssueComment[]>;
}

export const realGitHub: GitHubPort = gh;

export type Reviewer = (
 repo: string,
 prNumber: number,
 readOnlyToken: string,
 opts?: { substrate?: SubstrateName },
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
 /** How long to wait for GitHub to show a pushed head (default 2 min; tests shorten it). */
 headPollMs?: number;
 /** The substrate the worker runs on (node #45). */
 substrate?: SubstrateName;
 /** Quota readers for review selection and cap confirmation (tests inject them). */
 substrateReaders?: SubstrateReaders;
 /** Substrates capped earlier in this run: review selection leaves them out. */
 excludedSubstrates?: ReadonlySet<SubstrateName>;
}

export interface ImplementOutcome {
 status: "success" | "failed" | "refused" | "parked" | "awaiting-merge";
 detail: string;
 workerExit: number | null;
 close?: CloseResult;
 prNumber?: number;
 /** When the failure was caused by a substrate rate limit (node #45). */
 substrateCapped?: CapSignal;
}

/** A failure that parks the node for the principal instead of counting toward the dead-man. */
export class ParkSignal extends Error {
 override readonly name = "ParkSignal";
}

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const TEST_TIMEOUT_MS = 20 * 60 * 1000;

/** The review-round marker ranger writes into each review comment it posts. */
export function reviewMarker(round: number, v: ReviewVerdict, substrate?: SubstrateName): string {
 const base = `<!-- ranger:review round=${round} sha=${v.commitId} blockers=${v.blockers} majors=${v.majors} nits=${v.nits}`;
 return substrate !== undefined ? `${base} substrate=${substrate} -->` : `${base} -->`;
}

export interface RecordedReview {
 round: number;
 sha: string;
 blockers: number;
 majors: number;
 nits: number;
 /** The substrate the review ran on (node #45); undefined for old markers. */
 substrate?: string;
 /** The review text, without the marker — the fix pass's input on a resume. */
 body: string;
}

const MARKER = /<!-- ranger:review round=(\d+) sha=([0-9a-f]{7,64}) blockers=(\d+) majors=(\d+) nits=(\d+)(?:\s+substrate=(\w+))? -->/;

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
   substrate: m[6] ?? undefined,
   body: c.body.replace(MARKER, "").trim(),
  });
 }
 return out.sort((a, b) => a.round - b.round);
}

/** A node that needs the principal's eye (or ear): its PR is merged by hand, never by ranger. */
export const NEEDS_EYE_LABEL = "ranger:needs-eye";

/** The findings that gate a PR: blockers and majors (principal, 2026-10-03). */
export function gatingFindings(r: { blockers: number; majors: number }): number {
 return r.blockers + r.majors;
}

export interface RecordedProbe {
 sha: string;
 passed: boolean;
 /** Probes the selector chose ("?" when the output did not say). */
 selected: string;
 mode: string;
}

const PROBE_MARKER =
 /<!-- ranger:probes sha=([0-9a-f]{7,64}) result=(pass|fail) selected=(\d+|\?) mode=([\w-]+) -->/;

export function probeMarker(p: RecordedProbe): string {
 return `<!-- ranger:probes sha=${p.sha} result=${p.passed ? "pass" : "fail"} selected=${p.selected} mode=${p.mode} -->`;
}

/** Probe runs recorded on the PR by the MACHINE ACCOUNT (anyone else's markers are ignored). */
export function recordedProbes(
 comments: IssueComment[],
 botIdentity: string,
): RecordedProbe[] {
 const out: RecordedProbe[] = [];
 for (const c of comments) {
  if (c.author !== botIdentity) continue;
  const m = c.body.match(PROBE_MARKER);
  if (m === null) continue;
  out.push({ sha: m[1], passed: m[2] === "pass", selected: m[3], mode: m[4] });
 }
 return out;
}

/** A probe file name as the runner prints it: no path, no shell metacharacters. */
const PROBE_FILE = /^[\w.-]+\.m?js$/;

/**
 * The probes a failed run names on its `FAILED: a.mjs · b.mjs` line (the
 * seelite runner's summary). Empty when there is no such line or any name
 * is not a plain probe file name, so the caller falls back to the full suite.
 */
export function parseFailedProbes(stdout: string): string[] {
 const line = stdout.match(/^FAILED: (.+)$/m)?.[1];
 if (line === undefined) return [];
 const names = line.split("·").map((n) => n.trim()).filter(Boolean);
 return names.length > 0 && names.every((n) => PROBE_FILE.test(n)) ? names : [];
}

export function probeRetryCommandFor(template: string, nodeId: string, failed: string[]): string {
 if (failed.length === 0 || !failed.every((n) => PROBE_FILE.test(n))) {
  throw new ParkSignal("refusing to template probe names that are not plain probe file names");
 }
 return probeCommandFor(template, nodeId).replaceAll("{failed}", failed.join(","));
}

/** The selector's own summary lines (`probe selection: <mode>`, `selected: <n>`). */
export function parseProbeSummary(stdout: string): { selected: string; mode: string } {
 const mode = stdout.match(/^probe selection: ([\w-]+)/m)?.[1] ?? "unknown";
 const selected = stdout.match(/^selected: (\d+)/m)?.[1] ?? "?";
 return { selected, mode };
}

/** `commands.probe` with `{node}` replaced — the node id is digits, so nothing else gets in. */
export function probeCommandFor(template: string, nodeId: string): string {
 if (!/^\d+$/.test(nodeId)) {
  throw new ParkSignal(`node id ${nodeId} is not numeric — refusing to template the probe command`);
 }
 return template.replaceAll("{node}", nodeId);
}

/**
 * The probe tier (#23 follow-up, principal's choice 2026-10-03): run the
 * map's probe command ONCE on the final, sage-clean head — exactly the head
 * the merge card certifies. A failure is retried once (design §7's flaky-probe
 * rule), then the node parks with the output. Every run is recorded on the PR
 * as a bot marker; a passing record at the same head is reused on resume.
 */
async function probeFinalHead(
 ctx: ImplementContext,
 github: GitHubPort,
 prNumber: number,
): Promise<RecordedProbe> {
 const { map, journal, node, token, botIdentity, worktree } = ctx;
 const repo = map.repo;
 const nodeId = node.ref.id;
 const live = await github.getPr(repo, prNumber, token);
 const existing = recordedProbes(
  await github.listComments(repo, prNumber, token),
  botIdentity,
 ).find((p) => p.sha === live.headSha && p.passed);
 if (existing !== undefined) return existing;

 if ((await headSha(worktree)) !== live.headSha) {
  throw new ParkSignal(
   `the worktree is not at PR #${prNumber}'s head ${live.headSha.slice(0, 8)} — refusing to certify probes for a different tree`,
  );
 }
 const command = probeCommandFor(map.commands.probe as string, nodeId);
 const timeoutMs = map.commands.probeTimeoutMin * 60_000;
 let result = await runShell(command, worktree, ctx, timeoutMs);
 let attempts = 1;
 let ranCommand = command;
 // The record names the selection of the first run: a narrowed retry selects only the failures.
 const summary = parseProbeSummary(result.stdout);
 if (result.code !== 0) {
  // A run that named its failures (exit > 0) retries only those, when the map
  // says how; a timeout or a runner crash (exit < 0, no FAILED line) reruns all.
  const failed = result.code > 0 ? parseFailedProbes(result.stdout) : [];
  const retryTemplate = map.commands.probeRetry;
  if (retryTemplate !== undefined && failed.length > 0) {
   ranCommand = probeRetryCommandFor(retryTemplate, nodeId, failed);
  }
  const what = ranCommand === command ? "the full suite" : `only ${failed.join(", ")}`;
  journal.recordEvent("reviewed", { nodeId, repo, detail: `probe run 1 failed (exit ${result.code}) — retrying ${what}` });
  result = await runShell(ranCommand, worktree, ctx, timeoutMs);
  attempts = 2;
 }
 const record: RecordedProbe = {
  sha: live.headSha,
  passed: result.code === 0,
  ...summary,
 };
 ctx.journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, "post the probe record");
 await github.postComment(repo, prNumber, probeComment(ranCommand, record, attempts, result), token);
 journal.recordEvent("reviewed", {
  nodeId,
  repo,
  detail: `probes ${record.passed ? "passed" : "FAILED"} at ${record.sha.slice(0, 8)} (${record.mode}, ${record.selected} selected, ${attempts} run(s))`,
 });
 if (!record.passed) {
  throw new ParkSignal(
   `browser probes failed twice at ${record.sha.slice(0, 8)} on PR #${prNumber} (exit ${result.code}): ${tail(result)}`,
  );
 }
 return record;
}

function probeComment(
 command: string,
 p: RecordedProbe,
 attempts: number,
 result: RunResult,
): string {
 const out = (result.stdout + (result.stderr ? `\n${result.stderr}` : "")).trim();
 const clipped = out.length > 20_000 ? `…${out.slice(-20_000)}` : out;
 return [
  probeMarker(p),
  `**Probes — ${p.passed ? "passed" : "failed"}** at \`${p.sha.slice(0, 8)}\` (selection ${p.mode}, ${p.selected} probe(s); ${attempts} run(s))`,
  "",
  `\`${command}\``,
  "",
  "<details><summary>output</summary>",
  "",
  "```",
  clipped,
  "```",
  "</details>",
 ].join("\n");
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
  journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, action);

 const testCommand = map.commands.test;
 if (testCommand === undefined) {
  return {
   status: "refused",
   detail: `map ${repo} declares no commands.test — the implement lane will not push untested work`,
   workerExit: null,
  };
 }

 // F2 resume: the recorded PR first (a head-branch lookup misses a PR whose
 // branch was deleted on merge), then the PR found by head branch.
 const recorded = journal.getWorker(nodeId, ctx.map.repo)?.prNumber ?? null;
 let pr =
  recorded === null
   ? await github.findPrByHead(repo, branch, token)
   : await github.getPr(repo, recorded, token);
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
  journal.updateWorker(nodeId, ctx.map.repo, { phase: "implement" });
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
  recordHead(ctx, built.sha);

  const title = prTitle(node);
  fence("open PR");
  pr = await github.createDraftPr(
   repo,
   { head: branch, base, title, body: draftBody(ctx) },
   token,
  );
  journal.updateWorker(nodeId, ctx.map.repo, { phase: "review", prNumber: pr.number });
  await awaitHead(github, repo, pr.number, built.sha, token, ctx.headPollMs);
  journal.recordEvent("pr-opened", { nodeId, repo, detail: `PR #${pr.number} (draft) ${pr.url}` });
 }

 // ---- review loop ----
 const open = pr as PullRequest;
 journal.updateWorker(nodeId, ctx.map.repo, { phase: "review", prNumber: open.number });
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
   const { substrate: reviewSubstrate, chosenOn } = await selectReviewSubstrate(ctx, live.headSha);
   let verdict: ReviewVerdict;
   try {
    verdict = await (ctx.reviewer ?? sageReview)(repo, open.number, ctx.readOnlyToken, {
     substrate: reviewSubstrate,
    });
   } catch (error) {
    // A review that failed on its substrate's limit resumes elsewhere; any
    // other review failure is an ordinary one.
    if (!(error instanceof ReviewError)) throw error;
    const capSignal = await confirmCap(reviewSubstrate, journal, { readers: ctx.substrateReaders });
    if (capSignal === null) throw error;
    return {
     status: "failed",
     detail: `sage review round ${round} on ${reviewSubstrate} hit its rate limit: ${error.message.slice(0, 300)}`,
     workerExit,
     prNumber: open.number,
     substrateCapped: capSignal,
    };
   }
   if (verdict.commitId !== live.headSha) {
    throw new ParkSignal(
     `sage reviewed ${verdict.commitId.slice(0, 8)} but PR #${open.number}'s head is ${live.headSha.slice(0, 8)} — the head moved during review`,
    );
   }
   fence("post review");
   await github.postComment(
    repo,
    open.number,
    reviewComment(round, verdict, reviewSubstrate),
    token,
   );
   current = {
    round,
    sha: verdict.commitId,
    blockers: verdict.blockers,
    majors: verdict.majors,
    nits: verdict.nits,
    substrate: reviewSubstrate,
    body: verdict.body,
   };
   reviews = [...reviews, current];
   journal.recordEvent("reviewed", {
    nodeId,
    repo,
    detail: `round ${round} @ ${verdict.commitId.slice(0, 8)}: ${verdict.verdict}, ${verdict.blockers} blocker(s), ${verdict.majors} major(s)${chosenOn}`,
   });
  }
  journal.updateWorker(nodeId, ctx.map.repo, {
   reviewRound: current.round,
   verdictSha: current.sha,
   verdictBlockers: current.blockers,
  });
  // Blockers AND majors gate (principal, 2026-10-03): each is reworked and
  // re-reviewed. Suggestions and nits do not gate.
  if (gatingFindings(current) === 0) break;
  if (current.round >= cap) {
   throw new ParkSignal(
    `${current.blockers} blocker(s) and ${current.majors} major(s) remain after ${current.round} sage round(s) on PR #${open.number} — good-enough is the principal's call (design §4/§7)`,
   );
  }
  // One fix pass per review that found blockers or majors. On a resume the review is
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
  recordHead(ctx, fixed.sha);
  await awaitHead(github, repo, open.number, fixed.sha, token, ctx.headPollMs);
 }

 // ---- probe tier, once, on the final head ----
 let probe: RecordedProbe | undefined;
 if (map.commands.probe !== undefined) {
  probe = await probeFinalHead(ctx, github, open.number);
 }

 // ---- ready → awaiting merge ----
 fence("mark ready");
 const final = reviews[reviews.length - 1];
 await github.updatePrBody(repo, open.number, readyBody(ctx, final, reviews.length, probe), token);
 await github.markReady(repo, await github.getPr(repo, open.number, token), token);
 journal.updateWorker(nodeId, ctx.map.repo, {
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

/**
 * Cross-model review selection (node #45): prefer a substrate other than the
 * one that wrote the head; an unrecorded head counts as Pi's. Substrates
 * capped earlier in this run are left out, so a review never re-picks one
 * whose capped-until has lapsed meanwhile.
 */
async function selectReviewSubstrate(
 ctx: ImplementContext,
 headSha: string,
): Promise<{ substrate: SubstrateName; chosenOn: string }> {
 const author = ctx.journal.headSubstrate(ctx.map.repo, headSha) ?? "pi";
 const { substrate, chosenOn } = await selectSubstrate(ctx.journal, {
  config: ctx.config.substrates,
  excluded: ctx.excludedSubstrates ?? new Set<SubstrateName>(),
  readers: ctx.substrateReaders,
  pick: (input) => selectForReview(input, author),
 });
 return { substrate, chosenOn: ` on ${substrate} (head by ${author}; ${chosenOn})` };
}

/** Which substrate wrote a pushed SHA: the review of that head reads it back. */
function recordHead(ctx: ImplementContext, sha: string): void {
 if (ctx.substrate === undefined) return;
 ctx.journal.recordHeadSubstrate({
  sha,
  repo: ctx.map.repo,
  nodeId: ctx.node.ref.id,
  substrate: ctx.substrate,
 });
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
  probeTier: map.commands.probe !== undefined,
 });
 ctx.journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, "spawn the worker");
 const output = workerOutputFor(ctx.substrate);
 const raw = await ctx.workerRun(prompt, {
  cwd: worktree,
  timeoutMs: config.workers.wallClockMin * 60_000,
  env: workerEnv(config, map.repo),
  ...output.runOptions,
  processGroup: true,
  onSpawn: (pgid) => journal.updateWorker(nodeId, ctx.map.repo, { workerPgid: pgid }),
 });
 journal.updateWorker(nodeId, ctx.map.repo, { workerPgid: null });

 // Read on the substrate's own output format (node #45): a Claude stream's
 // quota readings are cached, and its signal lines feed the cap check.
 const { result, lines } = output.read(raw, journal);

 const log = saveWorkerLog(
  journal.path,
  map.repo,
  nodeId,
  ctx.generation,
  review === undefined ? "build pass" : `fix pass ${review.round}`,
  result,
 );
 // Before ANY git call after the worker: a tampered config or hook would run
 // with whatever the next git call carries.
 assertGitUntouched(ctx.canonical, snapshot);

 const fail = (detail: string, substrateCapped?: CapSignal): PassResult => ({
  workerExit: result.code,
  snapshot,
  sha: before,
  failure: {
   status: "failed",
   detail: `${detail} (worker log: ${log})`,
   workerExit: result.code,
   ...(substrateCapped === undefined ? {} : { substrateCapped }),
  },
 });
 if (result.code !== 0) {
  // Mid-session cap (node #45): only the substrate's own signal says so, and
  // only a failed run can be one. A capped failure does not count.
  const capSignal: CapSignal | null =
   ctx.substrate === undefined
    ? null
    : await confirmCap(ctx.substrate, journal, { lines, readers: ctx.substrateReaders });
  if (capSignal !== null) return fail(`substrate ${capSignal.substrate} hit its rate limit`, capSignal);
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
 // The supervisor tests the working tree but pushes commits: a dirty tree
 // would let a green test run cover code that never lands.
 const dirty = await dirtyFiles(worktree);
 if (dirty.length > 0) {
  return fail(
   `worker left ${dirty.length} uncommitted or untracked file(s) (${dirty.slice(0, 5).join("; ")}) — the tests would not test what gets pushed`,
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
 journal.updateWorker(nodeId, ctx.map.repo, { phase: "close", prNumber: pr.number });

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

 const probe = recordedProbes(await github.listComments(repo, pr.number, token), botIdentity).find(
  (p) => p.sha === pr.headSha && p.passed,
 );
 const resolution = closeResolution(ctx, pr, final, reviews.length, success, probe);
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
   summary: `CI check run ${success.name} succeeded at ${pr.headSha.slice(0, 8)}; ${ratificationText(ctx, pr)}`,
   pointer: `https://github.com/${repo}/runs/${success.id}`,
  });
 }

 journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, "close the node");
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
  journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, "write decisions");
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
 await safeGit(["worktree", "remove", "--force", ctx.worktree], {
  cwd: ctx.canonical,
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

/**
 * GitHub can serve a PR's previous head for a few seconds after a push. Wait
 * until it shows the pushed SHA before reviewing, or a stale head would match
 * the last round's verdict again (a spurious second fix pass) or look like a
 * mid-review push (a spurious park).
 */
async function awaitHead(
 github: GitHubPort,
 repo: string,
 prNumber: number,
 sha: string,
 token: string,
 timeoutMs = 120_000,
): Promise<void> {
 const deadline = Date.now() + timeoutMs;
 for (;;) {
  const live = await github.getPr(repo, prNumber, token);
  if (live.headSha === sha) return;
  if (Date.now() >= deadline) {
   throw new ParkSignal(
    `GitHub still shows PR #${prNumber} at ${live.headSha.slice(0, 8)}, not the pushed ${sha.slice(0, 8)}, after ${Math.round(timeoutMs / 1000)}s`,
   );
  }
  await Bun.sleep(3_000);
 }
}

/** GitHub caps a comment at 65 536 characters; the marker always survives, first. */
const COMMENT_BUDGET = 60_000;

function reviewComment(round: number, verdict: ReviewVerdict, substrate?: SubstrateName): string {
 const head = `${reviewMarker(round, verdict, substrate)}\n**Sage review — round ${round}** (offline, machine evidence; not a human sign-off)\n\n`;
 const room = COMMENT_BUDGET - head.length;
 const body =
  verdict.body.length <= room
   ? verdict.body
   : `${verdict.body.slice(0, room - 80)}\n\n… (truncated by ranger; the full review is in the run log)`;
 return head + body;
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

function probeLine(ctx: ImplementContext, probe: RecordedProbe | undefined): string[] {
 if (ctx.map.commands.probe === undefined) return [];
 return probe === undefined
  ? ["- Probes: not recorded at this head."]
  : [`- Probes: passed at \`${probe.sha.slice(0, 8)}\` (selection ${probe.mode}, ${probe.selected} probe(s)). Only the selected probes ran, not the full suite.`];
}

function readyBody(
 ctx: ImplementContext,
 final: RecordedReview,
 rounds: number,
 probe?: RecordedProbe,
): string {
 const ratify = ctx.map.autoMerge
  ? `Ranger squash-merges this itself once the gate passes, unless the node is labelled \`${NEEDS_EYE_LABEL}\`; then the principal merges by hand.${ctx.ratify === "merge" ? " For this `propose` node the merge is the ratification." : ""} Ranger closes the node after the merge.`
  : ctx.ratify === "merge"
   ? "This node is `propose`: **merging this PR is the ratification**. Ranger closes the node after the merge."
   : "Ranger closes the node after the merge, through its declared probes and this PR's CI run.";
 return [
  `Implements ${nodeLink(ctx)}: ${ctx.node.node.title}`,
  "",
  `- Tests: \`${ctx.map.commands.test}\` passed in the supervisor before every push.`,
  `- Sage: ${rounds} offline round(s); the last, at \`${final.sha.slice(0, 8)}\`, found ${final.blockers} blockers, ${final.majors} majors, ${final.nits} nits. Machine review evidence, not a human sign-off.`,
  ...probeLine(ctx, probe),
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
 probe?: RecordedProbe,
): string {
 const deferred =
  final === undefined || final.majors + final.nits === 0
   ? "None."
   : `${final.blockers} blocker(s), ${final.majors} major(s) and ${final.nits} nit(s) from the last sage round are on the PR and not filed back yet (the Scribe, design §6, is a follow-up).`;
 return [
  `Implemented by ranger's implement lane in PR #${pr.number} (${pr.url || `https://github.com/${ctx.map.repo}/pull/${pr.number}`}), merged by ${pr.mergedBy ?? "an unknown login"}${pr.mergeCommitSha === null ? "" : ` as ${pr.mergeCommitSha.slice(0, 8)}`}.`,
  "",
  `- Tests: \`${ctx.map.commands.test}\` passed before every push; CI check run "${ci.name}" (${ci.id}) succeeded on the PR head ${pr.headSha.slice(0, 8)}.`,
  final === undefined
   ? "- Sage: no recorded review round."
   : `- Sage: ${rounds} offline round(s); the last at ${final.sha.slice(0, 8)} found ${final.blockers} blockers, ${final.majors} majors, ${final.nits} nits (machine evidence).`,
  ...probeLine(ctx, probe),
  `- Ratification: ${ctx.ratify === "merge" ? `${ratificationText(ctx, pr)}.` : "auto node; declared probes and CI."}`,
  `- Unfixed review findings: ${deferred}`,
 ].join("\n");
}

/**
 * Who ratified a propose node: the principal's own merge, or ranger's merge
 * under the principal's standing grant (2026-10-03: ranger merges nodes that
 * need no visual judgment; a `ranger:needs-eye` node is merged by hand).
 */
function ratificationText(ctx: ImplementContext, pr: PullRequest): string {
 return pr.mergedBy !== null && pr.mergedBy === ctx.config.principal.login
  ? `the principal merged PR #${pr.number} (merge = ratification, #23 ruling)`
  : `${pr.mergedBy ?? "ranger"} merged PR #${pr.number} under the principal's standing grant (2026-10-03: ranger merges nodes that need no visual judgment)`;
}

function gistLine(title: string, pr: number): string {
 const raw = `${title} — PR #${pr}`;
 return raw.length > 140 ? `${raw.slice(0, 137)}…` : raw;
}
