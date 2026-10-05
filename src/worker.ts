import { mapKey } from "./maps.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { expandHome } from "./config.ts";
import { DiscordAnnouncer } from "./announce.ts";
import { runCmd, type RunOptions } from "./exec.ts";
import {
 fastForwardCanonical,
 assertGitUntouched,
 safeGit,
 type GitState,
 GitSafetyError,
 vettedPush,
} from "./git-ops.ts";
import { GRAPH_CALL_TIMEOUT_MS, graphNode, type NodeResult } from "./graph.ts";
import {
 checkKnownGood,
 isRefusal,
 recordIfUnchanged,
 recordKnownGood,
 tamperOutcome,
 trustFreshClone,
} from "./git-trust.ts";
import { graphClose, graphDecisions, type CloseResult } from "./graph-write.ts";
import {
 implementBranchFor,
 runImplement,
 type ImplementContext,
 type ImplementOutcome,
 type Reviewer,
} from "./implement.ts";
import { FencedError, type Journal } from "./journal.ts";
import { assembleResearchPrompt } from "./prompt.ts";
import { IMPLEMENT_KINDS } from "./route.ts";
import {
 hookStopReason,
 markSubstrateCapped,
 describeWorkerModel,
 selectSubstrate,
 workerCommandFor,
 workerModelFor,
 type CapSignal,
 type QuotaReading,
 type SubstrateName,
 type SubstrateReaders,
} from "./substrate.ts";
import { selectForBuild } from "./substrate-policy.ts";
import { resolveReadOnlyToken } from "./token-gate.ts";
import { workerEnv } from "./worker-env.ts";
import { sessionJournalPath } from "./journal-guard.ts";
import { saveWorkerLog } from "./worker-log.ts";
import { isTransientGitHubError } from "./transient.ts";
import * as githubApi from "./github.ts";
import type { GitHubPort } from "./github.ts";
import { ParkSignal } from "./signals.ts";
import { policyBlockedOutcome } from "./outcomes.ts";
import { assertResearchFindingsOnly, researchCi, type ResearchCiTiming } from "./research-ci.ts";

export { gitAuthEnv } from "./git-ops.ts";

/**
 * The detached run-node supervisor (design §4, build-path steps 3–4).
 *
 * One node = one worker session. The supervisor takes the node as a new
 * occupant (a fresh generation, #23 F1), bootstraps a worktree off the
 * canonical checkout, and runs the kind's SOP: research (findings branch →
 * gated close) or the implement lane (implement.ts: tests → PR → sage →
 * merge escalation → gated close). The worker session never holds a
 * credential; every outward action is the supervisor's, and fenced.
 */

export interface RunNodeOutcome {
 nodeId: string;
 repo: string;
 status: "success" | "failed" | "refused" | "skipped" | "parked" | "awaiting-merge";
 detail: string;
 workerExit: number | null;
 close?: CloseResult;
 prNumber?: number;
}

export interface RunNodeContext {
 config: RangerConfig;
 map: RangerMapConfig;
 /** Machine-account write token (resolved + principal-checked by the caller). */
 token: string;
 botIdentity: string;
 journal: Journal;
 /**
  * Worker command + leading args; the prompt is appended as the final arg.
  * Defaults to the selected substrate's command (`workerCommandFor`);
  * `RANGER_WORKER_CMD` overrides the implement lane's, unlabelled
  * (`envWorkerOverride`). Tests point this
  * at a fake worker script.
  */
 workerCommand?: string[];
 /** Wall-clock budget in minutes (overrides config.workers.wallClockMin). */
 wallClockMin?: number;
 /** For tests: drive the supervisor with an injected worker prompt instead of spawning. */
 worker?: (
  prompt: string,
  opts: RunOptions,
 ) => Promise<{ code: number; stdout: string; stderr: string }>;
 /** For tests: the supervisor's forge and implement lane's reviewer. */
 github?: GitHubPort;
 /** Injectable CI timing for tests; production uses the default settling window. */
 researchCiTiming?: ResearchCiTiming;
 reviewer?: Reviewer;
 /** For tests: the read-only token (defaults to the map's `auth.readOnlyTokens` env). */
 readOnlyToken?: string;
 /** For tests: the first session's substrate (later sessions after a cap are selected). */
 substrate?: SubstrateName;
 /** For tests: the quota readers (with an injected worker, reviewer or command and none injected, reads fail closed). */
 substrateReaders?: SubstrateReaders;
 viewsDependencies?: ImplementContext["viewsDependencies"];
 /** For tests: the implement lane's repo-command runner (install/test/probe). */
 shellRun?: ImplementContext["shellRun"];
 /** Probe-tier host load, quiet-host wait and channel post (tests inject them). */
 hostLoad?: ImplementContext["hostLoad"];
 quietHost?: ImplementContext["quietHost"];
 announce?: ImplementContext["announce"];
 mergeablePoll?: ImplementContext["mergeablePoll"];
}

