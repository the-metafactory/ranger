import type { ResumeQueueRow } from "./journal.ts";

export function conflictResume(entry: Pick<ResumeQueueRow, "reason">): boolean {
 return entry.reason === "merge-conflict" || entry.reason === "merge-conflict-resume";
}
