import type { CheckRun, PullRequest } from "./github.ts";

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
 pr: PullRequest;
 checkRuns: CheckRun[];
 expectedBase: string;
 /** Ranger's recorded sage verdict: the SHA it read and its blocker count. */
 verdictSha: string | null;
 verdictBlockers: number | null;
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

const OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
 const { pr } = input;

 if (pr.state !== "open" || pr.merged) {
  return {
   status: "fail",
   check: "open",
   reason: pr.merged ? "PR is already merged" : "PR was closed without merging",
  };
 }

 // 1. CI green on the live head. Zero check runs is not green: a gate that
 //    passes on an empty rollup is the silent fail-open this check exists for.
 if (input.checkRuns.length === 0) {
  return { status: "pending", check: "ci-green", reason: "no check runs on the head yet" };
 }
 const running = input.checkRuns.filter((c) => c.status !== "completed");
 if (running.length > 0) {
  return {
   status: "pending",
   check: "ci-green",
   reason: `${running.length} check run(s) still running: ${running.map((c) => c.name).join(", ")}`,
  };
 }
 const failed = input.checkRuns.filter(
  (c) => !OK_CONCLUSIONS.has(c.conclusion ?? ""),
 );
 if (failed.length > 0) {
  return {
   status: "fail",
   check: "ci-green",
   reason: `CI failed: ${failed.map((c) => `${c.name}=${c.conclusion}`).join(", ")}`,
  };
 }
 // soma's auto close cites one successful check run (`--ci <id>@<sha>`).
 const success = input.checkRuns.find((c) => c.conclusion === "success");
 if (success === undefined) {
  return {
   status: "fail",
   check: "ci-green",
   reason: "no check run concluded success (all neutral/skipped) — nothing for the close to cite",
  };
 }

 // 2. mergeable. GitHub computes this lazily; null means "ask again".
 if (pr.mergeable === null || pr.mergeableState === "unknown") {
  return { status: "pending", check: "mergeable", reason: "GitHub is still computing mergeability" };
 }
 if (!pr.mergeable || pr.mergeableState === "dirty") {
  return {
   status: "fail",
   check: "mergeable",
   reason: `mergeable=${pr.mergeable}, state=${pr.mergeableState} (conflicts with ${input.expectedBase})`,
  };
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
 if (input.verdictBlockers === null || input.verdictBlockers > 0) {
  return {
   status: "fail",
   check: "review-clean",
   reason: `sage verdict at ${pr.headSha.slice(0, 8)} has ${input.verdictBlockers ?? "unknown"} blocker(s)`,
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

 return { status: "pass", ciCheckRunId: success.id, headSha: pr.headSha };
}
