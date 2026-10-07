import { join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { withClaimLock } from "./claim-lock.ts";
import { executionRefusal } from "./forge-ref.ts";
import { assertNotPrincipal, resolveBotIdentity, resolveWriteToken, WriteGateError } from "./identity.ts";
import type { Journal, ResumeQueueRow, WorkerStatus } from "./journal.ts";
import { implementLane, startsImplementSession } from "./lanes.ts";
import type { OwnedCheck } from "./lock.ts";
import { laneHeldMessage, mapKey, pickMap, recordImplementStart, resumeMap } from "./maps.ts";
import { spawnRunNodeDetached, type SpawnRunNodeArgs } from "./spawn.ts";

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

const releasedError = (nodeId: string) => new Error(`node ${nodeId}'s claim was released — the walk re-claims it from the frontier`);
const missingRowError = (nodeId: string, repo: string) => new Error(`no journal row for node ${nodeId} on ${repo} — nothing to resume`);

export const queuedResumeStale = (status: WorkerStatus) => status === "released" || status === "claimed" || status === "running";
export const spawnHeld = (journal: Journal, config: RangerConfig, now: Date) =>
 journal.isPaused() || journal.spawnsToday(now) >= config.workers.spawnCapPerDay;

/** Caller holds the claim lock. CLI and queued resumes use this same startup path. */
export async function startResumeNode(
 nodeId: string, map: RangerMapConfig, ctx: ResumeContext, owned: OwnedCheck,
 options: { force?: boolean; queued?: ResumeQueueRow; whenFree?: boolean } = {},
) {
 const { journal } = ctx;
 await identityGate(ctx.config, map);
 const row = journal.getWorker(nodeId, map.repo);
 if (row === null) throw missingRowError(nodeId, map.repo);
 journal.assertWorkerRoot(nodeId, map.repo, map.root);
 const result = { nodeId, repo: map.repo, root: map.root, was: row.status, pid: null as number | null };
 if (options.queued !== undefined && queuedResumeStale(row.status)) {
  owned();
  journal.removeResume(options.queued, "resume-dropped", `worker row is ${row.status}`);
  return { ...result, dropped: true };
 }
 if (row.status === "released") throw releasedError(nodeId);
 const lane = implementLane(map);
 const takesLane = startsImplementSession(row);
 const holder = takesLane ? journal.laneHolder(lane, { nodeId, repo: map.repo }) : null;
 const now = ctx.now?.() ?? new Date();
 if (options.queued !== undefined && (spawnHeld(journal, ctx.config, now) || holder !== null)) {
  return { ...result, queued: true };
 }
 if (holder !== null && options.force !== true) throw new Error(laneHeldMessage(lane, holder, "resume", nodeId));
 owned();
 journal.updateWorker(nodeId, map.repo, { status: "claimed", pid: null, workerPgid: null, finishedAt: null });
 const restore = () => journal.updateWorker(nodeId, map.repo, {
  status: row.status, pid: row.pid, workerPgid: row.workerPgid, finishedAt: row.finishedAt,
 });
 let pid: number | null;
 const spawner = ctx.spawnRunNode ?? spawnRunNodeDetached;
 const handDriven = spawner === spawnRunNodeDetached && process.env.RANGER_NO_SPAWN === "1";
 try {
  pid = await spawner({ nodeId, repo: map.repo, root: map.root,
   cliEntry: join(import.meta.dir, "cli.ts"), configPath: ctx.configPath });
 } catch (error) {
  owned();
  restore();
  throw error;
 }
 owned();
 if ((options.queued !== undefined || options.whenFree) && pid === null && !handDriven) {
  restore();
  throw new Error("run-node spawn returned no PID");
 }
 if (pid !== null) journal.updateWorker(nodeId, map.repo, { pid });
 if (takesLane) recordImplementStart(journal, map);
 if (options.queued !== undefined || options.whenFree) journal.recordSpawn(now);
 const entry = options.queued ?? journal.getResume(map.repo, nodeId);
 if (entry !== null) journal.removeResume(entry, "resume-started", `resume-node started; run-node pid ${pid ?? "none"}`);
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
  const row = journal.getWorker(nodeId, map.repo);
  if (row === null) throw missingRowError(nodeId, map.repo);
  if (row.status === "released") throw releasedError(nodeId);
  const lane = implementLane(map);
  const now = ctx.now?.() ?? new Date();
  if (options.whenFree && startsImplementSession(row) && (
   journal.laneHolder(lane, { nodeId, repo: map.repo }) !== null ||
   journal.listResumeQueue(lane).some(entry => entry.repo !== map.repo || entry.nodeId !== nodeId) ||
   spawnHeld(journal, config, now)
  )) {
   await identityGate(config, map);
   owned();
   const entry = journal.enqueueResume({ nodeId, repo: map.repo, root: map.root, lane }, now);
   return { nodeId, repo: map.repo, root: map.root, queued: true, lane: entry.lane, queuedAt: entry.queuedAt };
  }
  return startResumeNode(nodeId, map, ctx, owned, { force: options.force, whenFree: options.whenFree });
 });
}
