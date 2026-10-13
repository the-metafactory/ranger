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
 /** The live description; editable after the PR opened (node #128). */
 body: string;
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
 /**
  * `noRuns`: pending only because no CI run exists on the head at all (no
  * check run on GitHub, no push or merge_request_event pipeline on GitLab);
  * the merge desk's no-CI send-back reads it.
  */
 | { state: "red" | "pending"; reason: string; noRuns?: true };

export interface IssueComment {
 id: number;
 author: string;
 body: string;
}

/** One reaction on a comment: who reacted, and GitHub's content (`+1`, `-1`, `heart`, …). */
export interface CommentReaction {
 author: string;
 content: string;
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
 /**
  * Every comment on a tracker issue (a graph node), every page (node #250).
  * GitHub only: the ratify phase walks only GitHub maps.
  */
 issueComments?(repo: string, issue: number, token: Credential): Promise<IssueComment[]>;
 /** Every reaction on an issue comment, every page (node #250). GitHub only. */
 commentReactions?(repo: string, commentId: string, token: Credential): Promise<CommentReaction[]>;
 /**
  * Every issue (open or closed, never a PR) carrying `label`, every page:
  * the intake gate's marker lookup (node #251). GitHub only.
  */
 issuesWithLabel?(repo: string, label: string, token: Credential): Promise<LabeledIssue[]>;
}

/** One tracker issue read by label: its number, body and author's login. */
export interface LabeledIssue {
 number: number;
 body: string;
 author: string;
}

/** What a merge attempt did. How each adapter reports a refusal is on `ForgePort.mergePr`. */
export type MergeOutcome =
 /**
  * The change request is merged. `unsquashed` is set when the forge merged
  * without honouring the squash: still a merge (the close follows), and the
  * note escalates it to the principal. `squashSha` is the squash commit the
  * forge reports, when its response names one.
  */
 | { status: "merged"; unsquashed?: string; squashSha?: string }
 /** The head is no longer the gated SHA: nothing merged; re-gate the new head. */
 | { status: "head-moved"; reason: string }
 /** The forge declined the merge; `reason` carries its own message. */
 | { status: "not-mergeable"; reason: string };

/**
 * What a rebase request did. It never merges. `requested` says whether this
 * call sent a rebase request, or only waited on a rebase already running
 * (which the call cannot tell apart from one somebody else started).
 */
export type RebaseOutcome =
 /**
  * The head moved from the gated SHA to `headSha`, and the forge shows the
  * same commits there (message, author, author date, in order): a rebase,
  * not new work.
  */
 | { status: "head-moved"; headSha: string; requested: boolean }
 /**
  * The head is not where a rebase of the gated SHA would leave it: it had
  * already moved before the call, or the commits differ after the move (a
  * push). Nothing is attributed to the rebase.
  */
 | { status: "unconfirmed"; reason: string }
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
  * `needs-rebase` (GitLab under `rebase_merge`), from `sha`, the head the
  * merge gate passed at. GitHub never reports it.
  */
 rebasePr?(repo: string, n: number, sha: string, token: WriteCredential): Promise<RebaseOutcome>;
 /** Why this forge project cannot take a squash merge, or null when it can. Read before any merge write. */
 squashRefusal?(repo: string, token: ReadCredential): Promise<string | null>;
 postComment(repo: string, n: number, body: string, token: WriteCredential): Promise<number>;
}
