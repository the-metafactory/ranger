#!/usr/bin/env bun
import { readPrivateJson } from "./remote-test/ssh-cli.ts";
import { implementLane, startsImplementSession } from "./lanes.ts";
import { executionRefusal, isGithubRepo } from "./forge-ref.ts";
import { laneHeldMessage, recordImplementStart, mapKey, pickMap, resumeMap } from "./maps.ts";
import { Command } from "commander";
import { join, resolve } from "node:path";
import {
 loadConfig,
 expandHome,
 type RangerConfig,
 type RangerMapConfig,
} from "./config.ts";
import {
 graphAudit,
 graphFrontier,
 graphNode,
 type FrontierEntry,
 type NodeResult,
} from "./graph.ts";
import {
 renderJson,
 renderText,
 type ClaimCard,
 type MapReport,
 type ScoutReport,
} from "./report.ts";
import { classify, hitlWaiting, loadProbeRegistry } from "./route.ts";
import {
 assertReadOnlyToken,
 GateError,
 type ResolvedToken,
} from "./token-gate.ts";
import { openJournal, type Journal } from "./journal.ts";
import {
 assertWriteIdentity,
 WriteGateError,
} from "./identity.ts";
import { canonicalDir, runNode } from "./worker.ts";
import { trustCurrentGitState } from "./git-trust.ts";
import { sweepMap } from "./sweep.ts";
import { mergeGateNow } from "./merge-desk.ts";
import { realGitHub } from "./implement.ts";
import { spawnRunNodeDetached, walk } from "./walk.ts";
import { holdAwake } from "./awake.ts";
import { BUILD_NOW_NOT_STARTED, buildNow, type BuildNowResult } from "./build-now.ts";
import { startServe } from "./serve.ts";
import {
 escalateMaps,
 runDigest,
 type EscalateResult,
 type DigestResult,
} from "./escalate.ts";
import type { WalkMode } from "./config.ts";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { summarizeShadow, writeShadowReport } from "./remote-test/shadow.ts";
import { runBaseline, validateBaselineConfig, createCommandMetrics, localCommandAdapter, sshCommandAdapter, privateOperatorPath, writePrivateBaselineReport } from "./remote-test/baseline.ts";
import { executeRemoteTest, reconcileRemoteTests, validateExecutorConfig } from "./remote-test/executor.ts";
import { ActiveRemoteTestJob, BusyRemoteTestExecutor, RevokedRemoteTestJob, openJobLedger } from "./remote-test/job-ledger.ts";
import { validateRemoteTestJob } from "./remote-test/contract.ts";
import { publishReceiptFile } from "./remote-test/artifacts.ts";
import { runSshCommand, statusSshCommand, sshOutcomeExitCode, sshOutcomeMessage, type RunSshCommand } from "./remote-test/ssh-cli.ts";
import { serveSshResponse } from "./remote-test/ssh-server.ts";

/**
 * ranger — autonomous orienteer work-graph walker.
 *
 * - `scout` (node #12) — read-only frontier/audit/HITL digest. Zero graph writes.
 * - `walk` (node #13) — the headless tick: claim + spawn + sweep. Graph writes.
 * - `run-node <id>` — the detached worker supervisor (research + implement lanes).
 * - `build-now <id>` (node #58) — the walk's claim for one chosen node, started now.
 * - `sweep` — reconcile the journal against reality.
 * - `journal` — inspect the journal.
 * - `serve` (node #37) — local read-only dashboard; launches the principal's
 *   own grilling sessions, never a graph write.
 */

const READONLY_SURFACE = ["audit", "frontier", "node"] as const;

interface ScoutOptions {
 config: string;
 json: boolean;
}

async function scoutOneMap(
 config: RangerConfig,
 map: { repo: string; root: number; walk: WalkMode; nodes?: string[]; skip?: string[] },
 registry: ReturnType<typeof loadProbeRegistry>,
): Promise<MapReport> {
 const base: MapReport = {
  repo: map.repo,
  root: map.root,
  walk: map.walk,
  ok: true,
  frontier: [],
  hitlWaiting: [],
  claims: [],
  receiptLessCloses: [],
  openWithoutCheckpoint: [],
  auditNodes: 0,
 };

 let token: ResolvedToken;
 try {
  ({ token } = await assertReadOnlyToken(config, map.repo));
 } catch (error) {
  return {
   ...base,
   ok: false,
   error: error instanceof GateError ? error.message : String(error),
  };
 }

 try {
  const [frontier, audit] = await Promise.all([
   graphFrontier(map.repo, map.root, token),
   graphAudit(map.repo, map.root, token),
  ]);

  const classified = frontier.frontier.map((entry: FrontierEntry) =>
   classify(entry, map.repo, map.walk, registry, {
        botIdentity: config.bot.identity,
        allowlist: map.nodes,
        skip: map.skip,
      }),
  );
  const waiting = hitlWaiting(classified);

  const claims: ClaimCard[] = [];
  for (const claimed of audit.openClaimed) {
   const node: NodeResult = await graphNode(map.repo, claimed.id, token);
   claims.push({
    id: claimed.id,
    title: node.node.title,
    assignees: claimed.assignees,
    worker: "unknown",
   });
  }

  return {
   ...base,
   frontier: classified,
   hitlWaiting: waiting,
   claims,
   receiptLessCloses: audit.closedWithoutReceipt,
   openWithoutCheckpoint: audit.openWithoutCheckpoint,
   auditNodes: audit.nodes,
  };
 } catch (error) {
  return {
   ...base,
   ok: false,
   error: error instanceof Error ? error.message : String(error),
  };
 }
}

