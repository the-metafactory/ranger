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

/**
 * Read credentials may carry a forge's checked, project-bound grant. An
 * adapter in the lanes' string-credential shape may ignore the credential a
 * caller passes to a read and use its own gated read-only one instead
 * (GitLab's does: `gitlabForgePort`); a caller never relies on its token
 * reaching a read.
 */
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

/** What a merge attempt did. How each adapter reports a refusal is on `ForgePort.mergePr`. */
export type MergeOutcome =
 /**
  * The change request is merged. `unsquashed` is set when the forge merged
  * without honouring the squash: still a merge (the close follows), and the
  * note escalates it to the principal.
  */
 | { status: "merged"; unsquashed?: string }
 /** The head is no longer the gated SHA: nothing merged; re-gate the new head. */
 | { status: "head-moved"; reason: string }
 /** The forge declined the merge; `reason` carries its own message. */
 | { status: "not-mergeable"; reason: string };

/**
 * What a rebase request did. It never merges. `requested` says whether this
 * call sent a rebase request, or only waited on one an earlier pass started.
 */
export type RebaseOutcome =
 /** The forge rebased the source branch: the head moved to `headSha`. */
 | { status: "head-moved"; headSha: string; requested: boolean }
 /** The head has not moved yet (still rebasing, or not started): re-read next pass. */
 | { status: "pending"; reason: string; requested: boolean }
 /** The forge could not rebase (a conflict, a refusal); `reason` is its message. */
 | { status: "not-mergeable"; reason: string };

export interface ForgePort<ReadCredential = string, WriteCredential = string> extends ForgeReadPort<ReadCredential> {
 createDraftPr(repo: string, pr: { head: string; base: string; title: string; body: string }, token: WriteCredential): Promise<ChangeRequest>;
 updatePrBody(repo: string, n: number, body: string, token: WriteCredential): Promise<void>;
 markReady(repo: string, pr: ChangeRequest, token: WriteCredential): Promise<void>;
 /**
  * Squash-merge pinned to `sha`, the head the merge gate passed at. A caller
  * handles refusals both ways: GitHub's adapter keeps its historical contract
  * and throws on every refusal (a return is always `merged`); GitLab's answers
  * `head-moved` (409) and `not-mergeable` (405/406/422) and throws only on a
  * fault.
  */
 mergePr(repo: string, n: number, sha: string, title: string, token: WriteCredential): Promise<MergeOutcome>;
 /**
  * Rebase the source branch onto its target, for a forge that reports
  * `needs-rebase` (GitLab under `rebase_merge`). GitHub never reports it.
  */
 rebasePr?(repo: string, n: number, token: WriteCredential): Promise<RebaseOutcome>;
 /** Why this forge project cannot take a squash merge, or null when it can. Read before any merge write. */
 squashRefusal?(repo: string, token: ReadCredential): Promise<string | null>;
 postComment(repo: string, n: number, body: string, token: WriteCredential): Promise<number>;
}