/** The canonical checkout dir for a repo (design §4: probes run there). */
export function canonicalDir(
 config: RangerConfig,
 map: RangerMapConfig,
): string {
 return map.canonical === undefined
  ? join(expandHome(config.state.canonicalRoot), map.repo)
  : expandHome(map.canonical);
}

/** The worktree dir for a node, under the canonical checkout. */
export function worktreeDir(canonical: string, nodeId: string): string {
 return join(canonical, ".worktrees", `node-${nodeId}`);
}

/** `node/<N>-<slug>` — the worktree branch (design §4). */
export function worktreeBranch(nodeId: string, slug: string): string {
 return `node/${nodeId}-${slug}`;
}

/**
 * The research branch the worker must create + push. Prefer the declared
 * `git-ref-exists research/…` probe's ref — the close gate probes that exact
 * ref — else fall back to `research/<slug>`.
 */
export function researchBranchFor(node: {
 title: string;
 probes?: { type: string; ref?: string }[];
}): string {
 const refProbe = (node.probes ?? []).find(
  (p) =>
   p.type === "git-ref-exists" &&
   typeof p.ref === "string" &&
   p.ref.startsWith("research/"),
 );
 if (refProbe?.ref !== undefined) return refProbe.ref;
 return `research/${slugify(node.title)}`;
}

export function slugify(title: string): string {
 const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 48);
 return slug.length === 0 ? "node" : slug;
}

/** Ensure the canonical checkout exists (clone on first use; true when it cloned). Read-only ops only. */
export async function bootstrapCanonical(
 dir: string,
 repo: string,
 token: string,
): Promise<boolean> {
 if (existsSync(dir) && existsSync(join(dir, ".git"))) {
  return false;
 }
 const parent = resolve(dir, "..");
 const result = await safeGit(
  ["clone", `https://github.com/${repo}.git`, dir],
  { cwd: parent, token, timeoutMs: 120_000 },
 );
 if (result.code !== 0) {
  throw new Error(
   `cannot bootstrap canonical checkout ${dir} (git clone, exit ${result.code}): ${result.stderr.trim()}`,
  );
 }
 return true;
}

/**
 * Add a worktree off origin/<base> (adopts an existing one on conflict).
 * `branch` overrides the `node/<N>-<slug>` default (a declared
 * `git-merged-into` probe names the branch the close checks).
 */
export async function bootstrapWorktree(
 canonical: string,
 nodeId: string,
 slug: string,
 token: string,
 branchOverride?: string,
 base = "main",
): Promise<string> {
 const dir = worktreeDir(canonical, nodeId);
 if (existsSync(dir)) {
  return dir; // adopt — a crashed worker's worktree is reused (design §7).
 }
 const branch = branchOverride ?? worktreeBranch(nodeId, slug);
 // The branch can already exist without a worktree — orphaned after a pruned
 // worktree or a prior run — and `-b` would fail on it. Add the worktree from
 // the existing branch instead (adopt semantics). Found live on node #19.
 const existing = await safeGit(
  ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
  { cwd: canonical, timeoutMs: 10_000 },
 );
 // No tracking lines on a new branch: they land in the shared config, which
 // the known-good check compares across runs (node #81). The tamper state
 // leaves out only a node branch's plain remote + merge pair (node #63), and
 // `branch.autoSetupRebase=always` adds a `rebase` line to it, a probe-named
 // branch none at all. `--no-track` also overrides `branch.autoSetupMerge`.
 // Ranger's git calls name their refs and never use the upstream.
 const args =
  existing.code === 0
   ? ["worktree", "add", dir, branch]
   : ["worktree", "add", "--no-track", dir, "-b", branch, `origin/${base}`];
 // worktree add fires post-checkout; safeGit keeps a planted hook from
 // running with the supervisor's credentials.
 const result = await safeGit(args, {
  cwd: canonical,
  token,
  timeoutMs: 60_000,
 });
 if (result.code !== 0) {
  throw new Error(
   `cannot add worktree for node ${nodeId} (exit ${result.code}): ${result.stderr.trim()}`,
  );
 }
 return dir;
}

function defaultWorkerCommand(): string[] {
 const envCmd = process.env.RANGER_WORKER_CMD;
 if (envCmd !== undefined && envCmd.length > 0) return [envCmd];
 return ["claude", "-p"];
}

/**
 * The operator's `RANGER_WORKER_CMD` (no in-process injection): a fixed
 * command whose substrate ranger cannot know. Build selection is skipped and
 * the session runs unlabelled: its heads read back as Pi-written (node #45
 * brief), its output is read as plain text and no cap is inferred from it.
 * Review selection still reads the real quota.
 */
function envWorkerOverride(ctx: RunNodeContext): string[] | undefined {
 if (ctx.workerCommand !== undefined || ctx.worker !== undefined) return undefined;
 return process.env.RANGER_WORKER_CMD ? defaultWorkerCommand() : undefined;
}

