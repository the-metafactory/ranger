export const CONFLICT_RESUME_REASONS = ["merge-conflict", "merge-conflict-resume", "merge-conflict-host-load"] as const;

export const RESUME_REASONS = ["host-load", ...CONFLICT_RESUME_REASONS] as const;

export type ConflictResumeReason = (typeof CONFLICT_RESUME_REASONS)[number];

export type ResumeReason = (typeof RESUME_REASONS)[number];

export function conflictResume(entry: { reason?: ResumeReason | null }): boolean {
 return CONFLICT_RESUME_REASONS.some((reason) => reason === entry.reason);
}

export function promotedConflictReason(entry: { reason?: ResumeReason | null }): ConflictResumeReason {
 return entry.reason === "host-load" ? "merge-conflict-host-load" : "merge-conflict-resume";
}
