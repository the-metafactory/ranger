import type { Journal, WorkerPatch, WorkerRow } from "./journal.ts";

export const RESERVATION_GRACE_MS = 120_000;

export function reservationPending(row: WorkerRow, now = new Date()): boolean {
 return row.status === "claimed" && row.pid === null && row.startedAt !== null &&
  now.getTime() - Date.parse(row.startedAt) < RESERVATION_GRACE_MS;
}

export async function startOwnedWorker(args: {
 journal: Journal;
 row: WorkerRow;
 patch?: WorkerPatch;
 generation?: number;
 status?: "claimed" | "running";
 onSpawnFailure?: () => void;
 spawn: (generation: number) => Promise<number | null>;
 now?: Date;
}): Promise<number | null> {
 const { journal, row } = args;
 const generation = args.generation ?? journal.reserveWorker(row, args.patch, args.now);
 if (generation === null) return null;
 let pid: number | null = null;
 let failure = "spawn returned no PID";
 try {
  pid = await args.spawn(generation);
 } catch (error) {
  failure = String(error);
 }
 if (pid === null) {
  const detail = `worker start failed (${failure}); resume node ${row.nodeId} to retry`;
  const resolved = journal.updateReservation(row.nodeId, row.repo, generation, {
   status: row.status === "claimed" || row.status === "running" ? "parked" : row.status,
   phase: row.phase, pid: null, workerPgid: null, attempts: row.attempts,
   startedAt: row.startedAt, finishedAt: row.finishedAt ?? new Date().toISOString(),
   outcome: [row.outcome, detail].filter(Boolean).join("\n"),
  });
  if (resolved) args.onSpawnFailure?.();
  journal.recordEvent("sweep", { nodeId: row.nodeId, repo: row.repo, detail });
  return null;
 }
 journal.updateReservation(row.nodeId, row.repo, generation, { pid, status: args.status ?? "claimed" });
 return pid;
}