async function runScout(opts: ScoutOptions): Promise<ScoutReport> {
 const configPath = resolve(process.cwd(), opts.config);
 const { config } = loadConfig(configPath);
 const registry = loadProbeRegistry();

 let identity = {
  login: "",
  tokenType: "fine-grained" as "classic" | "fine-grained",
 };
 for (const map of config.maps) {
  if (!isGithubRepo(map.repo)) continue;
  try {
   const { info } = await assertReadOnlyToken(config, map.repo);
   if (info.forge !== "github") continue;
   identity = { login: info.login, tokenType: info.tokenType };
   break;
  } catch {
   /* per-map gate handles the error */
  }
 }

 const maps: MapReport[] = [];
 for (const map of config.maps) {
  maps.push(await scoutOneMap(config, map, registry));
 }

 return {
  generatedAt: new Date().toISOString(),
  identity,
  readonlySurface: [...READONLY_SURFACE],
  maps,
 };
}

// ---- walker commands ----

function loadCtx(configPath: string): {
 config: RangerConfig;
 journal: Journal;
} {
 const { config } = loadConfig(configPath);
 const journal = openJournal(config);
 return { config, journal };
}

/** Resolve the write credential + bot identity for a map, gating the principal. */
async function writeContext(config: RangerConfig, map: RangerMapConfig) {
 const refusal = executionRefusal(map.repo);
 if (refusal !== null) throw new WriteGateError(refusal);
 return assertWriteIdentity(config, map.repo);
}

async function runWalk(configPath: string): Promise<string> {
 const { config, journal } = loadCtx(configPath);
 const result = await walk({ config, configPath, journal });
 return renderWalkJson(result);
}

async function runRunNode(
 nodeId: string,
 repo: string | undefined,
 configPath: string,
): Promise<string> {
 const { config, journal } = loadCtx(configPath);
 const map = pickMap(config, repo);
 const { token, botIdentity } = await writeContext(config, map);
 const outcome = await runNode(nodeId, {
  config,
  map,
  token,
  botIdentity,
  journal,
 });
 journal.close();
 return JSON.stringify(outcome, null, 2);
}

async function runSweep(configPath: string): Promise<string> {
 const { config, journal } = loadCtx(configPath);
 const results = [];
 for (const map of config.maps) {
  if (map.walk === "none") {
   results.push({
    repo: map.repo,
    walk: map.walk,
    swept: false,
    reason: "walk: none",
   });
   continue;
  }
  try {
   const { token, botIdentity } = await writeContext(config, map);
   const result = await sweepMap({ config, journal, map, token, botIdentity });
   results.push({ repo: map.repo, walk: map.walk, swept: true, result });
  } catch (error) {
   results.push({
    repo: map.repo,
    walk: map.walk,
    swept: false,
    error: error instanceof Error ? error.message : String(error),
   });
  }
 }
 journal.close();
 return JSON.stringify(results, null, 2);
}

/** How long `merge-desk --settle` waits for GitHub to compute mergeability, and how often it asks. */
const SETTLE_MAX_MS = 90_000;
const SETTLE_POLL_MS = 10_000;

/**
 * A merge moves the base under every other PR on the map, and GitHub
 * recomputes their mergeability lazily: a desk pass right after the merge
 * reads null ("still computing") and leaves a PR that now conflicts for the
 * next tick. Wait until every awaiting-merge PR on the map has a computed
 * answer (bounded), so the pass that follows sends a conflict back for its
 * base merge now.
 */
async function settleMergeability(journal: Journal, map: RangerMapConfig, token: string): Promise<void> {
 const prs = journal
  .listWorkers(map.repo, map.root)
  .filter((w) => w.status === "awaiting-merge" && w.prNumber !== null)
  .map((w) => w.prNumber as number);
 const deadline = Date.now() + SETTLE_MAX_MS;
 let waiting = prs;
 while (waiting.length > 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  const still: number[] = [];
  for (const n of waiting) {
   try {
    const pr = await realGitHub.getPr(map.repo, n, token);
    if (pr.state === "open" && pr.mergeState === "pending") still.push(n);
   } catch {
    still.push(n);
   }
  }
  waiting = still;
 }
}

