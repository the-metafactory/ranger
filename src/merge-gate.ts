import { classifyCi } from "./ci-policy.ts";
import type { ChangeRequest, CiVerdict } from "./forge.ts";

/**
 * The implement lane's merge gate (design §2/§4, #23 amendment). Pilot's
 * six-check SHAPE, adapted: pilot's checks 3 and 6 (a formal review from the
 * expected reviewer, an adversarial review by a non-author) do not port —
 * the offline sage review posts nothing to GitHub, and anything ranger posts
 * is the PR author's. The review check is ranger's own recorded verdict,
 * bound to the live head SHA. The verdict is machine evidence, never human
 * sign-off: a passing gate escalates one tap to the principal, and ranger
 * never merges while approver-bot is unprovisioned (node #6, #16).
 */

export type GateCheck =
 | "open"
 | "ci-green"
 | "mergeable"
 | "base-branch"
 | "review-clean"
 | "probes";

export interface MergeGateInput {
 pr: ChangeRequest;
 ci: CiVerdict;
 expectedBase: string;
 /** Ranger's recorded sage verdict: the SHA it read and its blocker count. */
 verdictSha: string | null;
 verdictBlockers: number | null;
 /** Majors gate too (principal, 2026-10-03): a major is reworked and re-reviewed. */
 verdictMajors?: number | null;
 /**
  * The map declares a probe tier (`commands.probe`): ranger's passing probe
  * record must be at exactly the live head. Undefined/false = no probe tier.
  */
 probesRequired?: boolean;
 probePassedSha?: string | null;
}

export type MergeGateResult =
 | { status: "pass"; ciCheckRunId: number; headSha: string }
 /** Not decidable yet (CI running, mergeability computing) — re-check next tick. */
 | { status: "pending"; check: GateCheck; reason: string }
 /** A hard failure that needs a human or a new round — park + card. */
 | { status: "fail"; check: GateCheck; reason: string };

export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
 const { pr } = input;

 if (pr.state !== "open") {
  return {
   status: "fail",
   check: "open",
   reason: pr.state === "merged" ? "PR is already merged" : "PR was closed without merging",
  };
 }

 // 0. A known conflict fails before CI is read: GitHub starts no pull_request
 //    workflow on a conflicting PR, so "no check runs yet" would read as
 //    pending forever (seelite #692, 2026-10-05: ready and sage-clean, never
 //    carded, because #686/#687 landed while it was being built).
 if (pr.mergeState === "conflict") {
  return {
   status: "fail",
   check: "mergeable",
   reason: `${pr.mergeDetail ?? "state=conflict"} (conflicts with ${input.expectedBase})`,
  };
 }

 if (["unknown", "blocked", "needs-rebase"].includes(pr.mergeState)) {
  return { status: "fail", check: "mergeable", reason: `merge state is ${pr.mergeState}${pr.mergeDetail ? ` (${pr.mergeDetail})` : ""}` };
 }

 // 1. CI green on the live head, from the adapter's forge-neutral verdict.
 const ci = classifyCi(input.ci);
 if (ci.status !== "pass") return { status: ci.status, check: "ci-green", reason: ci.reason };

 // The adapter normalises computing states; unfamiliar states fail closed.
 if (pr.mergeState === "pending") {
  return { status: "pending", check: "mergeable", reason: pr.mergeDetail ?? "Forge is still computing mergeability" };
 }

 // 3. base branch.
 if (pr.baseRef !== input.expectedBase) {
  return {
   status: "fail",
   check: "base-branch",
   reason: `base is '${pr.baseRef}', expected '${input.expectedBase}'`,
  };
 }

 // 4. head freshness + review: ranger's sage verdict read exactly the live
 //    head, with no blockers. A push after the review (by anyone) moves the
 //    head off the verdict and fails this check.
 if (input.verdictSha !== pr.headSha) {
  return {
   status: "fail",
   check: "review-clean",
   reason: `no sage verdict recorded for head ${pr.headSha.slice(0, 8)}`,
  };
 }
 if (
  input.verdictBlockers === null ||
  input.verdictBlockers > 0 ||
  (input.verdictMajors ?? 0) > 0
 ) {
  return {
   status: "fail",
   check: "review-clean",
   reason: `sage verdict at ${pr.headSha.slice(0, 8)} has ${input.verdictBlockers ?? "unknown"} blocker(s) and ${input.verdictMajors ?? 0} major(s)`,
  };
 }

 // 5. the probe tier, when the map has one: a passing run recorded at this head.
 if (input.probesRequired === true && input.probePassedSha !== pr.headSha) {
  return {
   status: "fail",
   check: "probes",
   reason: `no passing probe run recorded at head ${pr.headSha.slice(0, 8)}`,
  };
 }

 return { status: "pass", ciCheckRunId: ci.runId, headSha: pr.headSha };
}