/** Resolve the worker command: explicit override > the substrate's command. */
function resolveWorkerCommand(
 ctx: RunNodeContext,
 substrate: SubstrateName,
 canonical: string,
): string[] {
 return (
  ctx.workerCommand ??
  workerCommandFor(substrate, ctx.config, { writableGitDir: join(canonical, ".git") })
 );
}

/** An in-process worker, reviewer or command: a test run, never the real CLIs' quota. */
function injected(ctx: RunNodeContext): boolean {
 return ctx.workerCommand !== undefined || ctx.worker !== undefined || ctx.reviewer !== undefined;
}

const failingRead = (): Promise<QuotaReading> =>
 Promise.reject(new Error("quota reads are off under an injected worker, reviewer or command"));

/**
 * The quota readers: injected ones, else the real CLIs — except under an
 * injected worker, reviewer or command (tests), where reads fail closed
 * rather than spawn a real `claude` or `codex`.
 */
function resolveReaders(ctx: RunNodeContext): SubstrateReaders | undefined {
 if (ctx.substrateReaders !== undefined) return ctx.substrateReaders;
 return injected(ctx) ? { claude: failingRead, codex: failingRead } : undefined;
}

/**
 * Select the substrate for a worker session (node #45): refresh both strong
 * readings, then the eligible one with the most headroom, else Pi.
 * Substrates capped earlier in this run are left out.
 */
async function selectBuildSubstrate(
 ctx: RunNodeContext,
 excluded: ReadonlySet<SubstrateName>,
): Promise<{ substrate: SubstrateName; chosenOn: string }> {
 if (ctx.substrate !== undefined && excluded.size === 0) {
  return { substrate: ctx.substrate, chosenOn: "fixed by the caller" };
 }
 return selectSubstrate(ctx.journal, {
  config: ctx.config.substrates,
  excluded,
  readers: resolveReaders(ctx),
  pick: selectForBuild,
 });
}

/**
 * Back to the last pushed state before another substrate resumes the node
 * (node #45): the pushed branch when there is one, else the base. A capped
 * session's unpushed commits and files are dropped.
 */
async function resetToPushed(worktree: string, branch: string, base: string): Promise<void> {
 const pushed = await safeGit(
  ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
  { cwd: worktree, timeoutMs: 10_000 },
 );
 const target = pushed.code === 0 ? pushed.stdout.trim() : `origin/${base}`;
 for (const args of [["reset", "--hard", target], ["clean", "-fd"]]) {
  const r = await safeGit(args, { cwd: worktree, timeoutMs: 60_000 });
  if (r.code !== 0) {
   throw new GitSafetyError(`cannot reset ${worktree} to ${target} (git ${args[0]}): ${r.stderr.trim()}`);
  }
 }
}

/**
 * A session or review hit its substrate's limit (node #45): mark the substrate
 * capped, journal it, and put the worktree back to the last pushed state so
 * the next eligible substrate resumes from there. Not counted toward attempts
 * or the dead-man switch.
 */
async function handleSubstrateCap(
 ctx: RunNodeContext,
 run: { nodeId: string; generation: number; worktree: string; branch: string },
 cap: CapSignal,
 outcome: ImplementOutcome,
 capped: Set<SubstrateName>,
): Promise<void> {
 const { journal, map } = ctx;
 capped.add(cap.substrate);
 markSubstrateCapped(journal, cap.substrate, cap.resetsAt, new Date());
 const resets = cap.resetsAt === null ? "unknown" : new Date(cap.resetsAt * 1000).toISOString();
 journal.recordEvent("substrate-capped", {
  nodeId: run.nodeId,
  repo: map.repo,
  detail: `${cap.substrate} hit its limit (resets ${resets}); resuming on the next eligible substrate: ${outcome.detail}`.slice(0, 400),
 });
 journal.assertGeneration(run.nodeId, ctx.map.repo, run.generation, "resume on another substrate");
 await resetToPushed(run.worktree, run.branch, map.base);
}

/** Count a failure toward the dead-man switch, pausing claiming at the threshold. */
function countFailure(config: RangerConfig, journal: Journal, repo: string): void {
 const count = journal.bumpDeadman();
 if (count >= config.workers.deadmanThreshold) {
  journal.setPaused(true);
  journal.recordEvent("deadman-paused", {
   repo,
   detail: `dead-man tripped at ${count} consecutive failures`,
  });
 }
}

/**
 * A run that failed. A transient GitHub error (`transient.ts`) is not the
 * node's fault: it is not counted toward the dead-man switch, and the row is
 * left running under this supervisor's PID, so when the process exits the
 * sweep finds a crashed worker and respawns it (bounded by maxAttempts) —
 * the implement lane re-derives its phase from GitHub, so finished work is
 * kept. Any other failure counts and ends the row as failed.
 */
