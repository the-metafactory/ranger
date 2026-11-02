import { isNodeId } from "./approval-spec.ts";
import { ClaimLeaseLost, ClaimLockBusy, withClaimLock } from "./claim-lock.ts";
import type { RangerConfig } from "./config.ts";
import {
 inspectProcess,
 processGroupCommands,
 signalProcess,
 signalProcessGroup,
 type ProcessInspection,
} from "./exec.ts";
import type { Journal, WorkerRow } from "./journal.ts";
import { mapKey, pickMap } from "./maps.ts";

export type StopState =
 | "stopped"
 | "already-stopped"
 | "stopping"
 | "unknown"
 | "superseded"
 | "not-active"
 | "refused";

export type ProcessStop = "none" | "gone" | "terminated" | "killed" | "foreign" | "alive" | "unverified";

export interface StopResult {
 ok: boolean;
 state: StopState;
 reason: string;
 nodeId: string;
 map: string | null;
 generation: number;
 recordedGeneration: number | null;
 status: string | null;
 supervisor: ProcessStop;
 workerGroup: ProcessStop;
}

export interface StopPorts {
 inspect(pid: number): Promise<ProcessInspection>;
 groupCommands(pgid: number): Promise<string[]>;
 signal(pid: number, signal: NodeJS.Signals): boolean;
 signalGroup(pgid: number, signal: NodeJS.Signals): boolean;
 sleep(ms: number): Promise<void>;
}

