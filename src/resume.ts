import { join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { withClaimLock } from "./claim-lock.ts";
import { executionRefusal } from "./forge-ref.ts";
import { assertNotPrincipal, resolveBotIdentity, resolveWriteToken, WriteGateError } from "./identity.ts";
import type { Journal, ResumeQueueRow } from "./journal.ts";
import { implementLane, startsImplementSession } from "./lanes.ts";
import type { OwnedCheck } from "./lock.ts";
import { laneHeldMessage, mapKey, pickMap, recordImplementStart, resumeMap } from "./maps.ts";
import { spawnRunNodeDetached, type SpawnRunNodeArgs } from "./walk.ts";

export interface ResumeContext {
 config: RangerConfig;
 configPath: string;
 journal: Journal;
 spawnRunNode?: (args: SpawnRunNodeArgs) => Promise<number | null>;
 now?: () => Date;
}

async function identityGate(config: RangerConfig, map: RangerMapConfig): Promise<void> {
 const refusal = executionRefusal(map.repo);
 if (refusal !== null) throw new WriteGateError(refusal);
 const { token } = resolveWriteToken(config, map.repo);
 assertNotPrincipal(config, await resolveBotIdentity(config, token));
}

/** Caller holds the claim lock. CLI and queued resumes use this same startup path. */
export async function startResumeNode(
 nodeId: string, map: RangerMapConfig, ctx: ResumeContext, owned: OwnedCheck,
 options: { force?: boolean; queued?: ResumeQueueRow } = {},
) {
 const { journal } = ctx;
 await identityGate(ctx.config, map);
 const row = journal.getWorker(nodeId, map.repo);
 if (row === null) throw new Error(`no journal row for node ${nodeId} on ${map.repo} — nothing to resume`);
 journal.assertWorkerRoot(nodeId, map.repo, map.root);
 const result = { nodeId, repo: map.repo, root: map.root, was: row.status, pid: null as number | null };
 if (options.queued !== undefined && (row.status === "released" || row.status === "claimed" || row.status === "running")) {
  owned();
  journal.removeResume(options.queued, "resume-dropped", `worker row is ${row.status}`);
  return { ...result, dropped: true };
 }
 if (row.status === "released") throw new Error(`node ${nodeId}'s claim was released — the walk re-claims it from the frontier`);
 const lane = implementLane(map);
 const takesLane = startsImplementSession(row);
 const holder = takesLane ? journal.laneHolder(lane, { nodeId, repo: map.repo }) : null;
 const now = ctx.now?.() ?? new Date();
 if (options.queued !== undefined && (journal.isPaused() || journal.spawnsToday(now) >= ctx.config.workers.spawnCapPerDay || holder !== null)) {
  return { ...result, queued: true };
 }
 if (holder !== null && options.force !== true) throw new Error(laneHeldMessage(lane, holder, "resume", nodeId));
 owned();
 journal.updateWorker(nodeId, map.repo, { status: "claimed", pid: null, workerPgid: null, finishedAt: null });
 let pid: number | null;
 try {
  pid = await (ctx.spawnRunNode ?? spawnRunNodeDetached)({ nodeId, repo: map.repo, root: map.root,
   cliEntry: join(import.meta.dir, "cli.ts"), configPath: ctx.configPath });
 } catch (error) {
  owned();
  journal.updateWorker(nodeId, map.repo, { status: row.status, pid: row.pid, workerPgid: row.workerPgid, finishedAt: row.finishedAt });
  throw error;
 }
 owned();
 if (options.queued !== undefined && pid === null) {
  journal.updateWorker(nodeId, map.repo, { status: row.status, pid: row.pid, workerPgid: row.workerPgid, finishedAt: row.finishedAt });
  return { ...result, queued: true };
 }
 if (pid !== null) journal.updateWorker(nodeId, map.repo, { pid });
 if (takesLane) recordImplementStart(journal, map);
 // Queued starts share the walk's daily spend bound with new claims.
 if (options.queued !== undefined) journal.recordSpawn(now);
 const entry = options.queued ?? journal.listResumeQueue().find(e => e.repo === map.repo && e.nodeId === nodeId);
 if (entry !== undefined) journal.removeResume(entry, "resume-started", `resume-node started; run-node pid ${pid ?? "none"}`);
 journal.recordEvent("sweep", { nodeId, repo: map.repo, detail: `resume-node by ${options.queued === undefined ? "operator" : "queue"} (was ${row.status}); run-node pid ${pid ?? "none"}` });
 return { ...result, pid };
}

export async function resumeNode(nodeId: string, selector: string | undefined, ctx: ResumeContext,
 options: { force?: boolean; whenFree?: boolean; cancel?: boolean } = {}) {
 if ((options.cancel && (options.force || options.whenFree)) || (options.force && options.whenFree)) {
  throw new Error("--cancel, --when-free and --force are mutually exclusive");
 }
 return withClaimLock(ctx.journal, async owned => {
  const { journal, config } = ctx;
  if (options.cancel) {
   const entries = journal.listResumeQueue().filter(e => e.nodeId === nodeId &&
    (selector === undefined || selector === e.repo || selector === mapKey(e)));
   if (entries.length !== 1) throw new Error(`no unique queued resume for node ${nodeId}`);
   const entry = entries[0];
   await identityGate(config, pickMap(config, mapKey(entry)));
   owned();
   if (!journal.removeResume(entry, "resume-cancelled", "resume-node cancelled by operator")) throw new Error(`no queued resume for node ${nodeId}`);
   return { nodeId, repo: entry.repo, root: entry.root, cancelled: true };
  }
  const map = resumeMap(config, journal.listWorkers(), nodeId, selector);
  const row = journal.getWorker(nodeId, map.repo)!;
  if (row.status === "released") throw new Error(`node ${nodeId}'s claim was released — the walk re-claims it from the frontier`);
  const lane = implementLane(map);
  if (options.whenFree && startsImplementSession(row) && journal.laneHolder(lane, { nodeId, repo: map.repo }) !== null) {
   await identityGate(config, map);
   owned();
   const entry = journal.enqueueResume({ nodeId, repo: map.repo, root: map.root, lane }, ctx.now?.());
   return { nodeId, repo: map.repo, root: map.root, queued: true, lane, queuedAt: entry.queuedAt };
  }
  return startResumeNode(nodeId, map, ctx, owned, { force: options.force });
 });
}
