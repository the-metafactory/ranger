import type { RangerMapConfig } from "./config.ts";
import type { ResumeQueueRow, WorkerRow, WorkerStatus } from "./journal.ts";
import { startsImplementSession, type ImplementLane } from "./lanes.ts";
import { isQuiet, type HostLoadReading } from "./host-load.ts";
import { waitingForQuietHost } from "./outcomes.ts";


/**
 * Why a queued entry waits for the host, or null when it need not: every
 * queued resume, ranger's own (node #297) and an operator's `--when-free`
 * alike, waits while the 1-minute load is at or above its lane's busy load
 * (`busyLoadFor`, node #312; else the core count). A start on a busy host is what timed soma #802 and
 * #853 out (2026-10-14). `ranger serve` shows the same reason.
 */
export function quietHostGate(host: HostLoadReading | undefined, busyLoad?: number): string | null {
 if (host === undefined || isQuiet(host, busyLoad)) return null;
 return waitingForQuietHost(host, busyLoad);
}


export const queuedResumeStale = (status: WorkerStatus) => status === "released" || status === "claimed" || status === "running";


/**
 * Pass 1c's spawn gates for a queue head, in the walk's order: the dead-man
 * pause, a holder of the entry's lane, the spent daily spawn cap. Why the
 * head waits, or null when it may start. `ranger serve` reads its "next"
 * head through this same gate (node #166).
 */
export function queueSpawnGate(g: {
 paused: boolean;
 lane: ImplementLane;
 holder: { nodeId: string; repo: string } | null;
 spawns: number;
 cap: number;
}): string | null {
 if (g.paused) return "dead-man paused: queued resumes wait for `ranger resume-run`";
 if (g.holder !== null) return `waits for the ${g.lane} lane, held by #${g.holder.nodeId} (${g.holder.repo})`;
 if (g.spawns >= g.cap) return `waits: the daily spawn cap (${g.cap}) is spent`;
 return null;
}


/**
 * Whether `resume-node --when-free` queues the row rather than starting it:
 * an implement session, and its lane held, the node already queued, or a
 * queue already waiting in that lane. `ranger serve` offers its "Queue
 * resume" by this same rule (node #166).
 */
export const whenFreeQueues = (row: Pick<WorkerRow, "lane" | "phase">,
 lane: { held: boolean; queued: boolean; backlog: number; busy?: boolean }) =>
 startsImplementSession(row) && (lane.held || lane.queued || lane.backlog > 0 || lane.busy === true);


/**
 * The resume queue's journal-only gate for one entry, ahead of the spawn
 * gates and any forge read: what Pass 1c does with it, and what `ranger
 * serve` shows (node #166). `drop` leaves the queue and holds nothing;
 * `defer` stays and holds its lane's queue behind it; `behind` waits for an
 * earlier entry or a claim already holding the lane this tick. Null passes
 * the entry on to the spawn gates (pause, spawn cap, lane holder).
 */
export type QueueEntryGate = { kind: "drop" | "defer"; reason: string } | { kind: "behind" } | null;

export function queueEntryGate(
 entry: Pick<ResumeQueueRow, "root" | "lane">,
 map: { walk: RangerMapConfig["walk"]; lane: ImplementLane } | undefined,
 row: Pick<WorkerRow, "status" | "root"> | null,
 laneWaiting: boolean,
): QueueEntryGate {
 if (map?.walk === "none") return { kind: "drop", reason: "map is walk: none" };
 if (laneWaiting) return { kind: "behind" };
 if (row !== null && queuedResumeStale(row.status)) return { kind: "drop", reason: `worker row is ${row.status}` };
 if (map === undefined) return { kind: "defer", reason: "map is no longer registered" };
 if (row === null) return { kind: "defer", reason: "worker row is missing" };
 if (row.root !== entry.root) return { kind: "defer", reason: "worker map root changed" };
 if (entry.lane !== map.lane) return { kind: "defer", reason: `map implement lane changed from ${entry.lane} to ${map.lane}` };
 return null;
}
