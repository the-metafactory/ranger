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
 issueLabels(repo: string, n: number, token: Credential): Promise<string[]>;
 listComments(repo: string, n: number, token: Credential): Promise<IssueComment[]>;
}

export interface ForgePort<ReadCredential = string> extends ForgeReadPort<ReadCredential> {
 createDraftPr(repo: string, pr: { head: string; base: string; title: string; body: string }, token: string): Promise<ChangeRequest>;
 updatePrBody(repo: string, n: number, body: string, token: string): Promise<void>;
 markReady(repo: string, pr: ChangeRequest, token: string): Promise<void>;
 mergePr(repo: string, n: number, sha: string, title: string, token: string): Promise<void>;
 postComment(repo: string, n: number, body: string, token: string): Promise<number>;
}
