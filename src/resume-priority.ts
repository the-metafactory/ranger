import type { ResumeQueueRow } from "./journal.ts";

export function conflictResume(entry: Pick<ResumeQueueRow, "reason">): boolean {
 return entry.reason === "merge-conflict" || entry.reason === "merge-conflict-resume" || entry.reason === "merge-conflict-host-load";
}

export function promotedConflictReason(entry: Pick<ResumeQueueRow, "reason">): "merge-conflict-resume" | "merge-conflict-host-load" {
 return entry.reason === "host-load" ? "merge-conflict-host-load" : "merge-conflict-resume";
}
