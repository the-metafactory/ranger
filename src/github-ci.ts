import type { CheckRun, WorkflowRun, CommitStatus } from "./github.ts";
import type { CiPurpose, CiVerdict } from "./forge.ts";
import { ciRunUrl } from "./forge-text.ts";

/**
 * The GitHub adapter's check-run classification. The merge gate receives
 * it through `githubCiVerdict` and the forge port; the dashboard's "Needs you"
 * CI state (`serve-parked.ts`) uses `classifyGithubCheckRuns` directly to retain
 * its finer-grained display states. Imports are type-only.
 *
 * Zero runs is not green (an empty rollup is the silent fail-open), every run
 * must be completed, neutral and skipped pass, and one run must have
 * concluded success: soma's auto close cites it (`--ci <id>@<sha>`).
 */

const OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export type CheckVerdict<R> =
 | { state: "none" }
 | { state: "pending"; running: R[] }
 | { state: "failed"; failed: R[] }
 | { state: "no-success" }
 | { state: "green"; success: R };

export function classifyGithubCheckRuns<R extends { status: string; conclusion: string | null }>(runs: R[]): CheckVerdict<R> {
 if (runs.length === 0) return { state: "none" };
 const running = runs.filter((r) => r.status !== "completed");
 if (running.length > 0) return { state: "pending", running };
 const failed = runs.filter((r) => !OK_CONCLUSIONS.has(r.conclusion ?? ""));
 if (failed.length > 0) return { state: "failed", failed };
 const success = runs.find((r) => r.conclusion === "success");
 if (success === undefined) return { state: "no-success" };
 return { state: "green", success };
}

type CiState = { kind: "failed"; message: string }
 | { kind: "pending"; reason: string }
 | { kind: "complete"; success: CheckRun; snapshot: string };

export function classifyResearchCi(runs: CheckRun[], workflows: WorkflowRun[], statuses: CommitStatus[]): CiState {
 const allRuns = [...runs, ...workflows];
 const failures = [
  ...allRuns.filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion ?? ""))
   .map((r) => `${r.name}=${r.conclusion}`),
  ...statuses.filter((s) => !["pending", "success"].includes(s.state)).map((s) => `${s.context}=${s.state}`),
 ];
 if (failures.length > 0) return { kind: "failed", message: failures.join(", ") };
 const running = allRuns.filter((r) => r.status !== "completed");
 const pendingStatuses = statuses.filter((s) => s.state === "pending");
 if (runs.length === 0 || running.length > 0 || pendingStatuses.length > 0) {
  return { kind: "pending", reason: runs.length === 0 ? "no check runs on the findings head"
   : `${running.length} check/workflow run(s) and ${pendingStatuses.length} commit status(es) still running` };
 }
 const success = runs.find((r) => r.status === "completed" && r.conclusion === "success" && Number.isSafeInteger(r.id) && r.id > 0);
 if (success === undefined) return { kind: "failed", message: "no successful check run to cite" };
 const snapshot = JSON.stringify([
  runs.map((r) => JSON.stringify(r)).sort(),
  workflows.map((r) => JSON.stringify(r)).sort(),
  statuses.map((s) => JSON.stringify(s)).sort(),
 ]);
 return { kind: "complete", success, snapshot };
}

/** GitHub classifications, translated once before crossing the port. */
export function githubCiVerdict(repo: string, runs: CheckRun[], purpose: CiPurpose = "merge", workflows: WorkflowRun[] = [], statuses: CommitStatus[] = []): CiVerdict {
 const green = (success: CheckRun, snapshot: string): CiVerdict => ({
  state: "green", runId: success.id, runUrl: ciRunUrl(repo, success.id), runName: success.name, snapshot,
 });
 if (purpose === "research") {
  const ci = classifyResearchCi(runs, workflows, statuses);
  if (ci.kind === "failed") return { state: "red", reason: ci.message };
  if (ci.kind === "pending") return { state: "pending", reason: ci.reason };
  return green(ci.success, ci.snapshot);
 }
 if (purpose === "close") {
  // After a merge the close historically cites one successful run.
  const success = runs.find((r) => r.status === "completed" && r.conclusion === "success");
  return success === undefined ? { state: "red", reason: "no successful check run to cite" }
   : green(success, JSON.stringify(runs));
 }
 const ci = classifyGithubCheckRuns(runs);
 if (ci.state === "none") return { state: "pending", reason: "no check runs on the head yet" };
 if (ci.state === "pending") return { state: "pending", reason: `${ci.running.length} check run(s) still running: ${ci.running.map((c) => c.name).join(", ")}` };
 if (ci.state === "failed") return { state: "red", reason: `CI failed: ${ci.failed.map((c) => `${c.name}=${c.conclusion}`).join(", ")}` };
 if (ci.state === "no-success") return { state: "red", reason: "no check run concluded success (all neutral/skipped) — nothing for the close to cite" };
 return green(ci.success, JSON.stringify(runs));
}
