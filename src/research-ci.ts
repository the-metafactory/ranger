import * as githubApi from "./github.ts";
import type { CheckRun, CommitStatus, WorkflowRun, PullRequest, GitHubPort } from "./github.ts";
import { ParkSignal } from "./signals.ts";
import { GitSafetyError, safeGit } from "./git-ops.ts";

export type ResearchGitHubPort = Pick<GitHubPort,
 "findPrByHead" | "getPr" | "createDraftPr" | "checkRunsFor" | "workflowRunsFor" | "commitStatusesFor">;

export interface ResearchCiTiming {
 timeoutMs?: number;
 pollMs?: number;
 settleMs?: number;
 clock?: { now(): number; sleep(ms: number): Promise<void> };
}

type CiState = { kind: "failed"; message: string }
 | { kind: "pending"; reason: string }
 | { kind: "complete"; success: CheckRun; snapshot: string };

export function classifyCi(runs: CheckRun[], workflows: WorkflowRun[], statuses: CommitStatus[]): CiState {
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

/** The base SHA must be captured before the worker can move local refs. */
export async function assertResearchFindingsOnly(canonical: string, baseSha: string, sha: string): Promise<void> {
 const diff = await safeGit([
  "--no-replace-objects", "diff", "--no-ext-diff", "--no-textconv", "--no-renames",
  "--name-only", "-z", baseSha, sha, "--",
 ], { cwd: canonical });
 if (diff.code !== 0) {
  throw new GitSafetyError(`cannot validate research findings diff: ${diff.stderr.trim()}`);
 }
 const forbidden = diff.stdout.split("\0").filter((path) => path !== "" && path !== "findings.md");
 if (forbidden.length > 0) {
  throw new GitSafetyError(`research commits may change only findings.md; refused paths: ${forbidden.map((path) => JSON.stringify(path)).join(", ")}`);
 }
}

/** Drafts carry research CI evidence; they stay drafts and never enter the merge desk. */
export async function researchCi(opts: {
 repo: string;
 branch: string;
 base: string;
 sha: string;
 nodeId: string;
 token: string;
 pr: PullRequest | null;
 fence(action: string): void;
 recordPr(pr: PullRequest): void;
 github?: ResearchGitHubPort;
} & ResearchCiTiming): Promise<{ pr: PullRequest; ci: string; check: CheckRun }> {
 const github = opts.github ?? githubApi;
 let pr = opts.pr;
 if (pr === null) {
  opts.fence("open research PR");
  pr = await github.createDraftPr(opts.repo, {
   head: opts.branch,
   base: opts.base,
   title: `Research findings for node #${opts.nodeId}`,
   body: `Findings for node #${opts.nodeId}. This draft supplies CI evidence for the research close and remains unmerged.`,
  }, opts.token);
 }
 opts.fence("record research PR");
 opts.recordPr(pr);
 const clock = opts.clock ?? { now: Date.now, sleep: (ms: number) => Bun.sleep(ms) };
 const deadline = clock.now() + (opts.timeoutMs ?? 15 * 60_000);
 const settleMs = opts.settleMs ?? 30_000;
 let settledSince = 0;
 let previousSnapshot: string | null = null;
 let pollMs = opts.pollMs ?? 10_000;
 const isOurDraft = (p: PullRequest) => p.state === "open" && !p.merged && p.draft && p.headRef === opts.branch && p.baseRef === opts.base;
 let reason = "PR head has not caught up to the findings push";
 for (;;) {
  opts.fence("read research CI");
  const live = await github.getPr(opts.repo, pr.number, opts.token);
  if (!isOurDraft(live)) {
   throw new ParkSignal(`research PR #${pr.number} must remain an open draft for ${opts.branch} against ${opts.base}`);
  }
  if (live.headSha === opts.sha) {
   const [runs, workflows, statuses] = await Promise.all([
    github.checkRunsFor(opts.repo, opts.sha, opts.token),
    github.workflowRunsFor(opts.repo, opts.sha, opts.token),
    github.commitStatusesFor(opts.repo, opts.sha, opts.token),
   ]);
   const state = classifyCi(runs, workflows, statuses);
   if (state.kind === "failed") throw new ParkSignal(`research CI failed on ${opts.sha}: ${state.message}`);
   if (state.kind === "complete") {
    const { success, snapshot } = state;
    if (snapshot !== previousSnapshot) {
     previousSnapshot = snapshot;
     settledSince = clock.now();
     pollMs = Math.min(opts.pollMs ?? 10_000, settleMs);
    }
    if (clock.now() - settledSince >= settleMs && clock.now() <= deadline) {
     opts.fence("confirm research head");
     const final = await github.getPr(opts.repo, pr.number, opts.token);
     if (final.headSha !== opts.sha || !isOurDraft(final)) {
      throw new ParkSignal(`research PR #${pr.number} changed while checking CI — refusing stale evidence`);
     }
     if (clock.now() > deadline) throw new ParkSignal(`research CI wait expired for PR #${pr.number}: final head confirmation`);
     return { pr: final, ci: `${success.id}@${opts.sha}`, check: success };
    }
    reason = "completed CI snapshot still settling";
   } else {
    previousSnapshot = null;
    reason = state.reason;
   }
  } else {
   previousSnapshot = null;
   reason = "PR head has not caught up to the findings push";
  }
  const remaining = deadline - clock.now();
  if (remaining <= 0) throw new ParkSignal(`research CI wait expired for PR #${pr.number}: ${reason}`);
  const settlingRemaining = previousSnapshot === null ? remaining : settleMs - (clock.now() - settledSince);
  await clock.sleep(Math.min(pollMs, remaining, settlingRemaining));
  if (previousSnapshot === null) pollMs = Math.min(pollMs * 2, 60_000);
 }
}
