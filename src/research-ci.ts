import * as githubApi from "./github.ts";
import type { CheckRun, PullRequest } from "./github.ts";
import { ParkSignal } from "./implement.ts";

export type ResearchGitHubPort = Pick<typeof githubApi,
 "findPrByHead" | "getPr" | "createDraftPr" | "checkRunsFor">;

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
 timeoutMs?: number;
 pollMs?: number;
}): Promise<{ pr: PullRequest; ci: string; check: CheckRun }> {
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
 const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
 let reason = "PR head has not caught up to the findings push";
 for (;;) {
  opts.fence("read research CI");
  const live = await github.getPr(opts.repo, pr.number, opts.token);
  if (live.state !== "open" || live.merged || !live.draft || live.headRef !== opts.branch || live.baseRef !== opts.base) {
   throw new ParkSignal(`research PR #${pr.number} must remain an open draft for ${opts.branch} against ${opts.base}`);
  }
  if (live.headSha === opts.sha) {
   const runs = await github.checkRunsFor(opts.repo, opts.sha, opts.token);
   const failed = runs.filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion ?? ""));
   if (failed.length > 0) {
    throw new ParkSignal(`research CI failed on ${opts.sha}: ${failed.map((r) => `${r.name}=${r.conclusion}`).join(", ")}`);
   }
   const running = runs.filter((r) => r.status !== "completed");
   const success = runs.find((r) => r.status === "completed" && r.conclusion === "success" && Number.isSafeInteger(r.id) && r.id > 0);
   if (runs.length > 0 && running.length === 0) {
    if (success === undefined) throw new ParkSignal("research CI has no successful check run to cite");
    opts.fence("confirm research head");
    const final = await github.getPr(opts.repo, pr.number, opts.token);
    if (final.headSha !== opts.sha || final.state !== "open" || final.merged || !final.draft || final.headRef !== opts.branch || final.baseRef !== opts.base) {
     throw new ParkSignal(`research PR #${pr.number} changed while checking CI — refusing stale evidence`);
    }
    return { pr: final, ci: `${success.id}@${opts.sha}`, check: success };
   }
   reason = runs.length === 0 ? "no check runs on the findings head" : `${running.length} check run(s) still running`;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ParkSignal(`research CI wait expired for PR #${pr.number}: ${reason}`);
  await Bun.sleep(Math.min(opts.pollMs ?? 5_000, remaining));
 }
}
