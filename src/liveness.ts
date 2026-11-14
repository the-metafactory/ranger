import { pidAlive as hostPidAlive } from "./exec.ts";
import type { WorkerRow } from "./journal.ts";

export const RESERVATION_GRACE_MS = 120_000;

type PidProbe = (pid: number | null) => boolean;
type LivenessRow = Pick<WorkerRow, "status" | "pid" | "startedAt">;

/** The row says a supervisor owns the node. Says nothing about whether that process still lives. */
export function isActiveStatus(status: string): status is "claimed" | "running" {
 return status === "claimed" || status === "running";
}

/** A claim reserved its row but has not recorded a PID yet, and is still inside the grace window. */
export function reservationPending(row: LivenessRow, now = new Date()): boolean {
 return row.status === "claimed" && row.pid === null && row.startedAt !== null &&
  now.getTime() - Date.parse(row.startedAt) < RESERVATION_GRACE_MS;
}

/** An active row whose process is alive, or whose reservation is still pending. */
export function hasLiveOwner(row: LivenessRow, now = new Date(), pidAlive: PidProbe = hostPidAlive): boolean {
 return isActiveStatus(row.status) && (pidAlive(row.pid) || reservationPending(row, now));
}

/** An active row with a recorded PID that is dead: a crashed supervisor the sweep must reap. */
export function isStaleOwner(row: LivenessRow, pidAlive: PidProbe = hostPidAlive): boolean {
 return isActiveStatus(row.status) && row.pid !== null && !pidAlive(row.pid);
}
