import { z } from "zod";
import type { ImplementContext } from "./implement.ts";
import type { ChangeRequest } from "./forge.ts";
import { FencedError } from "./journal.ts";
import { ParkSignal } from "./signals.ts";
import { assertNoClosingKeywords, commitsAhead, dirtyFiles, fetchBranch, fetchRemoteBranch, gitCredential, hasCommit, headSha, isAncestor, safeGit, vettedPush } from "./git-ops.ts";
import { recordKnownGood, trustedSnapshot } from "./git-trust.ts";
import { mapKey } from "./maps.ts";
import { parseForgeRef } from "./forge-ref.ts";
import { assertResearchFindingsOnly } from "./research-ci.ts";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const phases = ["research", "implement", "review", "awaiting-review", "awaiting-merge", "close"] as const;
const evidenceSchema = z.object({ sha, kind: z.enum(["tests", "tests-gate", "review", "research-worker", "research-ci"]), result: z.enum(["passed", "failed", "unknown"]), detail: z.string() });
const checkpointSchema = z.object({
 version: z.literal(1), repo: z.string(), nodeId: z.string(), branch: z.string(), sha,
 phase: z.enum(phases),
 preservedSha: sha.nullable(), worktree: z.string(), evidence: z.array(evidenceSchema), durabilityError: z.string().nullable(),
});
export type NodeCheckpoint = z.infer<typeof checkpointSchema>;
export type ProgressEvidence = z.infer<typeof evidenceSchema>;
export class ProgressConflict extends ParkSignal {}
export type ProgressContext = Pick<ImplementContext, "journal" | "map" | "node" | "canonical" | "worktree" | "branch" | "generation" | "token">;

const identity = (ctx: ProgressContext) => ({ repo: ctx.map.repo, nodeId: ctx.node.ref.id });

function recordedProgressRebase(ctx: ProgressContext, from: string, to: string): boolean {
 return ctx.journal.listRebases(ctx.map.repo, ctx.node.ref.id).some(rebase => rebase.from === from && rebase.to === to);
}

async function remoteWasRewound(ctx: ProgressContext, remote: string | null, preserved: string | null | undefined): Promise<boolean> {
 return remote !== null && preserved != null && remote !== preserved && await hasCommit(ctx.worktree, preserved) && await isAncestor(ctx.worktree, remote, preserved);
}

export function nodeCheckpoint(ctx: ProgressContext): NodeCheckpoint | null {
 const { repo, nodeId } = identity(ctx);
 const raw = ctx.journal.nodeProgress(repo, nodeId);
 if (raw === null) return null;
 const checkpoint = checkpointSchema.parse(JSON.parse(raw));
 if (checkpoint.repo !== repo || checkpoint.nodeId !== nodeId || checkpoint.branch !== ctx.branch) {
  throw new ProgressConflict(`progress checkpoint identity differs from ${repo}#${nodeId} branch ${ctx.branch}; reconcile it before resuming`);
 }
 if (checkpoint.evidence.some(evidence => evidence.sha !== checkpoint.sha)) throw new ProgressConflict("progress checkpoint contains evidence for a different SHA");
 return checkpoint;
}

export async function checkpointNode(ctx: ProgressContext, input: {
 sha?: string; preservedSha?: string; evidence?: ProgressEvidence; durabilityError?: string | null; phase?: NodeCheckpoint["phase"];
} = {}): Promise<NodeCheckpoint> {
 const { repo, nodeId } = identity(ctx);
 const expected = ctx.journal.nodeProgress(repo, nodeId);
 const previous = nodeCheckpoint(ctx);
 const current = input.sha ?? await headSha(ctx.worktree);
 const rebased = previous !== null && recordedProgressRebase(ctx, previous.sha, current);
 if (previous !== null && previous.sha !== current &&
  !rebased && (!(await hasCommit(ctx.worktree, previous.sha)) || !(await isAncestor(ctx.worktree, previous.sha, current)))) {
  throw new ProgressConflict(`checkpoint ${previous.sha} is not an ancestor of worktree ${current}; saved progress was retained, reconcile ${ctx.worktree} before resuming`);
 }
 const initial = ctx.node.node.kind === "research" ? "research" : "implement";
 const phase = input.phase ?? ctx.journal.getWorker(nodeId, repo)?.phase ?? initial;
 const same = previous?.sha === current;
 const invalidatesTests = input.evidence?.kind === "tests" && input.evidence.result !== "passed";
 const invalidatesResearch = input.evidence?.kind === "research-worker" && input.evidence.result !== "passed";
 const evidence = same ? previous.evidence.filter(item => item.kind !== input.evidence?.kind &&
  !(invalidatesTests && item.kind === "tests-gate") && !(invalidatesResearch && item.kind === "research-ci")) : [];
 if (input.evidence !== undefined) {
  if (input.evidence.sha !== current) throw new ProgressConflict(`evidence at ${input.evidence.sha} cannot certify checkpoint ${current}`);
  evidence.push(input.evidence);
 }
 const checkpoint: NodeCheckpoint = {
  version: 1, repo, nodeId, branch: ctx.branch, sha: current, worktree: ctx.worktree,
  phase: !same || invalidatesTests || invalidatesResearch ? initial : phases.indexOf(previous.phase) > phases.indexOf(phase) ? previous.phase : phase,
  preservedSha: input.preservedSha ?? previous?.preservedSha ?? null, evidence,
  durabilityError: input.durabilityError === undefined ? previous?.durabilityError ?? null : input.durabilityError,
 };
 if (!ctx.journal.saveNodeProgress(repo, nodeId, ctx.generation, expected, JSON.stringify(checkpoint))) {
  throw new FencedError(`node ${nodeId}: progress checkpoint changed while saving ${current}`);
 }
 return checkpoint;
}