export const realStopPorts: StopPorts = {
 inspect: inspectProcess,
 groupCommands: processGroupCommands,
 signal: signalProcess,
 signalGroup: signalProcessGroup,
 sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface StopContext {
 config: RangerConfig;
 journal: Journal;
 ports?: StopPorts;
 now?: () => Date;
 graceMs?: number;
 killGraceMs?: number;
 pollMs?: number;
 lockTimeoutMs?: number;
}

export interface StopRequest {
 nodeId: string;
 map: string | undefined;
 generation: number;
}

export const STOP_GRACE_MS = 15_000;
export const STOP_KILL_GRACE_MS = 5_000;
const STOP_POLL_MS = 100;
const STOP_LOCK_TIMEOUT_MS = 30_000;

type Standing = "gone" | "foreign" | "verified" | "unknown";

interface Target {
 signal(signal: NodeJS.Signals): void;
 standing(): Promise<Standing>;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function isRunNodeCommand(command: string, nodeId: string, key: string): boolean {
 return new RegExp(`(^|\\s)run-node ${escapeRegExp(nodeId)} --map ${escapeRegExp(key)}(\\s|$)`).test(command);
}

function supervisorTarget(row: WorkerRow, key: string, ports: StopPorts): Target {
 const pid = row.pid;
 return {
  signal: (signal) => { if (pid !== null) ports.signal(pid, signal); },
  standing: async () => {
   if (pid === null) return "gone";
   const seen = await ports.inspect(pid);
   if (seen.kind === "gone") return "gone";
   if (seen.kind === "unknown") return "unknown";
   return isRunNodeCommand(seen.command, row.nodeId, key) ? "verified" : "foreign";
  },
 };
}

function workerGroupTarget(row: WorkerRow, ports: StopPorts): Target {
 const pgid = row.workerPgid;
 const worktree = row.worktree;
 return {
  signal: (signal) => { if (pgid !== null) ports.signalGroup(pgid, signal); },
  standing: async () => {
   if (pgid === null) return "gone";
   const commands = await ports.groupCommands(pgid);
   if (commands.length === 0) return "gone";
   if (worktree === null) return "unknown";
   return commands.some((command) => command.includes(worktree)) ? "verified" : "foreign";
  },
 };
}

async function terminate(
 targets: { supervisor: Target; workerGroup: Target },
 ports: StopPorts,
 timing: { graceMs: number; killGraceMs: number; pollMs: number },
): Promise<{ supervisor: ProcessStop; workerGroup: ProcessStop }> {
 const entries = Object.entries(targets) as [keyof typeof targets, Target][];
 const outcome: Record<keyof typeof targets, ProcessStop> = { supervisor: "none", workerGroup: "none" };
 const live = new Map<keyof typeof targets, Target>();
 const classify = (name: keyof typeof targets, standing: Standing, settled: ProcessStop) => {
  if (standing === "gone") { outcome[name] = settled; live.delete(name); }
  else if (standing === "foreign") { outcome[name] = "foreign"; live.delete(name); }
  else if (standing === "unknown") { outcome[name] = "unverified"; live.delete(name); }
  else { outcome[name] = "alive"; live.set(name, targets[name]); }
 };
 for (const [name, target] of entries) classify(name, await target.standing(), "gone");
 const settleWithin = async (ms: number, settled: ProcessStop) => {
  const deadline = Date.now() + ms;
  while (live.size > 0) {
   await ports.sleep(timing.pollMs);
   for (const [name, target] of [...live]) classify(name, await target.standing(), settled);
   if (live.size > 0 && Date.now() >= deadline) return;
  }
 };
 if (live.size === 0) return outcome;
 targets.supervisor.signal("SIGTERM");
 targets.workerGroup.signal("SIGTERM");
 await settleWithin(timing.graceMs, "terminated");
 if (live.size === 0) return outcome;
 for (const [name, target] of live) {
  if ((await target.standing()) === "verified") target.signal("SIGKILL");
  else classify(name, await target.standing(), "terminated");
 }
 await settleWithin(timing.killGraceMs, "killed");
 return outcome;
}

function verdict(processes: { supervisor: ProcessStop; workerGroup: ProcessStop }): { state: StopState; reason: string } {
 const seen = [processes.supervisor, processes.workerGroup];
 if (seen.includes("alive")) {
  return { state: "stopping", reason: "the stop is recorded, but a recorded process is still alive after the bounded wait" };
 }
 if (seen.includes("unverified")) {
  return { state: "unknown", reason: "the stop is recorded, but a recorded process could not be identified, so it was not signalled" };
 }
 return { state: "stopped", reason: "the stop is recorded and every recorded process is gone" };
}

export async function stopNode(ctx: StopContext, request: StopRequest): Promise<StopResult> {
 const { config, journal } = ctx;
 const ports = ctx.ports ?? realStopPorts;
 const timing = { graceMs: ctx.graceMs ?? STOP_GRACE_MS, killGraceMs: ctx.killGraceMs ?? STOP_KILL_GRACE_MS, pollMs: ctx.pollMs ?? STOP_POLL_MS };
 const base = {
  nodeId: request.nodeId, map: null as string | null, generation: request.generation,
  recordedGeneration: null as number | null, status: null as string | null,
  supervisor: "none" as ProcessStop, workerGroup: "none" as ProcessStop,
 };
 const answer = (state: StopState, reason: string, extra: Partial<StopResult> = {}): StopResult =>
  ({ ...base, ok: state === "stopped" || state === "already-stopped", state, reason, ...extra });

 if (!isNodeId(request.nodeId)) return answer("refused", "node id must be numeric");
 if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
  return answer("refused", "generation must be a positive integer");
 }
 if (request.map === undefined) return answer("refused", "--map owner/name#root is required");
 let map;
 try {
  map = pickMap(config, request.map);
 } catch (error) {
  return answer("refused", error instanceof Error ? error.message : String(error));
 }
 const key = mapKey(map);
 base.map = key;

 try {
  return await withClaimLock(journal, async (owned) => {
   const row = journal.getWorker(request.nodeId, map.repo);
   if (row === null) return answer("refused", `no journal row for node ${request.nodeId} on ${key}`);
   const seen = { recordedGeneration: row.generation, status: row.status };
   if (row.root !== map.root) {
    return answer("refused", `node ${request.nodeId} belongs to map ${row.repo}#${row.root}, not ${key}`, seen);
   }
   if (row.generation > request.generation) {
    return answer("superseded", `generation ${request.generation} was superseded by generation ${row.generation}; nothing was signalled`, seen);
   }
   if (row.generation < request.generation) {
    return answer("refused", `generation ${request.generation} is not a generation this journal has recorded for node ${request.nodeId}`, seen);
   }

   const replay = row.status === "stop-requested";
   if (!replay) {
    if (row.status !== "claimed" && row.status !== "running") {
     return answer("not-active", `the worker row is ${row.status}; there is no active worker to stop`, seen);
    }
    if (row.phase === "close") {
     return answer("refused", "the merge is accepted and the close is running; a stop does not undo it", seen);
    }
    owned();
    const outcome = `stop requested by operator for generation ${row.generation}`;
    if (!journal.requestStop(request.nodeId, map.repo, request.generation, outcome, ctx.now?.() ?? new Date())) {
     const now = journal.getWorker(request.nodeId, map.repo);
     return answer("not-active", `the worker row moved to ${now?.status ?? "removed"} before the stop was recorded`, {
      recordedGeneration: now?.generation ?? null, status: now?.status ?? null,
     });
    }
    const queued = journal.getResume(map.repo, request.nodeId);
    if (queued !== null) journal.removeResume(queued, "resume-cancelled", "stop-node cancelled the queued resume");
   }

   const settled = replay && row.pid === null && row.workerPgid === null;
   const processes = await terminate(
    { supervisor: supervisorTarget(row, key, ports), workerGroup: workerGroupTarget(row, ports) },
    ports,
    timing,
   );
   const outcome = verdict(processes);
   const final = { ...seen, status: "stop-requested", ...processes };
   if (outcome.state !== "stopped") return answer(outcome.state, outcome.reason, final);
   owned();
   journal.settleStop(request.nodeId, map.repo, request.generation,
    `supervisor ${processes.supervisor}, worker group ${processes.workerGroup}`);
   return answer(settled ? "already-stopped" : "stopped", settled ? "the stop was already recorded and settled" : outcome.reason, final);
  }, ctx.lockTimeoutMs ?? STOP_LOCK_TIMEOUT_MS);
 } catch (error) {
  if (error instanceof ClaimLockBusy || error instanceof ClaimLeaseLost) {
   return answer("unknown", `${error.message}; replay the stop to verify what was applied`);
  }
  throw error;
 }
}