/**
 * Operator verb: the merge desk's gate for one node's PR, read live. Exits 0
 * only when the gate passes at exactly `sha`; otherwise it names the check
 * on stderr and exits 2. Reads only. `ranger serve` runs it before a
 * dashboard merge of an awaiting-merge row.
 */
async function runMergeGate(nodeId: string, selector: string, sha: string, configPath: string): Promise<{ ok: boolean; text: string }> {
 const { config, journal } = loadCtx(configPath);
 try {
  const map = pickMap(config, selector);
  const row = journal.getWorker(nodeId, map.repo);
  if (row === null || row.root !== map.root || row.prNumber === null) {
   return { ok: false, text: `node ${nodeId} has no PR recorded on ${mapKey(map)}` };
  }
  const { token, botIdentity } = await writeContext(config, map);
  const gate = await mergeGateNow(realGitHub, map, row.prNumber, token, botIdentity);
  if (gate.status !== "pass") return { ok: false, text: `merge gate ${gate.status} (${gate.check}): ${gate.reason}` };
  if (gate.headSha !== sha) {
   return { ok: false, text: `the gate passes at ${gate.headSha.slice(0, 8)}, not at the confirmed head ${sha.slice(0, 8)}` };
  }
  return { ok: true, text: JSON.stringify({ nodeId, pr: row.prNumber, gate }, null, 2) };
 } finally {
  journal.close();
 }
}

/**
 * Operator verb: one map's merge desk, now — the tick's desk phase for that
 * map alone. `ranger serve` runs it after a dashboard merge, so the merged
 * node starts its close without waiting for the next tick. Like the tick it
 * spawns the close (and any send-back) as a detached run-node.
 */
async function runMergeDeskNow(selector: string, configPath: string, settle = false): Promise<string> {
 const { config, journal } = loadCtx(configPath);
 try {
  const map = pickMap(config, selector);
  const { token, botIdentity } = await writeContext(config, map);
  if (settle) await settleMergeability(journal, map, token);
  const result = await sweepMap({
   config,
   journal,
   map,
   token,
   botIdentity,
   phase: "desk",
   respawn: (nodeId, repo, root) =>
    spawnRunNodeDetached({ nodeId, repo, root, cliEntry: join(import.meta.dir, "cli.ts"), configPath }),
  });
  return JSON.stringify(result.mergeDesk ?? { idle: "no row on this map waits on a merge" }, null, 2);
 } finally {
  journal.close();
 }
}

/**
 * Operator verb (design §5/§7): put a parked, failed or stuck node back in
 * motion. The row returns to `claimed` and a detached run-node takes it as a
 * new occupant; the implement lane re-derives its phase from GitHub (F2), so
 * a resumed node picks up where its PR is. The tracker claim is untouched —
 * a node whose claim was released must be re-claimed by the walk instead.
 */
async function runResumeNode(
 nodeId: string,
 repo: string | undefined,
 configPath: string,
 force?: boolean,
): Promise<string> {
 const { config, journal } = loadCtx(configPath);
 try {
  const map = resumeMap(config, journal.listWorkers(), nodeId, repo);
  await writeContext(config, map); // the same identity gate as run-node
  const row = journal.getWorker(nodeId, map.repo);
  if (row === null || row.repo !== map.repo) {
   throw new Error(`no journal row for node ${nodeId} on ${map.repo} — nothing to resume`);
  }
  if (row.status === "released") {
   throw new Error(`node ${nodeId}'s claim was released — the walk re-claims it from the frontier`);
  }
  // A resume starts a worker session in this map's resource lane.
  const lane = implementLane(map);
  const takesLane = startsImplementSession(row);
  const holder = takesLane ? journal.laneHolder(lane, { nodeId, repo: map.repo }) : null;
  if (holder !== null && force !== true) {
   throw new Error(laneHeldMessage(lane, holder, "resume", nodeId));
  }
  journal.updateWorker(nodeId, map.repo, { status: "claimed", pid: null, workerPgid: null, finishedAt: null });
  if (takesLane) recordImplementStart(journal, map);
  const pid = await spawnRunNodeDetached({
   nodeId,
   repo: map.repo,
   root: map.root,
   cliEntry: join(import.meta.dir, "cli.ts"),
   configPath,
  });
  if (pid !== null) journal.updateWorker(nodeId, map.repo, { pid });
  journal.recordEvent("sweep", { nodeId, repo: map.repo, detail: `resume-node by operator (was ${row.status}); run-node pid ${pid ?? "none"}` });
  return JSON.stringify({ nodeId, repo: map.repo, root: map.root, was: row.status, pid }, null, 2);
 } finally {
  journal.close();
 }
}

/**
 * Operator verb (node #58): claim one walkable frontier node and start it
 * now, through the walk's own classification and claim (src/build-now.ts).
 */
