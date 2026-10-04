/** Awaiting-merge releases capacity while the principal decides. */
export function holdsImplementLane(row: { lane: string | null; status: string }): boolean {
 return row.lane === "implement" && (row.status === "claimed" || row.status === "running");
}