function failNode(
 config: RangerConfig,
 journal: Journal,
 nodeId: string,
 repo: string,
 detail: string,
): void {
 if (isTransientGitHubError(detail)) {
  journal.recordEvent("transient", {
   nodeId,
   repo,
   detail: `GitHub-side transient error, left for the sweep to respawn (not counted): ${detail.slice(0, 300)}`,
  });
  return;
 }
 countFailure(config, journal, repo);
 finish(journal, nodeId, repo, "failed", detail);
}

/** Mark the row terminal: the supervisor PID is released only here (F1). */
function finish(
 journal: Journal,
 nodeId: string,
 repo: string,
 status: "success" | "failed" | "parked",
 outcome: string,
): void {
 journal.updateWorker(nodeId, repo, {
  status,
  pid: null,
  workerPgid: null,
  finishedAt: new Date().toISOString(),
  outcome: outcome.slice(0, 400),
 });
}

/**
 * Run one node to completion (or to its awaiting-merge hand-off). Returns the
 * outcome and records it in the journal.
 */
export async function runNode(
 nodeId: string,
 ctx: RunNodeContext,
): Promise<RunNodeOutcome> {
 const { config, token, journal } = ctx;
 const map = ctx.map;
 const repo = map.repo;
 const row = journal.getWorker(nodeId, repo);
 journal.assertWorkerRoot(nodeId, repo, map.root);
 const base: RunNodeOutcome = {
  nodeId,
  repo,
  status: "skipped",
  detail: "",
  workerExit: null,
 };

 // Take the node as a new occupant. A run-node with no claim row (an
 // operator's manual run) gets a running row first.
 if (row === null) {
  journal.upsertWorker({ nodeId, repo, root: map.root, status: "running", attempts: 0 });
 }
 const generation = journal.beginGeneration(nodeId, repo);
 // The supervisor's PID stays on the row until a terminal state (F1): a
 // supervisor crash anywhere in the SOP tail is then visible to sweep.
 journal.updateWorker(nodeId, repo, {
  pid: process.pid,
  status: "running",
  startedAt: new Date().toISOString(),
 });

 try {
  const node = await graphNode(
   repo,
   nodeId,
   { token, source: "write-token" },
   {
    // Every graph CLI call is timeout-bound — a hung soma must not leave a
    // detached worker alive holding its claim forever (round-36: the worker's
    // read/close/decisions were the last unbounded surface).
    timeoutMs: GRAPH_CALL_TIMEOUT_MS,
   },
  );
  const rootNode = await graphNode(
   repo,
   String(map.root),
   { token, source: "write-token" },
   {
    timeoutMs: GRAPH_CALL_TIMEOUT_MS,
   },
  );

  if (node.node.kind === "research") {
   return await runResearch(nodeId, ctx, node, rootNode, generation);
  }
  if (IMPLEMENT_KINDS.has(node.node.kind)) {
   return await runImplementNode(nodeId, ctx, node, rootNode, generation);
  }
  const detail = `node #${nodeId} is kind '${node.node.kind}' — ranger walks research and task/build nodes only (design §3).`;
  journal.recordEvent("refused", { nodeId, repo, detail });
  finish(journal, nodeId, repo, "parked", detail);
  return { ...base, status: "refused", detail };
 } catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof FencedError) {
   // A newer occupant owns the row — leave it untouched.
   journal.recordEvent("fenced", { nodeId, repo, detail: detail.slice(0, 400) });
   return { ...base, status: "refused", detail };
  }
  journal.recordEvent("refused", {
   nodeId,
   repo,
   detail: detail.slice(0, 400),
  });
  if (error instanceof ParkSignal) {
   finish(journal, nodeId, repo, "parked", detail);
   return { ...base, status: "parked", detail };
  }
  failNode(config, journal, nodeId, repo, detail);
  return { ...base, status: "failed", detail };
 }
}

/** Ratification route for a task/build node (design §3 + the #23 ruling). */
function ratifyFor(
 node: NodeResult,
 map: RangerMapConfig,
 botIdentity: string,
): "auto" | "merge" | string {
 if (map.walk !== "full") {
  return `map ${map.repo} is walk: ${map.walk} — only walk: full maps get the implement lane (node #9)`;
 }
 if (node.node.autonomy === "auto") return "auto";
 if (node.node.autonomy === "propose") {
  if (node.author === botIdentity) {
   return `node #${node.ref.id} was filed by ${botIdentity} — ranger never walks work it minted (node #9)`;
  }
  return "merge";
 }
 return `node #${node.ref.id} is ${node.node.autonomy} — it waits for the principal (design §3)`;
}

/** What every implement session of a node shares; runSession adds the substrate. */
type SessionScope = Omit<ImplementContext, "workerRun" | "substrate" | "model" | "excludedSubstrates">;

/**
 * One worker session (node #45): select its substrate (leaving out those
 * capped in this run), record the worker-start event, run the implement lane.
 */
