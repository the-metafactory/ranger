import { pinNodeSubstrate } from "./node-dependency.ts";
import type { SubstrateName } from "./store/schema.ts";
import { OperationFailure } from "./operation-outcome.ts";
import { activeRecoveryReason, completeRecovery, nodeRecoveryScope, recordRecovery, recoveryHold, recoveryReason, reserveRecovery } from "./recovery.ts";
import { pidAlive } from "./exec.ts";
import { FencedError, type Journal, type WorkerPatch, type WorkerRow } from "./journal.ts";

export const RESERVATION_GRACE_MS = 120_000;
const START_FAILURE = "[worker-start] ";
export const FRESH_START_FAILURE = `${START_FAILURE}fresh claim: `;

export function startFailureOutcome(previous: string | null, detail: string, fresh = false): string {
 const retained = (previous ?? "").split(START_FAILURE)[0].trimEnd();
 const latest = `${fresh ? FRESH_START_FAILURE : START_FAILURE}${detail.replace(/\s+/g, " ").slice(0, 400)}`;
 return [retained, latest].filter(Boolean).join("\n");
}

export function reservationPending(row: WorkerRow, now = new Date()): boolean {
 return row.status === "claimed" && row.pid === null && row.startedAt !== null &&
  now.getTime() - Date.parse(row.startedAt) < RESERVATION_GRACE_MS;
}

export function acquireGeneration(journal: Journal, nodeId: string, repo: string,
 reserved: number | undefined, begun?: (generation: number) => void): number {
 if (reserved !== undefined) {
  journal.adoptReservation(nodeId, repo, reserved, process.pid);
  begun?.(reserved);
  return reserved;
 }
 const row = journal.getWorker(nodeId, repo);
 if (row === null) throw new FencedError(`node ${nodeId} has no reservation row`);
 if (reservationPending(row) || ((row.status === "running" || row.status === "claimed") && pidAlive(row.pid))) {
  throw new FencedError(`node ${nodeId} already has a live owner or pending reservation`);
 }
 const generation = journal.reserveWorker(row);
 if (generation === null) throw new FencedError(`node ${nodeId} ownership changed before start`);
 begun?.(generation);
 journal.adoptReservation(nodeId, repo, generation, process.pid);
 return generation;
}

export async function startOwnedWorker(args: {
 journal: Journal;
 row: WorkerRow;
 patch?: WorkerPatch;
 generation?: number;
 status?: "claimed" | "running";
 freshClaim?: boolean;
 onSpawnFailure?: (error: Error) => void;
 preflight?: () => Promise<SubstrateName | undefined>;
 spawn: (generation: number) => Promise<number | null>;
 now?: Date;
}): Promise<number | null> {
 const { journal, row } = args;
 const scope = nodeRecoveryScope(row.repo, row.nodeId);
 const hold = recoveryHold(journal, scope, args.now);
 if (hold !== null) {
  if (args.generation !== undefined) journal.updateReservation(row.nodeId, row.repo, args.generation, { status: "parked", pid: null, outcome: hold });
  return null;
 }
 const generation = args.generation ?? journal.reserveWorker(row, { workerPgid: null, ...args.patch }, args.now);
 if (generation === null) return null;
 const owner = { nodeId: row.nodeId, repo: row.repo, generation };
 if (!reserveRecovery(journal, scope, { now: args.now, owner: owner })) {
  const detail = activeRecoveryReason(journal, scope);
  journal.updateReservation(row.nodeId, row.repo, generation, { status: "parked", outcome: detail });
  return null;
 }
 let pid: number | null = null;
 let failure = new Error("run-node spawn returned no PID");
 try {
  if (args.preflight !== undefined) {
   const selected = await args.preflight();
   if (selected !== undefined && !pinNodeSubstrate(journal, owner, selected)) return null;
   completeRecovery(journal, scope, { operation: "model-endpoint", owner: owner });
  }
  pid = await args.spawn(generation);
 } catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
 }
 if (journal.getWorker(row.nodeId, row.repo)?.generation !== generation) {
  journal.recordEvent("fenced", { nodeId: row.nodeId, repo: row.repo, detail: `start reservation ${generation} was superseded; late spawn result ignored` });
  return null;
 }
 if (pid === null) {
  const state = recordRecovery(journal, scope, failure instanceof OperationFailure ? failure.outcome : { kind: "infrastructure", operation: "worker-spawn", evidence: failure.message, action: `restore worker spawning and resume node ${row.nodeId}` }, { now: args.now, owner: owner });
  const detail = `worker start failed (${failure.message}); ${recoveryReason(state)}`;
  const resolved = journal.updateReservation(row.nodeId, row.repo, generation, {
   status: row.status === "claimed" || row.status === "running" ? "parked" : row.status,
   phase: row.phase, pid: null, workerPgid: null, attempts: row.attempts,
   startedAt: row.startedAt, finishedAt: row.finishedAt ?? new Date().toISOString(),
   outcome: startFailureOutcome(row.outcome, detail, args.freshClaim),
  });
  if (resolved) args.onSpawnFailure?.(failure);
  journal.recordEvent("sweep", { nodeId: row.nodeId, repo: row.repo, detail });
  return null;
 }
 journal.updateReservation(row.nodeId, row.repo, generation, { pid, status: args.status ?? "claimed" });
 completeRecovery(journal, scope, { operation: "worker-spawn", owner: owner });
 return pid;
}
