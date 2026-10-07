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
 | { state: "green"; runId: number; runName: string; snapshot: string }
 | { state: "red" | "pending"; reason: string };

export interface IssueComment {
 id: number;
 author: string;
 body: string;
}

export interface ForgePort {
 findPrByHead(repo: string, branch: string, token: string): Promise<ChangeRequest | null>;
 getPr(repo: string, n: number, token: string): Promise<ChangeRequest>;
 createDraftPr(repo: string, pr: { head: string; base: string; title: string; body: string }, token: string): Promise<ChangeRequest>;
 updatePrBody(repo: string, n: number, body: string, token: string): Promise<void>;
 markReady(repo: string, pr: ChangeRequest, token: string): Promise<void>;
 ciVerdictFor(repo: string, sha: string, token: string, purpose?: CiPurpose): Promise<CiVerdict>;
 mergePr(repo: string, n: number, sha: string, title: string, token: string): Promise<void>;
 issueLabels(repo: string, n: number, token: string): Promise<string[]>;
 postComment(repo: string, n: number, body: string, token: string): Promise<number>;
 listComments(repo: string, n: number, token: string): Promise<IssueComment[]>;
}
