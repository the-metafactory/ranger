import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordAnnouncer } from "./announce.ts";
import { mapKey } from "./maps.ts";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { runCmd, type RunOptions, type RunResult } from "./exec.ts";
import {
 assertGitUntouched,
 assertNoClosingKeywords,
 commitsAhead,
 dirtyFiles,
 fastForwardCanonical,
 findClosingKeyword,
 GitSafetyError,
 gitConfigSnapshot,
 headSha,
 safeGit,
 vettedPush,
} from "./git-ops.ts";
import * as gh from "./github.ts";
import type { CheckRun, IssueComment, PullRequest, GitHubPort } from "./github.ts";
import { ParkSignal } from "./signals.ts";
import {
 PROBE_FILE,
 parseFailedChecks,
 parseFailedProbes,
 baseConflictOutcome,
 policyBlockedOutcome,
 probesFailedOutcome,
 reviewCapHeadMovedOutcome,
 reviewCapOutcome,
} from "./outcomes.ts";
import { GRAPH_CALL_TIMEOUT_MS, type NodeResult } from "./graph.ts";
import { graphClose, graphDecisions, type CloseResult } from "./graph-write.ts";
import type { ImplementPhase, Journal } from "./journal.ts";
import { assembleImplementPrompt } from "./prompt.ts";
import { ReviewError, sageReview, type ReviewVerdict } from "./review.ts";
import {
 confirmCap,
 hookStopReason,
 selectSubstrate,
 workerOutputFor,
 type CapSignal,
 type SubstrateName,
 type SubstrateReaders,
} from "./substrate.ts";
import { selectForReview } from "./substrate-policy.ts";
import { failedSessionOutcome, recordSession } from "./substrate-usage.ts";
import { workerEnv } from "./worker-env.ts";
import { saveWorkerLog } from "./worker-log.ts";
import { captureViews, redactViewsReason, saveViewsRecord, viewsComment, viewsDirectory, type ViewsDependencies, type ViewsRecord } from "./views.ts";
import { NEEDS_EYE_LABEL } from "./labels.ts";

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

export type { GitHubPort } from "./github.ts";
export { ParkSignal } from "./signals.ts";

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
 /** The model the worker command pins (node #60); unset when ranger did not build the command. */
 model?: string;
 /** Quota readers for review selection and cap confirmation (tests inject them). */
 substrateReaders?: SubstrateReaders;
 /** Substrates capped earlier in this run: review selection leaves them out. */
 excludedSubstrates?: ReadonlySet<SubstrateName>;
 /** Capture shell/server injection; tests launch no browser. */
 viewsDependencies?: ViewsDependencies;
 /** The host load the probe tier waits on (tests inject a quiet or busy host). */
 hostLoad?: HostLoad;
 /** How often and how long the probe tier waits for a quiet host. */
 quietHost?: { pollMs: number; maxMs: number };
 /** How often and how many times to ask GitHub for a PR's mergeability (tests shorten it). */
 mergeablePoll?: { pollMs: number; attempts: number };
 /** Posts to the map's channel (the base-red notice); tests capture it. */
 announce?: (text: string) => Promise<unknown>;
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

export { parseFailedProbes };
export { NEEDS_EYE_LABEL } from "./labels.ts";

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
 /**
  * Probes that failed twice at this head and fail at its merge base too:
  * the base is red on them, so they do not gate this branch. Undefined when
  * every probe passed.
  */
 baseRed?: string[];
}

const PROBE_MARKER =
 /<!-- ranger:probes sha=([0-9a-f]{7,64}) result=(pass|fail) selected=(\d+|\?) mode=([\w-]+)(?: base-red=([\w.,-]+))? -->/;