async function runSession(
 ctx: RunNodeContext,
 nodeId: string,
 session: SessionScope,
 capped: ReadonlySet<SubstrateName>,
): Promise<ImplementOutcome> {
 const { journal } = session;
 const envCmd = envWorkerOverride(ctx);
 const { substrate, chosenOn } =
  envCmd === undefined
   ? await selectBuildSubstrate(ctx, capped)
   : { substrate: undefined, chosenOn: "RANGER_WORKER_CMD override; its heads count as Pi-written" };
 const workerCmd = envCmd ?? resolveWorkerCommand(ctx, substrate as SubstrateName, session.canonical);
 // The pinned model (node #60), only when ranger built the command from its
 // config: an operator's or a test's command carries no model ranger knows.
 const model =
  envCmd === undefined && ctx.workerCommand === undefined && substrate !== undefined
   ? workerModelFor(substrate, ctx.config)
   : null;
 journal.updateWorker(nodeId, session.map.repo, { substrate: substrate ?? null });
 journal.recordEvent("worker-start", {
  nodeId,
  repo: session.map.repo,
  detail: `substrate ${substrate ?? "unknown"}${model === null ? "" : ` (${describeWorkerModel(model)})`} (${chosenOn}), command: ${workerCmd[0]}`.slice(0, 400),
 });
 return runImplement({
  ...session,
  workerRun:
   ctx.worker ??
   ((p: string, opts: RunOptions) => runCmd(workerCmd[0], [...workerCmd.slice(1), p], opts)),
  substrate,
  model: model?.model,
  excludedSubstrates: capped,
 });
}

async function runImplementNode(
 nodeId: string,
 ctx: RunNodeContext,
 node: NodeResult,
 rootNode: NodeResult,
 generation: number,
): Promise<RunNodeOutcome> {
 const { config, map, token, botIdentity, journal } = ctx;
 const repo = map.repo;
 const base: RunNodeOutcome = { nodeId, repo, status: "skipped", detail: "", workerExit: null };

 const ratify = ratifyFor(node, map, botIdentity);
 if (ratify !== "auto" && ratify !== "merge") {
  journal.recordEvent("refused", { nodeId, repo, detail: ratify });
  finish(journal, nodeId, repo, "parked", ratify);
  return { ...base, status: "refused", detail: ratify };
 }
 const readOnlyToken = ctx.readOnlyToken ?? resolveReadOnlyToken(config, repo).token;

 const canonical = canonicalDir(config, map);
 const slug = slugify(node.node.title);
 const branch = implementBranchFor(node.node, worktreeBranch(nodeId, slug));
 const start = await trustedStart(ctx, nodeId, node.node.title, canonical, async () => {
  await fastForwardCanonical(canonical, map.base, token);
  return bootstrapWorktree(canonical, nodeId, slug, token, branch, map.base);
 });
 if ("parked" in start) return start.parked;
 const { worktree } = start;
 journal.updateWorker(nodeId, repo, { worktree, lane: "implement" });

 // Substrate selection (node #45), re-run at every session start. A session
 // that hits its substrate's limit is not a failure: the substrate is marked
 // capped and the node resumes in this supervisor on the next eligible one,
 // re-deriving its phase from GitHub (F2). Build and review selection both
 // leave out the substrates capped in this run and Pi never caps, so each
 // strong substrate caps at most once and the loop ends on Pi at the latest.
 const session: SessionScope = {
  config: ctx.wallClockMin === undefined
   ? config
   : { ...config, workers: { ...config.workers, wallClockMin: ctx.wallClockMin } },
  map,
  token,
  readOnlyToken,
  botIdentity,
  journal,
  node,
  rootNode,
  canonical,
  worktree,
  branch,
  generation,
  ratify,
  // One temp journal per run-node session (node #66): the worker and the
  // repo commands share it, and it is never the live one.
  sessionJournal: sessionJournalPath(),
  shellRun: ctx.shellRun,
  github: ctx.github,
  reviewer: ctx.reviewer,
  viewsDependencies: ctx.viewsDependencies,
  hostLoad: ctx.hostLoad,
  quietHost: ctx.quietHost,
  announce: ctx.announce,
  mergeablePoll: ctx.mergeablePoll,
  substrateReaders: resolveReaders(ctx),
 };
 const capped = new Set<SubstrateName>();
 let outcome: ImplementOutcome;
 for (;;) {
  try {
   outcome = await runSession(ctx, nodeId, session, capped);
   const cap = outcome.substrateCapped;
   if (cap === undefined || capped.has(cap.substrate)) break;
   await handleSubstrateCap(ctx, { nodeId, generation, worktree, branch }, cap, outcome, capped);
  } catch (error) {
   if (error instanceof ParkSignal || error instanceof GitSafetyError) {
    return parkRun(ctx, nodeId, node.node.title, error.message);
   }
   throw error;
  }
 }

 switch (outcome.status) {
  case "success":
   journal.resetDeadman();
   finish(journal, nodeId, repo, "success", outcome.detail);
   break;
  case "awaiting-merge":
   journal.resetDeadman();
   // The row already says awaiting-merge; the supervisor exits, so its PID goes.
   journal.updateWorker(nodeId, repo, { pid: null });
   break;
  case "refused":
   journal.recordEvent("refused", { nodeId, repo, detail: outcome.detail.slice(0, 400) });
   finish(journal, nodeId, repo, "parked", outcome.detail);
   break;
  default:
   journal.recordEvent("refused", { nodeId, repo, detail: outcome.detail.slice(0, 400) });
   // Backstop: a capped failure never counts (node #45), even if it ends the
   // run; a transient GitHub error is left for the sweep (failNode).
   if (outcome.substrateCapped !== undefined) finish(journal, nodeId, repo, "failed", outcome.detail);
   else failNode(config, journal, nodeId, repo, outcome.detail);
 }
 return {
  ...base,
  status: outcome.status,
  detail: outcome.detail,
  workerExit: outcome.workerExit,
  close: outcome.close,
  prNumber: outcome.prNumber,
 };
}

