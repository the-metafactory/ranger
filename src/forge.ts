/** The forge-neutral contract used by Ranger's supervisor lanes. */
export type MergeState = "mergeable" | "conflict" | "needs-rebase" | "pending" | "blocked" | "unknown";

export interface ChangeRequest {
 iid: number;
 state: "open" | "closed" | "merged";
 draft: boolean;
 headRef: string;
 headSha: string;
 baseRef: string;
 mergeState: MergeState;
 webUrl: string;
 author: string;
 title: string;
 mergeCommitSha: string | null;
 mergedBy: string | null;
 /** Adapter diagnostic text, kept for existing GitHub operator messages. */
 mergeDetail?: string;
 /**
  * The forge is merging this change request right now (GitLab `locked`). `state`
  * still reads `closed` by contract; a consumer must not treat it as abandoned.
  */
 mergeInProgress?: true;
}

/** Preserve each lane's existing evidence policy at the adapter boundary. */
export type CiPurpose = "merge" | "close" | "research";
export type CiVerdict =
 | { state: "green"; runId: number; runUrl: string; runName: string; snapshot: string }
 | { state: "red" | "pending"; reason: string };

export interface IssueComment {
 id: number;
 author: string;
 body: string;
}

/** Read credentials may carry a forge's checked, project-bound grant. */
export interface ForgeReadPort<Credential = string> {
 findPrByHead(repo: string, branch: string, token: Credential): Promise<ChangeRequest | null>;
 getPr(repo: string, n: number, token: Credential): Promise<ChangeRequest>;
 ciVerdictFor(repo: string, sha: string, token: Credential, purpose?: CiPurpose): Promise<CiVerdict>;
 /** Labels of a tracker issue (a graph node), by issue number. */
 issueLabels(repo: string, issue: number, token: Credential): Promise<string[]>;
 /**
  * Conversation comments of a change request, by PR/MR number. GitHub shares one
  * number space for issues and PRs; GitLab does not, so never pass an issue iid.
  */
 listComments(repo: string, changeRequest: number, token: Credential): Promise<IssueComment[]>;
}

/**
 * What a merge attempt did. GitHub's adapter returns nothing on success and
 * throws otherwise (its historical contract), so `void` reads as merged.
 */
export type MergeOutcome =
 | { status: "merged" }
 /** The head is no longer the gated SHA: nothing merged; re-gate the new head. */
 | { status: "head-moved"; reason: string }
 /** The forge declined the merge; `reason` carries its own message. */
 | { status: "not-mergeable"; reason: string }
 /** Ranger refuses (or the forge did not honour the squash): escalate to the principal. */
 | { status: "refused"; reason: string };

/** What a rebase request did. It never merges. */
export type RebaseOutcome =
 /** The forge rebased the source branch: the head moved to `headSha`. */
 | { status: "head-moved"; headSha: string }
 /** The rebase is still running after the bounded wait: re-read next pass. */
 | { status: "pending"; reason: string }
 /** The forge could not rebase (a conflict, a refusal); `reason` is its message. */
 | { status: "not-mergeable"; reason: string };

export interface ForgePort<ReadCredential = string, WriteCredential = string> extends ForgeReadPort<ReadCredential> {
 createDraftPr(repo: string, pr: { head: string; base: string; title: string; body: string }, token: WriteCredential): Promise<ChangeRequest>;
 updatePrBody(repo: string, n: number, body: string, token: WriteCredential): Promise<void>;
 markReady(repo: string, pr: ChangeRequest, token: WriteCredential): Promise<void>;
 /** Squash-merge pinned to `sha`, the head the merge gate passed at. */
 mergePr(repo: string, n: number, sha: string, title: string, token: WriteCredential): Promise<MergeOutcome | void>;
 /**
  * Rebase the source branch onto its target, for a forge that reports
  * `needs-rebase` (GitLab under `rebase_merge`). GitHub never reports it.
  */
 rebasePr?(repo: string, n: number, token: WriteCredential): Promise<RebaseOutcome>;
 /** Why this forge project cannot take a squash merge, or null when it can. Read before any merge write. */
 squashRefusal?(repo: string, token: ReadCredential): Promise<string | null>;
 postComment(repo: string, n: number, body: string, token: WriteCredential): Promise<number>;
}
