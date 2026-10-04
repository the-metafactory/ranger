/**
 * When a head's check runs count as green — one policy for the merge gate
 * (`merge-gate.ts`) and the dashboard's "Needs you" CI state
 * (`serve-parked.ts`). Dependency-free, so serve can import it without
 * widening its import graph.
 *
 * Zero runs is not green (an empty rollup is the silent fail-open), every run
 * must be completed, neutral and skipped pass, and one run must have
 * concluded success: soma's auto close cites it (`--ci <id>@<sha>`).
 */

const OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export type CiVerdict<R> =
 | { state: "none" }
 | { state: "pending"; running: R[] }
 | { state: "failed"; failed: R[] }
 | { state: "no-success" }
 | { state: "green"; success: R };

export function classifyCi<R extends { status: string; conclusion: string | null }>(runs: R[]): CiVerdict<R> {
 if (runs.length === 0) return { state: "none" };
 const running = runs.filter((r) => r.status !== "completed");
 if (running.length > 0) return { state: "pending", running };
 const failed = runs.filter((r) => !OK_CONCLUSIONS.has(r.conclusion ?? ""));
 if (failed.length > 0) return { state: "failed", failed };
 const success = runs.find((r) => r.conclusion === "success");
 if (success === undefined) return { state: "no-success" };
 return { state: "green", success };
}
