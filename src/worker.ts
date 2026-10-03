import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { expandHome } from "./config.ts";
import { DiscordAnnouncer } from "./announce.ts";
import { runCmd, type RunOptions } from "./exec.ts";
import {
 fastForwardCanonical,
 gitConfigSnapshot,
 safeGit,
 GitSafetyError,
 vettedPush,
} from "./git-ops.ts";
import { GRAPH_CALL_TIMEOUT_MS, graphNode, type NodeResult } from "./graph.ts";
import { graphClose, graphDecisions, type CloseResult } from "./graph-write.ts";
import {
 implementBranchFor,
 ParkSignal,
 runImplement,
 type GitHubPort,
 type ImplementOutcome,
 type Reviewer,
} from "./implement.ts";
import { FencedError, type Journal } from "./journal.ts";
import { assembleResearchPrompt } from "./prompt.ts";
import { IMPLEMENT_KINDS } from "./route.ts";
import { resolveReadOnlyToken } from "./token-gate.ts";
import { workerEnv } from "./worker-env.ts";

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
  * Defaults to `RANGER_WORKER_CMD` (or `claude`) + `["-p"]`. Tests point this
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
 /** For tests: the implement lane's forge and reviewer. */
 github?: GitHubPort;
 reviewer?: Reviewer;
 /** For tests: the read-only token (defaults to the map's `auth.readOnlyTokens` env). */
 readOnlyToken?: string;
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