export async function progressRemote(ctx: ProgressContext): Promise<string | null> {
 await trustedSnapshot(ctx.journal, ctx.canonical, identity(ctx), mapKey(ctx.map));
 const ref = await fetchRemoteBranch(ctx.canonical, ctx.branch, gitCredential(ctx.map.repo, ctx.token));
 if (ref === null) return null;
 const result = await safeGit(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: ctx.canonical, timeoutMs: 10_000 });
 if (result.code !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout.trim())) throw new ProgressConflict(`cannot read remote checkpoint for ${ctx.branch}`);
 return result.stdout.trim();
}

export async function reconcileNodeProgress(ctx: ProgressContext, remote: string | null,
 sync?: (head: string) => Promise<void>): Promise<void> {
 const previous = nodeCheckpoint(ctx);
 let here = await headSha(ctx.worktree);
 const saved = previous?.sha;
 if (saved !== undefined && saved !== here) {
  if (!(await hasCommit(ctx.worktree, saved))) throw new ProgressConflict(`saved checkpoint ${saved} is unavailable; recover ${previous?.worktree} before resuming ${ctx.worktree}`);
  if (await isAncestor(ctx.worktree, here, saved)) {
   await align(saved);
   here = await headSha(ctx.worktree);
  } else if (!(await isAncestor(ctx.worktree, saved, here)) && !recordedProgressRebase(ctx, saved, here)) {
   throw new ProgressConflict(`worktree ${here} diverges from checkpoint ${saved}; reconcile both before resuming`);
  }
 }
 if (remote !== null && remote !== here) {
  if (await remoteWasRewound(ctx, remote, previous?.preservedSha)) {
   throw new ProgressConflict(`origin/${ctx.branch} went back to ${remote.slice(0, 8)} (${remote}) from preserved ${previous?.preservedSha}; nothing was pushed over the rewind, reconcile ${ctx.worktree}`);
  }
  if (sync !== undefined) await sync(remote);
  else if (await isAncestor(ctx.worktree, here, remote)) await align(remote);
  else if (!(await isAncestor(ctx.worktree, remote, here))) throw new ProgressConflict(`worktree ${here} diverges from origin/${ctx.branch} ${remote}; reconcile both before resuming`);
 }
 here = await headSha(ctx.worktree);
 if (await commitsAhead(ctx.worktree, ctx.map.base) > 0) {
  await checkpointNode(ctx, { sha: here, ...(remote === null ? {} : { preservedSha: remote }) });
 }
 async function align(target: string): Promise<void> {
  if ((await dirtyFiles(ctx.worktree)).length > 0) throw new ProgressConflict(`worktree ${here} has uncommitted changes and checkpoint head is ${target}; commit or reconcile ${ctx.worktree} before resuming`);
  ctx.journal.assertGeneration(ctx.node.ref.id, ctx.map.repo, ctx.generation, "recover committed progress");
  const moved = await safeGit(["merge", "--ff-only", target], { cwd: ctx.worktree, timeoutMs: 60_000 });
  if (moved.code !== 0) throw new ProgressConflict(`cannot recover ${target} into ${ctx.worktree}: ${moved.stderr.trim()}`);
 }
}