export function probeMarker(p: RecordedProbe): string {
 const baseRed = p.baseRed !== undefined && p.baseRed.length > 0 ? ` base-red=${p.baseRed.join(",")}` : "";
 return `<!-- ranger:probes sha=${p.sha} result=${p.passed ? "pass" : "fail"} selected=${p.selected} mode=${p.mode}${baseRed} -->`;
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
  const baseRed = m[5]?.split(",").filter((n) => PROBE_FILE.test(n));
  out.push({
   sha: m[1],
   passed: m[2] === "pass",
   selected: m[3],
   mode: m[4],
   ...(baseRed !== undefined && baseRed.length > 0 ? { baseRed } : {}),
  });
 }
 return out;
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
 await awaitQuietHost(ctx, "probe run 1");
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
  await awaitQuietHost(ctx, "the probe retry");
  result = await runShell(ranCommand, worktree, ctx, timeoutMs);
  attempts = 2;
 }
 const failed = result.code > 0 ? parseFailedProbes(result.stdout) : [];
 // A failure the merge base shares is the base's, not this branch's
 // (2026-10-05: main went red on one probe and parked every later node).
 const base = result.code === 0 ? null : await probeMergeBase(ctx, failed, result.stdout);
 if (base !== null) journal.recordEvent("reviewed", { nodeId, repo, detail: baseProbeDetail(base) });
 const baseRed = base !== null && base.red.length === failed.length ? base.red : undefined;
 if (baseRed !== undefined) await announceBaseRed(ctx, (base as BaseProbeResult).sha, baseRed);
 const record: RecordedProbe = {
  sha: live.headSha,
  passed: result.code === 0 || baseRed !== undefined,
  ...summary,
  ...(baseRed === undefined ? {} : { baseRed }),
 };
 ctx.journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, "post the probe record");
 await github.postComment(repo, prNumber, probeComment(ranCommand, record, attempts, result), token);
 journal.recordEvent("reviewed", {
  nodeId,
  repo,
  detail: `probes ${record.passed ? "passed" : "FAILED"} at ${record.sha.slice(0, 8)} (${record.mode}, ${record.selected} selected, ${attempts} run(s))${baseRed === undefined ? "" : `; red on the merge base too, not gating: ${baseRed.join(", ")}`}`,
 });
 if (!record.passed) {
  throw new ParkSignal(
   probesFailedOutcome({
    sha: record.sha,
    pr: prNumber,
    exit: result.code,
    failed,
    redOnBase: base?.red ?? [],
    tail: tail(result),
   }),
  );
 }
 return record;
}

/** The host's 1-minute load and core count: the probe tier waits for a quiet host. */
export type HostLoad = () => { load: number; cores: number };

const realHostLoad: HostLoad = () => ({ load: loadavg()[0], cores: availableParallelism() });

/** How long a probe run waits for the host to quiet down before running anyway. */
const QUIET_HOST = { pollMs: 30_000, maxMs: 20 * 60_000 };

/**
 * Wait until the 1-minute load is below the core count before a probe run.
 * The browser probes are timing-sensitive, and the headless lane's worker and
 * test runs load the same host (2026-10-04: probe-gamepad failed at peak load
 * 28.6 on 10 cores during node 58's fix pass, and the immediate retry ran
 * under the same load; one quiet run passed the same head). After `maxMs`
 * the run goes ahead anyway: a busy host delays the probe tier, never stops it.
 */
async function awaitQuietHost(ctx: ImplementContext, run: string): Promise<void> {
 const read = ctx.hostLoad ?? realHostLoad;
 const { pollMs, maxMs } = ctx.quietHost ?? QUIET_HOST;
 let host = read();
 if (host.load < host.cores) return;
 const nodeId = ctx.node.ref.id;
 const repo = ctx.map.repo;
 const started = Date.now();
 ctx.journal.recordEvent("reviewed", {
  nodeId,
  repo,
  detail: `${run} waits for the host: load ${host.load.toFixed(1)} on ${host.cores} cores`,
 });
 while (host.load >= host.cores && Date.now() - started < maxMs) {
  await new Promise((r) => setTimeout(r, pollMs));
  host = read();
 }
 const waited = Math.round((Date.now() - started) / 1000);
 ctx.journal.recordEvent("reviewed", {
  nodeId,
  repo,
  detail:
   host.load < host.cores
    ? `${run} starts after ${waited}s: load ${host.load.toFixed(1)} on ${host.cores} cores`
    : `${run} starts on a busy host after ${waited}s: load ${host.load.toFixed(1)} on ${host.cores} cores`,
 });
}

