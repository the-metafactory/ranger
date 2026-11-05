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
 spawn: (generation: number) => Promise<number | null>;
 now?: Date;
}): Promise<number | null> {
 const { journal, row } = args;
 const generation = args.generation ?? journal.reserveWorker(row, { workerPgid: null, ...args.patch }, args.now);
 if (generation === null) return null;
 let pid: number | null = null;
 let failure = new Error("run-node spawn returned no PID");
 try {
  pid = await args.spawn(generation);
 } catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
 }
 if (pid === null) {
  const detail = `worker start failed (${failure.message}); resume node ${row.nodeId} to retry`;
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
 return pid;
}