export async function preserveNodeProgress(ctx: ProgressContext, refusal?: string,
 policy: (sha: string) => Promise<void> = sha => progressPushPolicy(ctx, sha)): Promise<string | null> {
 const { repo, nodeId } = identity(ctx);
 let current: string | undefined;
 try {
  if (refusal !== undefined) throw new Error(`remote preservation refused by the supervisor safety gate: ${refusal}`);
  if (await commitsAhead(ctx.worktree, ctx.map.base) === 0) return null;
  const snapshot = await trustedSnapshot(ctx.journal, ctx.canonical, { repo, nodeId }, mapKey(ctx.map));
  current = await headSha(ctx.worktree);
  const checkpoint = await checkpointNode(ctx, { sha: current });
  await policy(current);
  const remote = await progressRemote(ctx);
  if (await remoteWasRewound(ctx, remote, checkpoint.preservedSha)) {
   throw new ProgressConflict(`origin/${ctx.branch} was rewound from ${checkpoint.preservedSha} to ${remote}; remote preservation refused`);
  }
  await assertNoClosingKeywords(ctx.worktree, ctx.map.base, parseForgeRef(repo).forge);
  ctx.journal.assertGeneration(nodeId, repo, ctx.generation, "preserve committed progress");
  const vetted = await vettedPush({ worktree: ctx.worktree, canonical: ctx.canonical, branch: ctx.branch,
   source: current, credential: gitCredential(repo, ctx.token), configSnapshot: snapshot });
  recordKnownGood(ctx.journal, ctx.canonical, vetted, "preserved committed progress");
  await checkpointNode(ctx, { sha: current, preservedSha: current, durabilityError: null });
  ctx.journal.recordEvent("progress-preserved", { repo, nodeId, detail: `${ctx.branch} preserved at ${current}; verification gates remain outstanding` });
  return null;
 } catch (error) {
  if (error instanceof FencedError) throw error;
  const state = refusal === undefined ? `committed progress${current === undefined ? "" : ` at ${current}`}` : "commit state is unknown because the supervisor safety gate refused Git access";
  const detail = `durability failure: ${state}; work is not confirmed recoverable on another machine; local recovery: ${ctx.worktree} (${ctx.branch}); ${String(error).slice(0, 400)}`;
  if (current !== undefined && !(error instanceof ProgressConflict)) {
   try { await checkpointNode(ctx, { sha: current, durabilityError: detail }); }
   catch (checkpointError) { if (checkpointError instanceof FencedError) throw checkpointError; }
  }
  ctx.journal.recordEvent("progress-preservation-failed", { repo, nodeId, detail });
  return detail;
 }
}

export async function confirmPreservedProgress(ctx: ProgressContext, current: string): Promise<void> {
 let confirmed = false;
 try { confirmed = await progressRemote(ctx) === current; }
 catch (error) { if (error instanceof FencedError) throw error; }
 if (!confirmed) {
  const failure = await preserveNodeProgress(ctx);
  if (failure !== null) throw new ProgressConflict(failure);
  const remote = await progressRemote(ctx);
  if (remote === null || !(await isAncestor(ctx.worktree, current, remote))) {
   throw new ProgressConflict(`durability failure: origin/${ctx.branch} does not confirm committed ${current}; local recovery: ${ctx.worktree}; no remote preservation was recorded`);
  }
 }
 await checkpointNode(ctx, { sha: current, preservedSha: current, durabilityError: null });
}

async function progressPushPolicy(ctx: ProgressContext, sha: string): Promise<void> {
 if (ctx.node.node.kind !== "research") return;
 const base = ctx.journal.getWorker(ctx.node.ref.id, ctx.map.repo)?.researchBaseSha;
 if (base == null) throw new ProgressConflict(`research pre-worker base is missing for ${ctx.branch}; operator intervention required`);
 const checkedOut = await safeGit(["symbolic-ref", "--short", "HEAD"], { cwd: ctx.worktree, timeoutMs: 10_000 });
 if (checkedOut.code !== 0 || checkedOut.stdout.trim() !== ctx.branch) throw new ProgressConflict(`research worktree is not on ${ctx.branch}; remote preservation refused`);
 await assertResearchFindingsOnly(ctx.canonical, base, sha);
}

async function mergedResultContains(ctx: ProgressContext, pr: ChangeRequest, here: string): Promise<boolean> {
 const merged = pr.mergeCommitSha ?? null;
 if (pr.state !== "merged" || merged === null) return false;
 try {
  if (!(await hasCommit(ctx.worktree, merged))) {
   await fetchBranch(ctx.canonical, ctx.map.base, gitCredential(ctx.map.repo, ctx.token));
   if (!(await hasCommit(ctx.worktree, merged))) return false;
  }
  const tree = await safeGit(["rev-parse", "--verify", `${merged}^{tree}`], { cwd: ctx.worktree, timeoutMs: 10_000 });
  if (tree.code !== 0) return false;
  const trial = await safeGit(["merge-tree", "--write-tree", "--no-messages", merged, here], { cwd: ctx.worktree, timeoutMs: 60_000 });
  return trial.code === 0 && trial.stdout.split("\n")[0]?.trim() === tree.stdout.trim();
 } catch (error) {
  if (error instanceof FencedError) throw error;
  return false;
 }
}

export async function preserveUnmergedClosure(ctx: ProgressContext, pr: ChangeRequest): Promise<void> {
 const here = await headSha(ctx.worktree);
 const saved = nodeCheckpoint(ctx);
 if (saved !== null && saved.sha !== here &&
  (!(await hasCommit(ctx.worktree, saved.sha)) || !(await isAncestor(ctx.worktree, saved.sha, here)))) {
  throw new ProgressConflict(`checkpoint ${saved.sha} is missing from worktree ${here}; reconcile ${saved.worktree} before closure cleanup`);
 }
 if (here === pr.headSha || await isAncestor(ctx.worktree, here, `origin/${ctx.map.base}`)) return;
 if (await mergedResultContains(ctx, pr, here)) return;
 const failure = await preserveNodeProgress(ctx);
 throw new ProgressConflict(`merged PR ${pr.iid} covers ${pr.headSha}, but worktree ${here} contains additional committed progress; reconcile ${ctx.worktree} before closing${failure === null ? `; preserved at ${here} on origin/${ctx.branch}` : `; ${failure}`}`);
}