async function runBuildNow(
 nodeId: string,
 selector: string,
 configPath: string,
 force?: boolean,
): Promise<{ result: BuildNowResult; out: string }> {
 const { config, journal } = loadCtx(configPath);
 try {
  const map = pickMap(config, selector);
  if (map.walk === "none") throw new Error(`${mapKey(map)} is walk: none — registered, not walked`);
  const { token, botIdentity } = await writeContext(config, map);
  const result = await buildNow(nodeId, { config, configPath, journal, map, token, botIdentity, force });
  return { result, out: JSON.stringify(result, null, 2) };
 } finally {
  journal.close();
 }
}

/**
 * Operator verb (node #81): list what changed in the canonical checkout's git
 * state since ranger last saw it clean, with the state's hash; with that
 * hash, adopt exactly that state as known-good. Run-nodes park on any other
 * change.
 */
async function runTrustGit(selector: string, configPath: string, hash?: string): Promise<string> {
 const { config, journal } = loadCtx(configPath);
 try {
  const map = pickMap(config, selector);
  const canonical = canonicalDir(config, map);
  const result = await trustCurrentGitState(journal, canonical, map.repo, hash);
  const next = result.recorded
   ? {}
   : { next: `vet every change listed, then: ranger trust-git --map ${mapKey(map)} --hash ${result.hash}` };
  return JSON.stringify({ map: mapKey(map), canonical, ...result, ...next }, null, 2);
 } finally {
  journal.close();
 }
}

/** Operator verb (design §7): clear the dead-man pause and its counter. */
function runResumeRun(configPath: string): string {
 const { journal } = loadCtx(configPath);
 const was = { paused: journal.isPaused(), deadmanCount: journal.deadmanCount() };
 journal.setPaused(false);
 journal.resetDeadman();
 journal.recordEvent("sweep", { detail: `resume-run by operator (was paused=${was.paused}, dead-man ${was.deadmanCount})` });
 journal.close();
 return JSON.stringify({ resumed: true, was }, null, 2);
}

async function runJournal(
 repo: string | undefined,
 configPath: string,
): Promise<string> {
 const { config, journal } = loadCtx(configPath);
 const target = repo === undefined ? undefined : normalizeRepo(repo, config);
 const rows = {
  journalPath: expandHome(config.state.journalPath),
  paused: journal.isPaused(),
  deadmanCount: journal.deadmanCount(),
  spawnsToday: journal.spawnsToday(),
  workers: journal.listWorkers(target),
  escalations: journal.listEscalations(target),
  events: journal.listEvents(target, 50),
 };
 journal.close();
 return JSON.stringify(rows, null, 2);
}

function normalizeRepo(repo: string, config: RangerConfig): string {
 const map = config.maps.find(
  (m) => m.repo === repo || m.repo.endsWith(`/${repo}`),
 );
 return map?.repo ?? repo;
}

function renderWalkJson(result: unknown): string {
 return JSON.stringify(result, null, 2);
}

function renderEscalateText(result: EscalateResult | DigestResult): string {
 const lines: string[] = [`ranger escalate — ${result.generatedAt}`];
 for (const map of result.maps) {
  if (!map.ok) {
   lines.push(`map: ${map.repo}`, `  ✗ FAILED — ${map.error}`, "");
   continue;
  }
  if (map.kind === "digest") {
   const d = map;
   lines.push(`map: ${map.repo} (digest ${d.action} ${d.digestMessageId})`);
   lines.push(
    `  cards: ${d.cards.length}${d.cards.length ? ` (${d.cards.map((c) => `#${c.nodeId} ${c.ageDays}d`).join(", ")})` : " — clean"}`,
   );
   lines.push(
    `  audit: receipt-less ${d.receiptLessCloses.length}${d.receiptLessCloses.length ? ` ${d.receiptLessCloses.join(",")}` : ""} · stale ${d.openClaims.length} · budget ${d.budget.spawnsToday}/${d.budget.spawnCapPerDay}${d.budget.paused ? " PAUSED" : ""}`,
   );
  } else {
   const e = map;
   lines.push(`map: ${map.repo}`);
   lines.push(
    `  posted: ${e.posted.length ? e.posted.map((n) => `#${n}`).join(", ") : "—"}`,
   );
   lines.push(
    `  edited: ${e.edited.length ? e.edited.map((n) => `#${n}`).join(", ") : "—"}`,
   );
   lines.push(
    `  keptOpen: ${e.keptOpen.length ? e.keptOpen.map((n) => `#${n}`).join(", ") : "—"}`,
   );
   lines.push(`  cards: ${e.cards.length}`);
   if (e.cardErrors.length > 0) {
    lines.push(`  ⚠ retry-next-tick: ${e.cardErrors.join("; ")}`);
   }
  }
  lines.push("");
 }
 return lines.join("\n").trimEnd();
}

const program = new Command();
program
 .name("ranger")
 .description("Autonomous orienteer work-graph walker")
 .version("0.1.0");

const remoteTest = program.command("remote-test")
 .description("Operator-only remote-test tooling; local verification remains the default");