/** Ensure the canonical checkout exists (clone on first use). Read-only ops only. */
export async function bootstrapCanonical(
 dir: string,
 repo: string,
 token: string,
): Promise<void> {
 if (existsSync(dir) && existsSync(join(dir, ".git"))) {
  return;
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
 const args =
  existing.code === 0
   ? ["worktree", "add", dir, branch]
   : ["worktree", "add", dir, "-b", branch, `origin/${base}`];
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

/** Mark the row terminal: the supervisor PID is released only here (F1). */
function finish(
 journal: Journal,
 nodeId: string,
 status: "success" | "failed" | "parked",
 outcome: string,
): void {
 journal.updateWorker(nodeId, {
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
 const { config, map, token, journal } = ctx;
 const repo = map.repo;
 const base: RunNodeOutcome = {
  nodeId,
  repo,
  status: "skipped",
  detail: "",
  workerExit: null,
 };

 // Take the node as a new occupant. A run-node with no claim row (an
 // operator's manual run) gets a running row first.
 if (journal.getWorker(nodeId) === null) {
  journal.upsertWorker({ nodeId, repo, status: "running", attempts: 0 });
 }
 const generation = journal.beginGeneration(nodeId);
 // The supervisor's PID stays on the row until a terminal state (F1): a
 // supervisor crash anywhere in the SOP tail is then visible to sweep.
 journal.updateWorker(nodeId, {
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
  finish(journal, nodeId, "parked", detail);
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
  countFailure(config, journal, repo);
  finish(journal, nodeId, "failed", detail);
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
  finish(journal, nodeId, "parked", ratify);
  return { ...base, status: "refused", detail: ratify };
 }
 const readOnlyToken = ctx.readOnlyToken ?? resolveReadOnlyToken(config, repo).token;

 const canonical = canonicalDir(config, map);
 await bootstrapCanonical(canonical, repo, token);
 await fastForwardCanonical(canonical, map.base, token);
 const slug = slugify(node.node.title);
 const branch = implementBranchFor(node.node, worktreeBranch(nodeId, slug));
 const worktree = await bootstrapWorktree(canonical, nodeId, slug, token, branch, map.base);
 journal.updateWorker(nodeId, { worktree, lane: "implement" });

 const workerCmd = ctx.workerCommand ?? defaultWorkerCommand();
 let outcome: ImplementOutcome;
 try {
  outcome = await runImplement({
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
   workerRun:
    ctx.worker ??
    ((p: string, opts: RunOptions) => runCmd(workerCmd[0], [...workerCmd.slice(1), p], opts)),
   github: ctx.github,
   reviewer: ctx.reviewer,
  });
 } catch (error) {
  if (error instanceof ParkSignal || error instanceof GitSafetyError) {
   const detail = error.message;
   journal.recordEvent("parked", { nodeId, repo, detail: detail.slice(0, 400) });
   finish(journal, nodeId, "parked", detail);
   await parkCard(map, nodeId, node.node.title, detail);
   return { ...base, status: "parked", detail };
  }
  throw error;
 }

 switch (outcome.status) {
  case "success":
   journal.resetDeadman();
   finish(journal, nodeId, "success", outcome.detail);
   break;
  case "awaiting-merge":
   journal.resetDeadman();
   // The row already says awaiting-merge; the supervisor exits, so its PID goes.
   journal.updateWorker(nodeId, { pid: null });
   break;
  case "refused":
   journal.recordEvent("refused", { nodeId, repo, detail: outcome.detail.slice(0, 400) });
   finish(journal, nodeId, "parked", outcome.detail);
   break;
  default:
   journal.recordEvent("refused", { nodeId, repo, detail: outcome.detail.slice(0, 400) });
   countFailure(config, journal, repo);
   finish(journal, nodeId, "failed", outcome.detail);
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
    `map: ${map.repo}`,
    detail.slice(0, 1500),
    "Parked work waits for you: `ranger resume-node`, or take it in a session.",
   ].join("\n"),
   `park card for #${nodeId}`,
  );
 } catch {
  /* the parked row and its event are the durable record */
 }
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
 const fence = (action: string) => journal.assertGeneration(nodeId, generation, action);

 journal.recordEvent("worker-start", {
  nodeId,
  repo,
  detail: "worktree bootstrap",
 });
 const canonical = canonicalDir(config, map);
 await bootstrapCanonical(canonical, repo, token);
 const slug = slugify(node.node.title);
 const worktree = await bootstrapWorktree(canonical, nodeId, slug, token);
 const branch = researchBranchFor(node.node);

 journal.recordEvent("worker-start", {
  nodeId,
  repo,
  detail: `worktree ${worktree}, branch ${branch}`,
 });
 journal.updateWorker(nodeId, { worktree, lane: "research" });

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

 const snapshot = gitConfigSnapshot(canonical);
 fence("spawn the worker");
 const workerResult = await workerRun(prompt, {
  cwd: worktree,
  timeoutMs: wallClockMs,
  env: workerEnv(config, repo),
  processGroup: true,
  onSpawn: (pgid) => journal.updateWorker(nodeId, { workerPgid: pgid }),
 });
 journal.updateWorker(nodeId, { workerPgid: null });

 if (workerResult.code !== 0) {
  const detail = `worker exited ${workerResult.code}: ${workerResult.stderr.trim() || workerResult.stdout.trim().slice(0, 500)}`;
  journal.recordEvent("refused", { nodeId, repo, detail });
  countFailure(config, journal, repo);
  finish(journal, nodeId, "failed", detail);
  return { ...base, status: "failed", detail, workerExit: workerResult.code };
 }

 // Research SOP tail: findings must exist on the worktree.
 const findingsPath = join(worktree, "findings.md");
 if (!existsSync(findingsPath)) {
  const detail = `worker succeeded but wrote no findings.md at ${findingsPath} — the close would be hollow, so ranger refuses to close.`;
  journal.recordEvent("refused", { nodeId, repo, detail });
  countFailure(config, journal, repo);
  finish(journal, nodeId, "failed", detail);
  return { ...base, status: "failed", detail, workerExit: 0 };
 }

 journal.resetDeadman();

 // The VETTED PUSH (round-38 security blocker): the worker itself never sees
 // the machine write PAT — it COMMITS locally on the research branch but does
 // NOT push. The SUPERVISOR performs the single push of exactly the branch the
 // close gate probes, with hooks disabled and the git config checked against
 // the pre-worker snapshot (#23: the worker shares the canonical .git).
 try {
  fence("push");
  await vettedPush({
   worktree,
   canonical,
   branch,
   token,
   configSnapshot: snapshot,
   source: `refs/heads/${branch}`,
  });
 } catch (error) {
  if (error instanceof FencedError) throw error;
  const detail = `research branch push failed (${branch}): ${error instanceof Error ? error.message : String(error)}`;
  journal.recordEvent("refused", { nodeId, repo, detail });
  countFailure(config, journal, repo);
  finish(journal, nodeId, "failed", detail);
  return { ...base, status: "failed", detail, workerExit: 0 };
 }

 const resolution = readFileSync(findingsPath, "utf8").trim();
 const resolutionFile = join(tmpdir(), `ranger-close-${nodeId}.md`);
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
  finish(journal, nodeId, "success", close.detail);
  return {
   ...base,
   status: "success",
   detail: close.detail.slice(0, 400),
   workerExit: 0,
   close,
  };
 }

 journal.recordEvent("refused", {
  nodeId,
  repo,
  detail: close.detail.slice(0, 400),
 });
 countFailure(config, journal, repo);
 finish(journal, nodeId, "parked", close.detail);
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
