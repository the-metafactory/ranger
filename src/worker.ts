import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { expandHome } from "./config.ts";
import { runCmd, type RunOptions } from "./exec.ts";
import { graphNode } from "./graph.ts";
import { graphClose, graphDecisions, type CloseResult } from "./graph-write.ts";
import type { Journal } from "./journal.ts";
import { assembleResearchPrompt } from "./prompt.ts";

/**
 * The detached run-node supervisor (design §4, build-path step 3).
 *
 * One node = one worker session. The supervisor bootstraps a worktree off the
 * canonical checkout, assembles the worker prompt, spawns the headless worker
 * under the machine account's env (bounded by the wall-clock budget), then runs
 * the research SOP tail: confirm the findings branch, close through the gated
 * close (ungated probe + resolution-file + gist), and re-project decisions.
 */

export interface RunNodeOutcome {
 nodeId: string;
 repo: string;
 status: "success" | "failed" | "refused" | "skipped";
 detail: string;
 workerExit: number | null;
 close?: CloseResult;
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
 worker?: (prompt: string, opts: RunOptions) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/** The canonical checkout dir for a repo (design §4: probes run there). */
export function canonicalDir(config: RangerConfig, map: RangerMapConfig): string {
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
export function researchBranchFor(
  node: { title: string; probes?: { type: string; ref?: string }[] },
): string {
  const refProbe = (node.probes ?? []).find(
    (p) => p.type === "git-ref-exists" && typeof p.ref === "string" && p.ref.startsWith("research/"),
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

/** Basic-auth git header env (no credential persistence; the token never lands in .git/config). */
export function gitAuthEnv(
 token: string,
 base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
 const header = `AUTHORIZATION: basic ${Buffer.from(`${token}:x-oauth-basic`).toString("base64")}`;
 return {
  ...base,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraheader",
  GIT_CONFIG_VALUE_0: header,
 };
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
  const result = await runCmd(
   "git",
   ["clone", `https://github.com/${repo}.git`, dir],
   { env: gitAuthEnv(token), cwd: parent, timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
   throw new Error(
    `cannot bootstrap canonical checkout ${dir} (git clone, exit ${result.code}): ${result.stderr.trim()}`,
   );
  }
}

async function runGit(
  args: string[],
  opts: RunOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCmd("git", args, opts);
}

/** Add a worktree off origin/main (adopts an existing one on conflict). */
export async function bootstrapWorktree(
  canonical: string,
  nodeId: string,
  slug: string,
  token: string,
): Promise<string> {
  const dir = worktreeDir(canonical, nodeId);
  if (existsSync(dir)) {
   return dir; // adopt — a crashed worker's worktree is reused (design §7).
  }
  const branch = worktreeBranch(nodeId, slug);
  const result = await runGit(
   ["worktree", "add", dir, "-b", branch, "origin/main"],
   { cwd: canonical, env: gitAuthEnv(token), timeoutMs: 60_000 },
  );
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
 * Run one research node to completion: worktree → prompt → worker → gated
 * close → decisions --write. Returns the outcome and records it in the journal.
 */
export async function runNode(nodeId: string, ctx: RunNodeContext): Promise<RunNodeOutcome> {
 const { config, map, token, botIdentity, journal } = ctx;
 const repo = map.repo;
 const base: RunNodeOutcome = {
  nodeId,
  repo,
  status: "skipped",
  detail: "",
  workerExit: null,
 };

 try {
  const node = await graphNode(repo, nodeId, { token, source: "write-token" });
  const rootNode = await graphNode(repo, String(map.root), { token, source: "write-token" });

  if (node.node.kind !== "research") {
   const detail = `node #${nodeId} is kind '${node.node.kind}' — the research lane only walks research nodes (design §3).`;
   journal.recordEvent("refused", { nodeId, repo, detail });
   return { ...base, status: "refused", detail };
  }

  journal.recordEvent("worker-start", { nodeId, repo, detail: "worktree bootstrap" });
  const canonical = canonicalDir(config, map);
  await bootstrapCanonical(canonical, repo, token);
  const slug = slugify(node.node.title);
  const worktree = await bootstrapWorktree(canonical, nodeId, slug, token);
  const branch = researchBranchFor(node.node);

  // Preserve the claim's announce message id and the crash-attempt counter
  // across a run-node (a sweep respawn must not lose either).
  const prior = journal.getWorker(nodeId);
  const keep = {
   messageId: prior?.messageId ?? null,
   attempts: prior?.attempts ?? 0,
  };

  journal.recordEvent("worker-start", { nodeId, repo, detail: `worktree ${worktree}, branch ${branch}` });
  journal.upsertWorker({
   nodeId,
   repo,
   pid: process.pid,
   status: "running",
   attempts: keep.attempts,
   worktree,
   startedAt: new Date().toISOString(),
   messageId: keep.messageId,
  });

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

  const wallClockMs = (ctx.wallClockMin ?? config.workers.wallClockMin) * 60_000;
  const workerCmd = ctx.workerCommand ?? defaultWorkerCommand();
  const workerRun =
   ctx.worker ??
   (async (p: string, opts: RunOptions) =>
    runCmd(workerCmd[0], [...workerCmd.slice(1), p], opts));

  const workerResult = await workerRun(prompt, {
   cwd: worktree,
   timeoutMs: wallClockMs,
   env: workerEnv(token, config, repo),
  });
  journal.upsertWorker({
   nodeId,
   repo,
   pid: null,
   status: "running",
   attempts: keep.attempts,
   worktree,
   startedAt: new Date().toISOString(),
   messageId: keep.messageId,
  });

  if (workerResult.code !== 0) {
   const detail = `worker exited ${workerResult.code}: ${workerResult.stderr.trim() || workerResult.stdout.trim().slice(0, 500)}`;
   journal.recordEvent("refused", { nodeId, repo, detail });
   const count = journal.bumpDeadman();
   if (count >= config.workers.deadmanThreshold) {
    journal.setPaused(true);
    journal.recordEvent("deadman-paused", {
     repo,
     detail: `dead-man tripped at ${count} consecutive failures`,
    });
   }
   return { ...base, status: "failed", detail, workerExit: workerResult.code };
  }

  // Research SOP tail: findings must exist on the worktree.
  const findingsPath = join(worktree, "findings.md");
  if (!existsSync(findingsPath)) {
   const detail = `worker succeeded but wrote no findings.md at ${findingsPath} — the close would be hollow, so ranger refuses to close.`;
   journal.recordEvent("refused", { nodeId, repo, detail });
   journal.bumpDeadman();
   return { ...base, status: "failed", detail, workerExit: 0 };
  }

  journal.resetDeadman();

  const resolution = readFileSync(findingsPath, "utf8").trim();
  const resolutionFile = join(tmpdir(), `ranger-close-${nodeId}.md`);
  writeFileSync(resolutionFile, resolution, "utf8");

  const close = await graphClose(repo, nodeId, botIdentity, token, {
   resolutionFile,
   gist: gistFrom(resolution),
   checkpointId: node.node.checkpointId,
  });

  if (close.closed) {
   journal.recordEvent("closed", { nodeId, repo, detail: close.detail.slice(0, 400) });
   await graphDecisions(repo, String(map.root), token);
   journal.recordEvent("decisions-written", { nodeId, repo, detail: "decisions --write after confirmed close" });
   journal.upsertWorker({
    nodeId,
    repo,
    pid: null,
    status: "success",
    attempts: keep.attempts,
    worktree,
    startedAt: null,
    finishedAt: new Date().toISOString(),
    outcome: close.detail.slice(0, 400),
    messageId: keep.messageId,
   });
   return { ...base, status: "success", detail: close.detail.slice(0, 400), workerExit: 0, close };
  }

  journal.recordEvent("refused", { nodeId, repo, detail: close.detail.slice(0, 400) });
  journal.bumpDeadman();
  journal.upsertWorker({
   nodeId,
   repo,
   pid: null,
   status: "parked",
   attempts: keep.attempts,
   worktree,
   startedAt: null,
   finishedAt: new Date().toISOString(),
   outcome: close.detail.slice(0, 400),
   messageId: keep.messageId,
  });
  return { ...base, status: "refused", detail: close.detail, workerExit: 0, close };
 } catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  journal.recordEvent("refused", { nodeId, repo, detail: detail.slice(0, 400) });
  journal.bumpDeadman();
  return { ...base, status: "failed", detail };
 }
}

/** Worker env: machine-account git auth, repo context, no keychain, no approver token. */
function workerEnv(
 token: string,
 config: RangerConfig,
 repo: string,
): NodeJS.ProcessEnv {
 return gitAuthEnv(token, {
  ...process.env,
  SOMA_GRAPH_REPO: repo,
  SAGE_STACK: "default",
  PILOT_PRINCIPAL: config.principal.login,
 });
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