remoteTest.command("run")
 .description("Stage a clean HEAD, save its exact job, then submit once over verified SSH")
 .requiredOption("--config <path>", "private reviewed SSH endpoint/profile JSON")
 .requiredOption("--request <path>", "private V1 request excluding commit/tree/bundle digests")
 .requiredOption("--worktree <path>", "clean committed source worktree")
 .requiredOption("--staging-root <path>", "existing private source staging root outside git")
 .requiredOption("--job-output <path>", "new private exact job JSON for receipt lookup")
 .requiredOption("--output <path>", "new private terminal receipt JSON")
 .action(async (options: RunSshCommand) => {
  const abort = new AbortController(), cancel = () => abort.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try { const result = await runSshCommand(options, { signal: abort.signal }); process.stdout.write(sshOutcomeMessage(result)); process.exitCode = sshOutcomeExitCode(result); }
  catch { process.stderr.write("ranger remote-test run: private input, staging or publication failed. If an exact job was saved, query status before any retry.\n"); process.exitCode = 1; }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
 });

remoteTest.command("status")
 .description("Retrieve only the saved exact job's terminal receipt; never resubmit")
 .requiredOption("--config <path>", "private reviewed SSH endpoint/profile JSON")
 .requiredOption("--job <path>", "saved exact V1 job JSON")
 .requiredOption("--output <path>", "new private terminal receipt JSON")
 .action(async (options: { config: string; job: string; output: string }) => {
  const abort = new AbortController(), cancel = () => abort.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try { const result = await statusSshCommand(options, { signal: abort.signal }); process.stdout.write(sshOutcomeMessage(result)); process.exitCode = sshOutcomeExitCode(result); }
  catch { process.stderr.write("ranger remote-test status: private input or receipt publication failed.\n"); process.exitCode = 1; }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
 });

remoteTest.command("serve-stdio")
 .description("Fixed operator-only SSH entry point: receive one structured request on stdin")
 .requiredOption("--config <path>", "reviewed private executor JSON configuration")
 .action(async (options: { config: string }) => {
  const abort = new AbortController(), cancel = () => { abort.abort(); process.stdin.destroy(Error("SSH input interrupted")); };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel); process.once("SIGHUP", cancel);
  // Includes upload idle time and bounded executor cleanup. No silent daemon.
  const timer = setTimeout(cancel, 15 * 60_000);
  try {
   const config = JSON.parse(await readFile(await privateOperatorPath(options.config, true), "utf8"));
   const response = await serveSshResponse(process.stdin, config, { signal: abort.signal });
   process.stdout.write(JSON.stringify(response) + "\n");
  } catch { process.stderr.write("ranger remote-test serve-stdio: request, admission, execution or storage failed; inspect private operator state.\n"); process.exitCode = 1; }
  finally { clearTimeout(timer); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); process.removeListener("SIGHUP", cancel); }
 });