/** Park the run: the event, the terminal row, the card. The claim stays. */
async function parkRun(
 ctx: RunNodeContext,
 nodeId: string,
 title: string,
 detail: string,
): Promise<RunNodeOutcome> {
 const repo = ctx.map.repo;
 ctx.journal.recordEvent("parked", { nodeId, repo, detail: detail.slice(0, 400) });
 finish(ctx.journal, nodeId, repo, "parked", detail);
 await parkCard(ctx.map, nodeId, title, detail);
 return { nodeId, repo, status: "parked", detail, workerExit: null };
}

/**
 * The run-node's start (node #81): ensure the canonical checkout, check its
 * git state against the known-good record before the first git call that
 * carries the write credential, then add the node's worktree and refresh
 * the record. A checkout this run cloned holds git's own fresh state, which
 * becomes the record. Parks the run on a refusal.
 */
async function trustedStart(
 ctx: RunNodeContext,
 nodeId: string,
 title: string,
 canonical: string,
 addWorktree: () => Promise<string>,
): Promise<{ state: GitState; worktree: string } | { parked: RunNodeOutcome }> {
 const { journal, map, token } = ctx;
 const cloned = await bootstrapCanonical(canonical, map.repo, token);
 const trust = cloned
  ? trustFreshClone(journal, canonical)
  : await checkKnownGood(journal, canonical, { repo: map.repo, nodeId });
 if (isRefusal(trust)) return { parked: await parkRun(ctx, nodeId, title, tamperOutcome(trust, canonical, mapKey(map))) };
 const worktree = await addWorktree();
 recordIfUnchanged(journal, canonical, trust.state, "worktree created");
 return { state: trust.state, worktree };
}

/** Best-effort park card: the journal + digest still carry the park when Discord fails. */
async function parkCard(
 map: RangerMapConfig,
 nodeId: string,
 title: string,
 detail: string,
): Promise<void> {
 try {
  await DiscordAnnouncer.fromMap(map).post(
   [
    `:ranger: **parked** #${nodeId} — ${title}`,
    `map: ${mapKey(map)}`,
    detail.slice(0, 1500),
    "Parked work waits for you: `ranger resume-node`, or take it in a session.",
   ].join("\n"),
   `park card for #${nodeId}`,
  );
 } catch {
  /* the parked row and its event are the durable record */
 }
}

async function resolveCommit(canonical: string, ref: string): Promise<string | null> {
 const head = await safeGit(["--no-replace-objects", "rev-parse", "--verify", `${ref}^{commit}`], { cwd: canonical });
 return head.code === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
}

async function resolveBranchSha(canonical: string, branch: string): Promise<string | null> {
 return resolveCommit(canonical, `refs/heads/${branch}`);
}

/**
 * Run one research node to completion: worktree → prompt → worker → gated
 * close → decisions --write.
 */