interface BaseProbeResult {
 /** The merge base the probes ran at. */
 sha: string;
 /** Failed probes that fail the same checks at the merge base: the base's failure, not this branch's. */
 red: string[];
 /** Failed probes that fail at the merge base too, but not the same way (another check, or a crash), so they gate. */
 differs: string[];
 /** Failed probes that pass at the merge base: the branch broke them. */
 passed: string[];
 /** Failed probes the branch added or edited: the base runs another probe under that name, so they gate. */
 changed: string[];
}

/** The journal line for a merge-base probe check. */
function baseProbeDetail(b: BaseProbeResult): string {
 const at = `the merge base ${b.sha.slice(0, 8)}`;
 return [
  b.red.length > 0 ? `${b.red.join(", ")} fail at ${at} too` : null,
  b.differs.length > 0 ? `${b.differs.join(", ")} fail at ${at} too, but not the same way — they gate` : null,
  b.passed.length > 0 ? `${b.passed.join(", ")} pass at ${at} — the failure is this branch's` : null,
  b.changed.length > 0 ? `${b.changed.join(", ")} are new or changed on this branch — they gate` : null,
 ].filter((part) => part !== null).join("; ");
}

/** File names (no directory) in git's newline-separated path output. */
function fileNames(stdout: string): Set<string> {
 return new Set(stdout.split("\n").filter(Boolean).map((p) => p.slice(p.lastIndexOf("/") + 1)));
}

/**
 * Run the probes that failed at the head once more at the branch's merge base
 * with the map base, in a throwaway detached worktree. A probe the branch
 * added or edited is not compared: the base would run another probe under
 * its name, so it gates whatever the base says. A probe file holds many
 * checks, so one red at the base is the base's only when every check it
 * fails here fails there too, and both runs ended as assertion failures; a
 * crash, kill or timeout cannot be compared and gates. Null when the answer is
 * unknown: no retry template to name exact probes, no named failures, or a
 * base run that could not be set up, timed out, or named nothing.
 */