remoteTest.command("execute")
 .description("Execute one admitted immutable job using an operator-owned profile and rootless Podman")
 .requiredOption("--config <path>", "reviewed private executor JSON configuration")
 .requiredOption("--job <path>", "admitted V1 job identity JSON")
 .requiredOption("--bundle <path>", "staged immutable Git bundle")
 .requiredOption("--output <path>", "new private terminal receipt JSON")
 .action(async (options: { config: string; job: string; bundle: string; output: string }) => {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  let receiptStored = false;
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
   const config = validateExecutorConfig(JSON.parse(await readFile(await privateOperatorPath(options.config, true), "utf8")));
   const job = JSON.parse(await readFile(options.job, "utf8"));
   // Reject tracked operator state and reserve the receipt before any execution.
   await privateOperatorPath(`${config.jobsRoot}/receipt-check`);
   const destination = await privateOperatorPath(options.output);
   const reservation = `${destination}.reservation`;
   await mkdir(reservation, { mode: 0o700 });
   try {
    try { await lstat(destination); throw Error("Receipt output already exists"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const receipt = await executeRemoteTest({ config, job, bundlePath: options.bundle }, { signal: abort.signal });
    receiptStored = true;
    await publishReceiptFile(destination, receipt);
    process.stdout.write(`Remote-test ${receipt.status}; private receipt saved.\n`);
    process.exitCode = receipt.status === "passed" ? 0 : 1;
   } finally { await rm(reservation, { recursive: true }); }
  } catch (error) {
   if (error instanceof ActiveRemoteTestJob) {
    process.stderr.write(`Remote-test active (attempt ${error.status.attempt}); query status.\n`); process.exitCode = 1; return;
   }
   if (error instanceof RevokedRemoteTestJob) {
    process.stderr.write("Remote-test observed passed outcome is revoked; no accepted success.\n"); process.exitCode = 1; return;
   }
   if (error instanceof BusyRemoteTestExecutor) {
    process.stderr.write("Remote-test executor busy; this job was not admitted. Inspect the active attempt or recover with the executor stopped.\n"); process.exitCode = 1; return;
   }
   process.stderr.write(receiptStored
    ? "ranger remote-test execute: durable receipt stored; output export failed. Repeat execute with the identical job and a new output path, or query status; do not export loose artifacts.\n"
    : "ranger remote-test execute: configuration, admission, execution or receipt storage failed; inspect private state and recover interrupted attempts with the executor stopped.\n");
   process.exitCode = 1;
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
 });

remoteTest.command("recover")
 .description("Reconcile interrupted jobs; requires the former executor to be stopped")
 .requiredOption("--config <path>", "reviewed private executor JSON configuration")
 .requiredOption("--executor-stopped", "operator confirms the former executor is stopped")
 .action(async (options: { config: string }) => {
  try {
   const config = JSON.parse(await readFile(await privateOperatorPath(options.config, true), "utf8"));
   await reconcileRemoteTests(config);
   process.stdout.write("Remote-test recovery complete; interrupted jobs have at most one infrastructure retry.\n");
  } catch { process.stderr.write("Remote-test recovery failed; admission remains fenced. Inspect private executor state.\n"); process.exitCode = 1; }
 });

remoteTest.command("cancel")
 .description("Durably cancel an exact remote-test job generation")
 .requiredOption("--config <path>", "reviewed private executor JSON configuration")
 .requiredOption("--job <path>", "V1 job identity JSON")
 .action(async (options: { config: string; job: string }) => {
  try {
   const config = validateExecutorConfig(JSON.parse(await readFile(await privateOperatorPath(options.config, true), "utf8")));
   const job = JSON.parse(await readFile(options.job, "utf8"));
   const selected = config.profiles.find(p => p.profile.profileId === job?.profileId);
   if (!selected) throw Error("Unapproved cancellation profile");
   const validated = validateRemoteTestJob(job, selected.profile);
   const ledger = await openJobLedger(config.jobsRoot, config.executorId);
   try { ledger.cancel(validated); } finally { ledger.close(); }
   process.stdout.write("Remote-test generation cancellation recorded.\n");
  } catch { process.stderr.write("Remote-test cancellation failed; inspect private executor state.\n"); process.exitCode = 1; }
 });

remoteTest.command("shadow-summary")
 .description("Summarize up to ten private measured pilot jobs; missing/fixture metrics remain pending")
 .requiredOption("--input <path>", "private V1 pilot measurements JSON outside git")
 .requiredOption("--output <path>", "new private summary JSON outside git")
 .action(async (options: { input: string; output: string }) => {
  try {
   const input = await readPrivateJson(options.input);
   const report = summarizeShadow(input);
   await writeShadowReport(options.output, report);
   process.stdout.write(`Shadow pilot ${report.status}; ${report.jobCount}/10 jobs. Local gate remains authoritative. Private summary saved.\n`);
   process.exitCode = report.status === "failed" ? 1 : 0;
  } catch { process.stderr.write("Shadow summary failed; inspect private inputs/output.\n"); process.exitCode = 1; }
 });

remoteTest.command("baseline")
 .description("Inspect capacity; --run explicitly grants one bounded non-graphical workload")
 .requiredOption("--profile <path>", "reviewed operator-local baseline JSON configuration")
 .requiredOption("--output <path>", "new private JSON report outside git repositories")
 .option("--ssh <target>", "configured SSH alias or user@host; otherwise inspect this host")
 .option("--run", "explicitly grant the workload after successful capacity/health preflight", false)
 .action(async (options: { profile: string; output: string; ssh?: string; run: boolean }) => {
  try {
   const profilePath = await privateOperatorPath(options.profile, true);
   const config = validateBaselineConfig(JSON.parse(await readFile(profilePath, "utf8")));
   const adapter = options.ssh ? sshCommandAdapter(options.ssh) : localCommandAdapter();
   // Reserve an owner-only, exclusive destination before ANY probe or workload.
   const outcome: { exitCode: 0 | 1 } = { exitCode: 1 };
   await writePrivateBaselineReport(options.output, async () => {
    const result = await runBaseline(config, { run: options.run, metrics: createCommandMetrics(adapter), transport: options.ssh ? { kind: "ssh", target: options.ssh } : { kind: "local" } });
    outcome.exitCode = result.exitCode;
    return result.report;
   });
   process.stdout.write(`Baseline report saved (${options.run ? "run" : "capacity"}; ${outcome.exitCode === 0 ? "complete" : "required measurements failed"}).\n`);
   process.exitCode = outcome.exitCode;
  } catch (error) {
   process.stderr.write(`ranger remote-test baseline: ${error instanceof Error ? error.message : String(error)}\n`);
   process.exitCode = 1;
  }
 });

program
 .command("scout")
 .description(
  "Read-only frontier/audit/HITL digest across registered maps (zero graph writes)",
 )
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .option("-j, --json", "emit machine-readable JSON")
 .action(async (options: { config: string; json: boolean }) => {
  try {
   const report = await runScout({
    config: options.config,
    json: options.json,
   });
   process.stdout.write(
    options.json ? renderJson(report) + "\n" : renderText(report) + "\n",
   );
   const failed = report.maps.some((m) => !m.ok);
   process.exit(failed ? 2 : 0);
  } catch (error) {
   process.stderr.write(
    `ranger scout: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("walk")
 .description(
  "Headless tick: claim decided research + implement frontier nodes (announce-fail-closed, race-safe), spawn detached run-node workers, then sweep (crash recovery + the merge desk)",
 )
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (options: { config: string }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   process.stdout.write((await runWalk(configPath)) + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger walk: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("tick")
 .description(
  "One bounded autonomous pass (design §1): escalation cards (design §5) then the walk claim phase — so HITL/provisioning cards are posted/edited on the schedule, not just by the daily digest. The launchd tick runs this.",
 )
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (options: { config: string }) => {
  const configPath = resolve(process.cwd(), options.config);
  let config: RangerConfig;
  let journal: Journal;
  try {
   ({ config, journal } = loadCtx(configPath));
  } catch (error) {
   process.stderr.write(
    `ranger tick: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
  // Escalation must NOT prevent walking: a lock-contention timeout (an
  // overlapping digest/cards run holds the desk) or any other escalate
  // failure is REPORTED in the output, but walk still runs — scheduled
  // claims are independent of the desk (round-34 review).
  let escalateResult: EscalateResult | null = null;
  let escalateError: string | undefined;
  try {
   escalateResult = await escalateMaps(config, journal);
  } catch (error) {
   escalateError = error instanceof Error ? error.message : String(error);
  }
  try {
   // walk re-fetches its OWN frontier: claims must classify from a fresh
   // read — a ~120s-old escalation-pass frontier could misroute a node
   // edited to HITL in that window (round-29 review).
   const walkResult = await walk({ config, configPath, journal });
   journal.close();
   process.stdout.write(
    JSON.stringify(
     {
      generatedAt: new Date().toISOString(),
      escalate: escalateResult ?? { error: escalateError, maps: [] },
      walk: walkResult,
     },
     null,
     2,
    ) + "\n",
   );
   const failed =
    escalateError !== undefined ||
    (escalateResult?.maps.some((m) => !m.ok) ?? false) ||
    walkResult.maps.some((m) => m.errors.length > 0);
   process.exit(failed ? 2 : 0);
  } catch (error) {
   journal.close();
   process.stderr.write(
    `ranger tick: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("run-node")
 .description(
  "Detached worker supervisor: worktree, worker session, then the kind SOP — research (findings → gated close) or implement (tests → PR → sage → merge card → gated close after the principal's merge)",
 )
 .argument("<id>", "node id to execute")
 .option("-m, --map <owner/name#root>", "map repo#root (repo alone only when unique)")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (id: string, options: { map?: string; config: string }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   // The worker, sage rounds and probe tier must not run on a sleeping host.
   holdAwake();
   process.stdout.write((await runRunNode(id, options.map, configPath)) + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger run-node: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(error instanceof WriteGateError ? 2 : 1);
  }
 });

program
 .command("sweep")
 .description(
  "Reconcile the journal against reality (crashed workers, stale claims)",
 )
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (options: { config: string }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   process.stdout.write((await runSweep(configPath)) + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger sweep: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("merge-gate")
 .description(
  "Operator verb: the merge desk's gate (CI, mergeable, base, sage review and probes at the live head) for one node's PR; exit 0 only when it passes at --sha, 2 otherwise. Reads only",
 )
 .argument("<id>", "node id")
 .requiredOption("-m, --map <owner/name#root>", "map repo#root (repo alone only when unique)")
 .requiredOption("--sha <sha>", "the head the merge is pinned to")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (id: string, options: { map: string; sha: string; config: string }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   const result = await runMergeGate(id, options.map, options.sha, configPath);
   if (!result.ok) {
    process.stderr.write(result.text + "\n");
    process.exit(2);
   }
   process.stdout.write(result.text + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger merge-gate: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("merge-desk")
 .description(
  "Operator verb: run one map's merge desk now, as the tick's desk phase does — a merged PR's node starts its close, a passing PR gets its merge card",
 )
 .requiredOption("-m, --map <owner/name#root>", "map repo#root (repo alone only when unique)")
 .option("--settle", "first wait (up to 90 s) until GitHub has computed mergeability for every awaiting-merge PR on the map, as after a merge moved the base")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (options: { map: string; config: string; settle?: boolean }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   process.stdout.write((await runMergeDeskNow(options.map, configPath, options.settle === true)) + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger merge-desk: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("resume-node")
 .description(
  "Operator verb: put a parked/failed node back in motion — the row returns to claimed and a detached run-node resumes it (the implement lane resumes from its PR)",
 )
 .argument("<id>", "node id to resume")
 .option("-m, --map <owner/name#root>", "map repo or repo#root (optional; inferred from the journal row)")
 .option("--force", "resume even while another implement worker holds the lane")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (id: string, options: { map?: string; config: string; force?: boolean }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   process.stdout.write((await runResumeNode(id, options.map, configPath, options.force)) + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger resume-node: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("build-now")
 .description(
  "Operator verb (node #58): claim one walkable frontier node under the bot identity and start its run-node now — the walk's own claim for one node; refuses HITL, off-frontier, skip-listed, vetoed or in-flight nodes, a spent spawn cap, a paused run, and a held implement lane unless --force",
 )
 .argument("<id>", "node id to build")
 .requiredOption("-m, --map <owner/name#root>", "map repo#root (repo alone only when unique)")
 .option("--force", "start beside whatever holds the implement lane")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (id: string, options: { map: string; config: string; force?: boolean }) => {
  try {
   if (!/^\d+$/.test(id)) throw new Error(`node id must be numeric, got ${id}`);
   const configPath = resolve(process.cwd(), options.config);
   const { result, out } = await runBuildNow(id, options.map, configPath, options.force);
   process.stdout.write(out + "\n");
   // Claimed but nothing spawned (RANGER_NO_SPAWN, or a failed spawn): the
   // row holds the node with no worker, so this is not a start.
   if (result.pid === null) {
    process.stderr.write(
     `ranger build-now: claimed #${id} but no run-node was started — \`ranger run-node ${id} --map ${mapKey(result)}\` starts it\n`,
    );
    process.exitCode = BUILD_NOW_NOT_STARTED;
   }
  } catch (error) {
   process.stderr.write(
    `ranger build-now: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(error instanceof WriteGateError ? 2 : 1);
  }
 });

program
 .command("resume-run")
 .description("Operator verb: clear the dead-man pause (claiming resumes on the next tick)")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action((options: { config: string }) => {
  const configPath = resolve(process.cwd(), options.config);
  process.stdout.write(runResumeRun(configPath) + "\n");
 });

program
 .command("trust-git")
 .description(
  "Operator verb (node #81): list every change to the canonical checkout's git config and hooks since ranger last saw them clean, with the current state's hash; --hash <it> records exactly that state as known-good (run-nodes park on any change)",
 )
 .requiredOption("-m, --map <owner/name#root>", "map repo#root (repo alone only when unique)")
 .option("--hash <sha256>", "adopt the state only while it still hashes to this (from the listing)")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (options: { map: string; config: string; hash?: string }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   process.stdout.write((await runTrustGit(options.map, configPath, options.hash)) + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger trust-git: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("journal")
 .description("Inspect the journal (workers, events, health)")
 .option("--repo <repo>", "filter by map repo")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (options: { repo?: string; config: string }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   process.stdout.write((await runJournal(options.repo, configPath)) + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger journal: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("escalate")
 .description(
  "Escalation desk (design §5): post/edit HITL + provisioning cards in each map's Discord thread (announce-once, edit-not-repost, age-banded); --digest emits the daily aged-cards + audit + budget digest. Graph-read-only.",
 )
 .option("--digest", "emit the daily digest instead of the cards pass")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .option("-j, --json", "emit machine-readable JSON")
 .action(
  async (options: { digest: boolean; config: string; json: boolean }) => {
   try {
    const configPath = resolve(process.cwd(), options.config);
    const { config } = loadConfig(configPath);
    const journal = openJournal(config);
    // Test seam: RANGER_NOW injects the clock (age-banding tests).
    const now = process.env.RANGER_NOW
     ? new Date(process.env.RANGER_NOW)
     : undefined;
    const result = options.digest
     ? await runDigest(config, journal, now === undefined ? {} : { now })
     : await escalateMaps(config, journal, now === undefined ? {} : { now });
    journal.close();
    process.stdout.write(
     options.json
      ? JSON.stringify(result, null, 2) + "\n"
      : renderEscalateText(result) + "\n",
    );
    const failed = result.maps.some((m) => !m.ok);
    process.exit(failed ? 2 : 0);
   } catch (error) {
    process.stderr.write(
     `ranger escalate: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
   }
  },
 );

program
 .command("serve")
 .description(
  "Local read-only dashboard (#37): the current job, the next in queue, autonomous nodes, and open grillings with a button that opens an interactive session",
 )
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .option("-p, --port <port>", "port on 127.0.0.1 (default: serve.port, 7311)")
 .option("--open", "open the dashboard in the browser")
 .action((options: { config: string; port?: string; open?: boolean }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   const { config } = loadConfig(configPath);
   const port = options.port === undefined ? undefined : Number(options.port);
   if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1024 || port > 65535)
   ) {
    throw new Error(`--port must be an integer from 1024 to 65535, got ${options.port}`);
   }
   const { url } = startServe({ config, configPath, port, open: options.open });
   process.stdout.write(`ranger serve: ${url} (Ctrl-C stops it)\n`);
  } catch (error) {
   process.stderr.write(
    `ranger serve: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program.parseAsync(process.argv).catch((error) => {
 process.stderr.write(
  `ranger: ${error instanceof Error ? error.message : String(error)}\n`,
 );
 process.exit(1);
});
