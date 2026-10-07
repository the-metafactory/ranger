import * as githubApi from "./github.ts";
import type { ChangeRequest, ForgePort, CiVerdict } from "./forge.ts";
import { ParkSignal } from "./signals.ts";
import { GitSafetyError, safeGit } from "./git-ops.ts";

export type ResearchForgePort = Pick<ForgePort,
 "findPrByHead" | "getPr" | "createDraftPr" | "ciVerdictFor">;

export interface ResearchCiTiming {
 timeoutMs?: number;
 pollMs?: number;
 settleMs?: number;
 clock?: { now(): number; sleep(ms: number): Promise<void> };
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
 pr: ChangeRequest | null;
 fence(action: string): void;
 recordPr(pr: ChangeRequest): void;
 github?: ResearchForgePort;
} & ResearchCiTiming): Promise<{ pr: ChangeRequest; ci: string; check: Extract<CiVerdict, { state: "green" }> }> {
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
 const isOurDraft = (p: ChangeRequest) => p.state === "open" && p.draft && p.headRef === opts.branch && p.baseRef === opts.base;
 let reason = "PR head has not caught up to the findings push";
 for (;;) {
  opts.fence("read research CI");
  const live = await github.getPr(opts.repo, pr.iid, opts.token);
  if (!isOurDraft(live)) {
   throw new ParkSignal(`research PR #${pr.iid} must remain an open draft for ${opts.branch} against ${opts.base}`);
  }
  if (live.headSha === opts.sha) {
   const state = await github.ciVerdictFor(opts.repo, opts.sha, opts.token, "research");
   if (state.state === "red") throw new ParkSignal(`research CI failed on ${opts.sha}: ${state.reason}`);
   if (state.state === "green") {
    const { snapshot } = state;
    if (snapshot !== previousSnapshot) {
     previousSnapshot = snapshot;
     settledSince = clock.now();
     pollMs = Math.min(opts.pollMs ?? 10_000, settleMs);
    }
    if (clock.now() - settledSince >= settleMs && clock.now() <= deadline) {
     opts.fence("confirm research head");
     const final = await github.getPr(opts.repo, pr.iid, opts.token);
     if (final.headSha !== opts.sha || !isOurDraft(final)) {
      throw new ParkSignal(`research PR #${pr.iid} changed while checking CI — refusing stale evidence`);
     }
     if (clock.now() > deadline) throw new ParkSignal(`research CI wait expired for PR #${pr.iid}: final head confirmation`);
     return { pr: final, ci: `${state.runId}@${opts.sha}`, check: state };
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
  if (remaining <= 0) throw new ParkSignal(`research CI wait expired for PR #${pr.iid}: ${reason}`);
  const settlingRemaining = previousSnapshot === null ? remaining : settleMs - (clock.now() - settledSince);
  await clock.sleep(Math.min(pollMs, remaining, settlingRemaining));
  if (previousSnapshot === null) pollMs = Math.min(pollMs * 2, 60_000);
 }
}