async function runResearch(
 nodeId: string,
 ctx: RunNodeContext,
 node: NodeResult,
 rootNode: NodeResult,
 generation: number,
): Promise<RunNodeOutcome> {
 const { config, map, token, botIdentity, journal } = ctx;
 const repo = map.repo;
 const base: RunNodeOutcome = { nodeId, repo, status: "skipped", detail: "", workerExit: null };
 const fence = (action: string) => journal.assertGeneration(nodeId, repo, generation, action);

 journal.recordEvent("worker-start", {
  nodeId,
  repo,
  detail: "worktree bootstrap",
 });
 const canonical = canonicalDir(config, map);
 const slug = slugify(node.node.title);
 const start = await trustedStart(ctx, nodeId, node.node.title, canonical, () =>
  bootstrapWorktree(canonical, nodeId, slug, token, undefined, map.base),
 );
 if ("parked" in start) return start.parked;
 const { worktree } = start;
 const branch = researchBranchFor(node.node);

 journal.recordEvent("worker-start", {
  nodeId,
  repo,
  detail: `worktree ${worktree}, branch ${branch}`,
 });
 journal.updateWorker(nodeId, repo, { worktree, lane: "research" });

 const github = ctx.github ?? githubApi;
 const recorded = journal.getWorker(nodeId, repo)?.prNumber ?? null;
 const existingPr = recorded === null
  ? await github.findPrByHead(repo, branch, token)
  : await github.getPr(repo, recorded, token);
 let baseSha = journal.getWorker(nodeId, repo)?.researchBaseSha ?? null;
 if (baseSha === null) {
  if (existingPr !== null || await resolveBranchSha(canonical, branch) !== null) {
   throw new ParkSignal(`research pre-worker base is missing for ${branch}; operator intervention required`);
  }
  baseSha = await resolveCommit(canonical, `refs/heads/${worktreeBranch(nodeId, slug)}`);
  if (baseSha === null) {
   throw new GitSafetyError(`cannot resolve research pre-worker base for node #${nodeId}`);
  }
  fence("record research base");
  journal.updateWorker(nodeId, repo, { researchBaseSha: baseSha });
 }
 let sha: string;

 // A retry after the draft was opened resumes its CI/close tail, without
 // asking a worker to recreate an existing findings branch.
 if (existingPr === null) {
  const prompt = assembleResearchPrompt({
   repo,
   node: {
    id: node.ref.id,
    title: node.node.title,
    body: node.body ?? "",
    kind: node.node.kind,
    autonomy: node.node.autonomy,
    checkpointId: node.node.checkpointId,
    url: node.url,
   },
   map: { title: rootNode.node.title, body: rootNode.body ?? "" },
   branch,
   worktree,
   botIdentity,
  });

  const wallClockMs =
   (ctx.wallClockMin ?? config.workers.wallClockMin) * 60_000;
  const workerCmd = ctx.workerCommand ?? defaultWorkerCommand();
  const workerRun =
   ctx.worker ??
   (async (p: string, opts: RunOptions) =>
    runCmd(workerCmd[0], [...workerCmd.slice(1), p], opts));

  // The run-node start check vetted this state against the known-good one.
  const snapshot = start.state.hash;
  fence("spawn the worker");
  const workerResult = await workerRun(prompt, {
   cwd: worktree,
   timeoutMs: wallClockMs,
   nice: config.workers.niceness,
   env: workerEnv(config, repo, sessionJournalPath()),
   processGroup: true,
   onSpawn: (pgid) => journal.updateWorker(nodeId, repo, { workerPgid: pgid }),
  });
  journal.updateWorker(nodeId, repo, { workerPgid: null });
  const log = saveWorkerLog(journal.path, repo, nodeId, generation, "research pass", workerResult);
  const stopped = hookStopReason(workerResult.stdout);
  if (stopped !== null) {
   throw new ParkSignal(policyBlockedOutcome({ pass: "research pass", reason: stopped, log }));
  }

  if (workerResult.code !== 0) {
   const detail = `worker exited ${workerResult.code}: ${workerResult.stderr.trim() || workerResult.stdout.trim().slice(0, 500)} (worker log: ${log})`;
   journal.recordEvent("refused", { nodeId, repo, detail });
   failNode(config, journal, nodeId, repo, detail);
   return { ...base, status: "failed", detail, workerExit: workerResult.code };
  }

  // Research SOP tail: findings must exist on the worktree.
  const findingsPath = join(worktree, "findings.md");
  if (!existsSync(findingsPath)) {
   const detail = `worker succeeded but wrote no findings.md at ${findingsPath} — the close would be hollow, so ranger refuses to close. (worker log: ${log})`;
   journal.recordEvent("refused", { nodeId, repo, detail });
   failNode(config, journal, nodeId, repo, detail);
   return { ...base, status: "failed", detail, workerExit: 0 };
  }

  journal.resetDeadman();

  // The VETTED PUSH (round-38 security blocker): the worker itself never sees
  // the machine write PAT — it COMMITS locally on the research branch but does
  // NOT push. The SUPERVISOR performs the single push of exactly the branch the
  // close gate probes, with hooks disabled and the git config checked against
  // the pre-worker snapshot (#23: the worker shares the canonical .git).
  try {
   await assertGitUntouched(canonical, snapshot);
   const head = await resolveBranchSha(canonical, branch);
   if (head === null) {
    throw new GitSafetyError(`research findings branch ${branch} is missing from the canonical checkout`);
   }
   sha = head;
   await assertResearchFindingsOnly(canonical, baseSha, sha);
   fence("push");
   const vetted = await vettedPush({
    worktree,
    canonical,
    branch,
    token,
    configSnapshot: snapshot,
    source: sha,
   });
   recordKnownGood(journal, canonical, vetted, "vetted push");
  } catch (error) {
   if (error instanceof FencedError) throw error;
   const detail = `research branch push failed (${branch}): ${error instanceof Error ? error.message : String(error)}`;
   journal.recordEvent("refused", { nodeId, repo, detail });
   failNode(config, journal, nodeId, repo, detail);
   return { ...base, status: "failed", detail, workerExit: 0 };
  }
 } else {
  const head = await resolveBranchSha(canonical, branch);
  if (head === null) {
   throw new ParkSignal(`research findings branch ${branch} is missing from the canonical checkout`);
  }
  sha = head;
  await assertResearchFindingsOnly(canonical, baseSha, sha);
 }
 const findings = await safeGit(["--no-replace-objects", "show", `${sha}:findings.md`], { cwd: canonical });
 if (findings.code !== 0 || findings.stdout.trim().length === 0) {
  throw new ParkSignal(`research findings.md is missing or empty at ${sha}`);
 }
 const evidence = await researchCi({
  ...ctx.researchCiTiming,
  repo, branch, base: map.base, sha, nodeId, token, pr: existingPr, github, fence,
  recordPr: (pr) => {
   journal.updateWorker(nodeId, repo, { prNumber: pr.number });
   if (existingPr === null) {
    journal.recordEvent("pr-opened", { nodeId, repo, detail: `research draft PR #${pr.number} ${pr.url}` });
   }
  },
 });
 journal.recordEvent("ci-passed", { nodeId, repo, detail: `research ${evidence.ci} (${evidence.check.name})` });
 const resolution = `${findings.stdout.trim()}\n\nResearch CI evidence: draft ${evidence.pr.url}, check run ${evidence.ci}.`;
 const resolutionFile = join(tmpdir(), `ranger-close-${repo.replace("/", "__")}-${nodeId}.md`);
 writeFileSync(resolutionFile, resolution, "utf8");

 // The close gate's ungated probes (git-ref-exists / artifact-exists) resolve
 // against the close runner's cwd — the probe tree is bounded to that tree
 // (DD-16 Amendment A containment). The findings branch lives in the canonical
 // checkout (a linked worktree's branch is a ref there), so the close must run
 // FROM the canonical checkout, not this supervisor's cwd. Found live on node
 // #19: the first close was refused because the probe resolved against the
 // walk's working tree. Design §4 / node #9: probes run in the canonical
 // checkout.
 const probeCwd = canonical;
 fence("close the node");
 const close = await graphClose(
  repo,
  nodeId,
  botIdentity,
  token,
  {
   resolutionFile,
   gist: gistFrom(resolution),
   checkpointId: node.node.checkpointId,
   ci: evidence.ci,
  },
  { cwd: probeCwd, timeoutMs: GRAPH_CALL_TIMEOUT_MS },
 );

 if (close.closed) {
  journal.recordEvent("closed", {
   nodeId,
   repo,
   detail: close.detail.slice(0, 400),
  });
  // graphDecisions is a best-effort map-level index re-projection AFTER a
  // confirmed close — its failure must NOT leave the worker row "running"
  // with no terminal outcome (round-38 review): the node IS closed (the
  // graph binds the resolution), so the worker is finalized as terminal
  // success regardless, with the decisions failure surfaced loudly in the
  // event log + worker outcome instead of silently dropping it.
  let decisionsDetail = "decisions --write after confirmed close";
  try {
   fence("write decisions");
   await graphDecisions(repo, String(map.root), token, {
    cwd: probeCwd,
    timeoutMs: GRAPH_CALL_TIMEOUT_MS,
   });
  } catch (decisionsError) {
   decisionsDetail = `decisions --write FAILED after close: ${decisionsError instanceof Error ? decisionsError.message : String(decisionsError)}`;
   journal.recordEvent("decisions-failed", {
    nodeId,
    repo,
    detail: decisionsDetail.slice(0, 400),
   });
  }
  journal.recordEvent("decisions-written", {
   nodeId,
   repo,
   detail: decisionsDetail.slice(0, 400),
  });
  finish(journal, nodeId, repo, "success", close.detail);
  return {
   ...base,
   status: "success",
   detail: close.detail.slice(0, 400),
   workerExit: existingPr === null ? 0 : null,
   close,
  };
 }

 journal.recordEvent("refused", {
  nodeId,
  repo,
  detail: close.detail.slice(0, 400),
 });
 countFailure(config, journal, repo);
 finish(journal, nodeId, repo, "parked", close.detail);
 return {
  ...base,
  status: "refused",
  detail: close.detail,
  workerExit: 0,
  close,
 };
}

/** First non-empty line of the resolution, truncated — the receipt's one-line form. */
function gistFrom(resolution: string): string {
 const first = resolution
  .split("\n")
  .map((l) => l.trim())
  .find((l) => l.length > 0);
 const raw = first ?? "ranger research close";
 return raw.length > 140 ? `${raw.slice(0, 137)}…` : raw;
}