async function probeMergeBase(
 ctx: ImplementContext,
 failed: string[],
 headStdout: string,
): Promise<BaseProbeResult | null> {
 const { map, worktree } = ctx;
 const template = map.commands.probeRetry;
 if (template === undefined || failed.length === 0) return null;
 const merged = await safeGit(["merge-base", "HEAD", `origin/${map.base}`], { cwd: worktree, timeoutMs: 30_000 });
 const sha = merged.stdout.trim();
 if (merged.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return null;
 const tree = await safeGit(["ls-tree", "-r", "--name-only", sha], { cwd: worktree, timeoutMs: 30_000 });
 const diff = await safeGit(["diff", "--name-only", sha, "HEAD"], { cwd: worktree, timeoutMs: 30_000 });
 if (tree.code !== 0 || diff.code !== 0) return null;
 const atBase = fileNames(tree.stdout);
 const touched = fileNames(diff.stdout);
 const changed = failed.filter((n) => !atBase.has(n) || touched.has(n));
 const comparable = failed.filter((n) => !changed.includes(n));
 if (comparable.length === 0) return { sha, red: [], differs: [], passed: [], changed };
 const command = probeRetryCommandFor(template, ctx.node.ref.id, comparable);
 const scratch = mkdtempSync(join(tmpdir(), "ranger-probe-base-"));
 const dir = join(scratch, "worktree");
 try {
  const add = await safeGit(["worktree", "add", "--detach", dir, sha], { cwd: worktree, timeoutMs: 120_000 });
  if (add.code !== 0) return null;
  if (map.commands.install !== undefined) {
   const install = await runShell(map.commands.install, dir, ctx, INSTALL_TIMEOUT_MS);
   if (install.code !== 0) return null;
  }
  await awaitQuietHost(ctx, "the merge-base probe run");
  const run = await runShell(command, dir, ctx, map.commands.probeTimeoutMin * 60_000);
  if (run.code === 0) return { sha, red: [], differs: [], passed: comparable, changed };
  const named = run.code > 0 ? parseFailedProbes(run.stdout) : [];
  if (named.length === 0) return null;
  const headChecks = parseFailedChecks(headStdout);
  const baseChecks = parseFailedChecks(run.stdout);
  // Both runs must be completed assertion failures: a crash, kill or timeout
  // after the inherited check is a failure of its own that names no check.
  const sameChecks = (probe: string): boolean => {
   const here = headChecks.get(probe);
   const there = baseChecks.get(probe);
   if (here === undefined || there === undefined) return false;
   if (here.kind !== "assert" || there.kind !== "assert") return false;
   return here.checks.size > 0 && [...here.checks].every((check) => there.checks.has(check));
  };
  const redThere = comparable.filter((n) => named.includes(n));
  return {
   sha,
   red: redThere.filter(sameChecks),
   differs: redThere.filter((n) => !sameChecks(n)),
   passed: comparable.filter((n) => !named.includes(n)),
   changed,
  };
 } finally {
  await safeGit(["worktree", "remove", "--force", dir], { cwd: worktree, timeoutMs: 60_000 });
  rmSync(scratch, { recursive: true, force: true });
  await safeGit(["worktree", "prune"], { cwd: worktree, timeoutMs: 30_000 });
 }
}

/**
 * Tell the map's channel once per map, merge base and probe set that the base
 * is red: every later branch off it would otherwise fail the same probes. The
 * run was at the merge base, not the base's tip, so the notice says so. Best
 * effort; the probe record on the PR is the durable trace.
 */
async function announceBaseRed(ctx: ImplementContext, sha: string, red: string[]): Promise<void> {
 const key = `base-red.${mapKey(ctx.map)}.${sha}.${[...red].sort().join(",")}`;
 if (ctx.journal.getHealth(key) !== null) return;
 const text = [
  `:ranger: **${ctx.map.base} was red** at \`${sha.slice(0, 8)}\` on ${red.join(", ")}`,
  `map: ${mapKey(ctx.map)}`,
  `Node #${ctx.node.ref.id} failed these probes twice, and they fail at its merge base too. Branches off this commit do not gate on them. Unless a later ${ctx.map.base} commit already fixed them, ${ctx.map.base} needs a fix.`,
 ].join("\n");
 try {
  await (ctx.announce ?? ((t: string) => DiscordAnnouncer.fromMap(ctx.map).post(t, "base-red notice")))(text);
  ctx.journal.setHealth(key, new Date().toISOString());
 } catch {
  /* best effort: the next node off this base tries again */
 }
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
  `**Probes — ${p.passed ? "passed" : "failed"}** at \`${p.sha.slice(0, 8)}\` (selection ${p.mode}, ${p.selected} probe(s); ${attempts} run(s))${baseRedNote(p)}`,
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
  const built = await workerPass(ctx, testCommand, { kind: "build" });
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
 const opening = await github.listComments(repo, open.number, token);
 let reviews = recordedReviews(opening, botIdentity);
 // A base merge pass moves the head without a finding to answer: each one
 // that landed in the PR's head grants the round that reviews the merged
 // branch. A marker whose merge was never pushed (a crash between the two)
 // grants nothing and uses up none of the node's merge passes.
 let baseMerges = await landedBaseMerges(
  worktree,
  recordedBaseMerges(opening, botIdentity),
  (await github.getPr(repo, open.number, token)).headSha,
 );
 const capNow = () => config.workers.reviewRounds + baseMerges;
 for (;;) {
  const cap = capNow();
  const live = await github.getPr(repo, open.number, token);
  let current = reviews.find((r) => r.sha === live.headSha);
  if (current === undefined) {
   if (reviews.length >= cap) {
    throw new ParkSignal(reviewCapHeadMovedOutcome({ rounds: reviews.length, pr: open.number }));
   }
   const round = reviews.length + 1;
   fence("review");
   const { substrate: reviewSubstrate, chosenOn } = await selectReviewSubstrate(ctx, live.headSha);
   // The sage round is a substrate session (node #56): its row opens under
   // the generation fence once selection has settled (selection awaits, and
   // the generation can move meanwhile), and ends with the cap confirmation,
   // so a capped review is recorded as capped.
   const reviewed = await recordSession(
    journal,
    { substrate: reviewSubstrate, kind: "review", repo, nodeId, generation: ctx.generation },
    async (openSession): Promise<{ verdict: ReviewVerdict } | { error: ReviewError; cap: CapSignal | null }> => {
     openSession();
     try {
      return {
       verdict: await (ctx.reviewer ?? sageReview)(repo, open.number, ctx.readOnlyToken, {
        substrate: reviewSubstrate,
       }),
      };
     } catch (error) {
      if (!(error instanceof ReviewError)) throw error;
      return { error, cap: await confirmCap(reviewSubstrate, journal, { readers: ctx.substrateReaders }) };
     }
    },
    (r) => ("verdict" in r ? "ok" : failedSessionOutcome(r.error.message, r.cap)),
   );
   if (!("verdict" in reviewed)) {
    // A review that failed on its substrate's limit resumes elsewhere; any
    // other review failure is an ordinary one.
    if (reviewed.cap === null) throw reviewed.error;
    return {
     status: "failed",
     detail: `sage review round ${round} on ${reviewSubstrate} hit its rate limit: ${reviewed.error.message.slice(0, 300)}`,
     workerExit,
     prNumber: open.number,
     substrateCapped: reviewed.cap,
    };
   }
   const verdict = reviewed.verdict;
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
  if (gatingFindings(current) === 0) {
   // Sage-clean. Before the probes certify this head, it must merge: GitHub
   // runs no CI on a conflicting PR, so a conflict found only at the merge
   // desk waits forever (seelite #692).
   if (!(await conflictsWithBase(ctx, github, open.number))) break;
   if (baseMerges >= MAX_BASE_MERGES) {
    throw new ParkSignal(baseConflictOutcome({ pr: open.number, base, passes: baseMerges }));
   }
   const merged = await baseMergePass(ctx, testCommand, live.headSha);
   workerExit = merged.workerExit;
   if (merged.failure !== undefined) return merged.failure;
   // The marker first: a merged head pushed without one would read as an
   // unreviewed head at the cap. A marker whose push never happens counts
   // for nothing (landedBaseMerges), so a crash between them costs nothing.
   fence("record the base merge");
   await github.postComment(repo, open.number, baseMergeMarker(merged.sha, base), token);
   await publishPass(
    ctx,
    github,
    open.number,
    merged,
    "push base merge",
    `base merge pass ${baseMerges + 1} @ ${merged.sha.slice(0, 8)}: origin/${base} merged in after a conflict`,
   );
   baseMerges += 1;
   continue;
  }
  if (current.round >= cap) {
   throw new ParkSignal(
    reviewCapOutcome({ blockers: current.blockers, majors: current.majors, round: current.round, pr: open.number }),
   );
  }
  // One fix pass per review that found blockers or majors. On a resume the review is
  // re-read from its PR comment, so a crash between review and fix loses nothing.
  const fixed = await workerPass(ctx, testCommand, { kind: "fix", round: current.round, body: current.body });
  workerExit = fixed.workerExit;
  if (fixed.failure !== undefined) return fixed.failure;
  await publishPass(ctx, github, open.number, fixed, "push fix", `fix pass ${current.round} @ ${fixed.sha.slice(0, 8)}`);
 }

 // ---- probe tier, once, on the final head ----
 let probe: RecordedProbe | undefined;
 if (map.commands.probe !== undefined) {
  probe = await probeFinalHead(ctx, github, open.number);
 }

 // The run-node awake hold covers this informational capture step too.
 const final = reviews[reviews.length - 1];
 let labels: string[] = [];
 try { if (map.commands.views) labels = await github.issueLabels(repo, Number(nodeId), token); }
 catch (error) {
  journal.recordEvent("reviewed", { nodeId, repo, detail: `views label lookup failed (informational): ${String(error).slice(-500)}` });
 }
 if (labels.includes(NEEDS_EYE_LABEL)) {
  let record: ViewsRecord | undefined;
  try {
   record = await captureViews({
    map, nodeId, sha: final.sha, labels,
    probePassed: probe?.passed === true && probe.sha === final.sha,
    journalPath: journal.path, worktree,
    env: workerEnv(config, repo), dependencies: ctx.viewsDependencies,
   });
  } catch (error) {
   record = { sha: final.sha, status: "failed", reason: redactViewsReason(String(error), workerEnv(config, repo)) };
   try { saveViewsRecord(viewsDirectory(journal.path, repo, nodeId, final.sha), record); } catch { /* best effort */ }
  }
  if (record !== undefined) {
   fence("post the views record");
   try {
    const comments = await github.listComments(repo, open.number, token);
    const body = viewsComment(record, viewsDirectory(journal.path, repo, nodeId, final.sha));
    if (!comments.some(c => c.author === botIdentity && c.body === body)) {
     await github.postComment(repo, open.number, body, token);
    }
   } catch (error) {
    journal.recordEvent("reviewed", { nodeId, repo, detail: `views comment failed (informational): ${String(error).slice(-500)}` });
   }
  }
 }

 // ---- ready → awaiting merge ----
 fence("mark ready");
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

/** Base merge passes one node gets before a still-conflicting branch parks. */
const MAX_BASE_MERGES = 2;

interface BaseMergeInput {
 base: string;
 /** The files a trial merge reported as conflicting (the worker's starting point). */
 files: string[];
}

/** The base is informational: any ref name the config accepts must still parse. */
const BASE_MERGE_MARKER = /<!-- ranger:base-merge sha=([0-9a-f]{7,64})(?: base=[^\s>]*)? -->/;

export function baseMergeMarker(sha: string, base: string): string {
 return `<!-- ranger:base-merge sha=${sha} base=${base} -->\n**Base merge** — \`origin/${base}\` conflicted with this branch, so a worker merged it in at \`${sha.slice(0, 8)}\`. The next sage round reviews the merged branch.`;
}

/** Base merge passes recorded on the PR by the MACHINE ACCOUNT (anyone else's markers are ignored). */
export function recordedBaseMerges(comments: IssueComment[], botIdentity: string): { sha: string }[] {
 const out: { sha: string }[] = [];
 for (const c of comments) {
  if (c.author !== botIdentity) continue;
  const m = c.body.match(BASE_MERGE_MARKER);
  if (m !== null) out.push({ sha: m[1] });
 }
 return out;
}

/** How many recorded base merges landed: their merge commit is in the PR's head. */
async function landedBaseMerges(worktree: string, merges: { sha: string }[], head: string): Promise<number> {
 let landed = 0;
 for (const { sha } of new Map(merges.map((m) => [m.sha, m])).values()) {
  const inside = await safeGit(["merge-base", "--is-ancestor", sha, head], { cwd: worktree, timeoutMs: 30_000 });
  if (inside.code === 0) landed += 1;
 }
 return landed;
}

/** Push a pass's commits through the vetted push, record them, and wait for GitHub to show the head. */
async function publishPass(
 ctx: ImplementContext,
 github: GitHubPort,
 prNumber: number,
 pass: PassResult,
 action: string,
 detail: string,
): Promise<void> {
 ctx.journal.assertGeneration(ctx.node.ref.id, ctx.map.repo, ctx.generation, action);
 await vettedPush({
  worktree: ctx.worktree,
  canonical: ctx.canonical,
  branch: ctx.branch,
  token: ctx.token,
  configSnapshot: pass.snapshot,
 });
 ctx.journal.recordEvent("pushed", { nodeId: ctx.node.ref.id, repo: ctx.map.repo, detail });
 recordHead(ctx, pass.sha);
 await awaitHead(github, ctx.map.repo, prNumber, pass.sha, ctx.token, ctx.headPollMs);
}

/**
 * Whether GitHub says the PR conflicts with its base. GitHub computes
 * mergeability lazily after a push, so an unknown answer is polled for a
 * while; one that stays unknown reads as no conflict, and the merge gate
 * asks again before any merge.
 */
async function conflictsWithBase(ctx: ImplementContext, github: GitHubPort, prNumber: number): Promise<boolean> {
 const { pollMs, attempts } = ctx.mergeablePoll ?? { pollMs: 5_000, attempts: 12 };
 for (let i = 0; i < attempts; i++) {
  const pr = await github.getPr(ctx.map.repo, prNumber, ctx.token);
  if (pr.mergeable !== null && pr.mergeableState !== "unknown") {
   return pr.mergeable === false || pr.mergeableState === "dirty";
  }
  if (i < attempts - 1) await new Promise((r) => setTimeout(r, pollMs));
 }
 return false;
}

/**
 * The files `git merge-tree` reports as conflicting between the branch and
 * origin/<base>: a hint for the worker's prompt, empty when git cannot say.
 */
async function conflictingFiles(worktree: string, base: string): Promise<string[]> {
 const trial = await safeGit(["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", `origin/${base}`], {
  cwd: worktree,
  timeoutMs: 60_000,
 });
 if (trial.code !== 1) return [];
 return trial.stdout.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).slice(0, 20);
}

/**
 * One worker pass that merges the moved base into the branch. The supervisor
 * fetches the base first (the worker holds no credential); the worker merges
 * and resolves; the supervisor's own checks then require a clean tree,
 * passing tests, and origin/<base> actually inside the branch.
 */
async function baseMergePass(ctx: ImplementContext, testCommand: string, pushedHead: string): Promise<PassResult> {
 const base = ctx.map.base;
 // Start from what GitHub has: an earlier run may have merged locally and
 // crashed before its push, and that unpushed state is neither vetted nor
 // reviewed. The pass redoes the merge on the pushed head — only while this
 // supervisor still owns the node: a superseded one must not erase a newer
 // run's work.
 ctx.journal.assertGeneration(ctx.node.ref.id, ctx.map.repo, ctx.generation, "reset the worktree for a base merge");
 for (const args of [["reset", "--hard", pushedHead], ["clean", "-fd"]]) {
  const r = await safeGit(args, { cwd: ctx.worktree, timeoutMs: 60_000 });
  if (r.code !== 0) throw new GitSafetyError(`cannot reset ${ctx.worktree} to ${pushedHead.slice(0, 8)} (git ${args[0]}): ${r.stderr.trim()}`);
 }
 await fastForwardCanonical(ctx.canonical, base, ctx.token);
 const files = await conflictingFiles(ctx.worktree, base);
 ctx.journal.recordEvent("reviewed", {
  nodeId: ctx.node.ref.id,
  repo: ctx.map.repo,
  detail: `PR conflicts with origin/${base}${files.length > 0 ? ` in ${files.join(", ")}` : ""} — a worker merges it in`,
 });
 const pass = await workerPass(ctx, testCommand, { kind: "base-merge", base, files });
 if (pass.failure !== undefined) return pass;
 const inside = await safeGit(["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"], {
  cwd: ctx.worktree,
  timeoutMs: 30_000,
 });
 if (inside.code !== 0) {
  throw new ParkSignal(
   `base merge pass committed, but origin/${base} is still not in ${ctx.branch} — the conflict stands; nothing was pushed`,
  );
 }
 return pass;
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

/** What a worker session is for: the build, a fix pass answering a sage round, or a base merge. */
type WorkerPassSpec =
 | { kind: "build" }
 | { kind: "fix"; round: number; body: string }
 | ({ kind: "base-merge" } & BaseMergeInput);

/** The pass's name in logs, events and outcomes. */
function passLabel(spec: WorkerPassSpec): string {
 switch (spec.kind) {
  case "build":
   return "build pass";
  case "fix":
   return `fix pass ${spec.round}`;
  case "base-merge":
   return "base merge pass";
 }
}

/** Why a pass that exited 0 without a new commit failed. */
function nothingCommitted(spec: WorkerPassSpec): string {
 switch (spec.kind) {
  case "build":
   return "worker exited 0 but committed nothing — nothing to push";
  case "fix":
   return `fix pass ${spec.round} committed nothing — the blockers stand`;
  case "base-merge":
   return `base merge pass committed nothing — the conflict with origin/${spec.base} stands`;
 }
}

/**
 * One worker session (build, fix or base merge), recorded as a substrate
 * session (node #56) that ends once the supervisor's own checks have judged
 * it. A RANGER_WORKER_CMD session runs on a substrate ranger cannot know, so
 * it is not recorded.
 */
async function workerPass(ctx: ImplementContext, testCommand: string, spec: WorkerPassSpec): Promise<PassResult> {
 const nodeId = ctx.node.ref.id;
 if (ctx.substrate === undefined) {
  return checkedWorkerPass(ctx, testCommand, spec, () =>
   ctx.journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, "spawn the worker"),
  );
 }
 return recordSession(
  ctx.journal,
  {
   substrate: ctx.substrate,
   kind: spec.kind === "build" ? "worker" : "fix-pass",
   repo: ctx.map.repo,
   nodeId,
   generation: ctx.generation,
   model: ctx.model ?? null,
  },
  (open) => checkedWorkerPass(ctx, testCommand, spec, open),
  (pass) =>
   pass.failure === undefined ? "ok" : failedSessionOutcome(pass.failure.detail, pass.failure.substrateCapped),
 );
}

/**
 * The worker session itself, then the supervisor's own test + keyword checks.
 * `fenceSpawn` runs right before the spawn: the generation fence, which for
 * a recorded substrate also opens the session row (node #56), so a pass
 * superseded during the awaits before it neither spawns nor records a session.
 */
async function checkedWorkerPass(
 ctx: ImplementContext,
 testCommand: string,
 spec: WorkerPassSpec,
 fenceSpawn: () => void,
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
  ...(spec.kind === "fix" ? { review: { round: spec.round, body: spec.body } } : {}),
  ...(spec.kind === "base-merge" ? { baseMerge: { base: spec.base, files: spec.files } } : {}),
  probeTier: map.commands.probe !== undefined,
 });
 fenceSpawn();
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

 const pass = passLabel(spec);
 const log = saveWorkerLog(journal.path, map.repo, nodeId, ctx.generation, pass, result);
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
 const stopped = hookStopReason(result.stdout, lines);
 if (stopped !== null) throw new ParkSignal(policyBlockedOutcome({ pass, reason: stopped, log }));
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
 // A base merge brings in the base's manifests and lockfile: the tests must
 // run on its dependencies, not the ones installed for the old base. It runs
 // before the commit and clean-tree checks, so an install that rewrites a
 // tracked file (a lockfile, generated source) fails the pass rather than
 // letting the tests certify content that never gets pushed.
 if (spec.kind === "base-merge" && map.commands.install !== undefined) {
  const install = await runShell(map.commands.install, worktree, ctx, INSTALL_TIMEOUT_MS);
  if (install.code !== 0) {
   return fail(`install (${map.commands.install}) after the base merge exited ${install.code}: ${tail(install)}`);
  }
 }
 const sha = await headSha(worktree);
 if (sha === before || (await commitsAhead(worktree, map.base)) === 0) {
  return fail(nothingCommitted(spec));
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
  : [`- Probes: passed at \`${probe.sha.slice(0, 8)}\` (selection ${probe.mode}, ${probe.selected} probe(s)). Only the selected probes ran, not the full suite.${baseRedNote(probe)}`];
}

/** The probes a passing record excuses because the merge base fails them too. */
export function baseRedNote(probe: Pick<RecordedProbe, "baseRed"> | undefined): string {
 const red = probe?.baseRed ?? [];
 return red.length === 0 ? "" : ` Not gating: ${red.join(", ")} failed here and fail at the merge base too.`;
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
