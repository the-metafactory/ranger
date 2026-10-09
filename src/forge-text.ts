import { parseForgeRef, type ForgeRef } from "./forge-ref.ts";

/**
 * How ranger names a change request, a node and CI evidence in human-facing
 * text, in its forge's own words (node #129): "PR #N" and github.com URLs on
 * GitHub, "MR !N" and GitLab's `/-/` URLs on GitLab. On GitLab `#N` names an
 * issue, so an MR is never written that way. Nodes are issues on both forges
 * and keep `#N`. This is the only module that builds a forge URL by hand; an
 * API `web_url` wins whenever one is at hand. Imports only `forge-ref.ts`:
 * `serve.ts` reaches it, and its import graph stays free of graph writes.
 */

type Repo = ForgeRef | string;

const refOf = (repo: Repo): ForgeRef => typeof repo === "string" ? parseForgeRef(repo) : repo;
const base = (ref: ForgeRef) => `https://${ref.host}/${ref.path}`;
const prefer = (webUrl: string | undefined, built: () => string) => webUrl !== undefined && webUrl.length > 0 ? webUrl : built();

export function forgeName(repo: Repo): "GitHub" | "GitLab" {
 return refOf(repo).forge === "github" ? "GitHub" : "GitLab";
}

export function changeRequestNoun(repo: Repo): "PR" | "MR" {
 return refOf(repo).forge === "github" ? "PR" : "MR";
}

/** `#N` on GitHub, `!N` on GitLab. */
export function changeRequestRef(repo: Repo, iid: number | string): string {
 return `${refOf(repo).forge === "github" ? "#" : "!"}${iid}`;
}

/** "PR #N" on GitHub, "MR !N" on GitLab. */
export function changeRequestLabel(repo: Repo, iid: number | string): string {
 return `${changeRequestNoun(repo)} ${changeRequestRef(repo, iid)}`;
}

export function changeRequestUrl(repo: Repo, iid: number | string, webUrl?: string): string {
 const ref = refOf(repo);
 return prefer(webUrl, () => ref.forge === "github" ? `${base(ref)}/pull/${iid}` : `${base(ref)}/-/merge_requests/${iid}`);
}

/** A graph node is a tracker issue on both forges. */
export function nodeUrl(repo: Repo, iid: number | string, webUrl?: string): string {
 const ref = refOf(repo);
 return prefer(webUrl, () => ref.forge === "github" ? `${base(ref)}/issues/${iid}` : `${base(ref)}/-/issues/${iid}`);
}

/** A comment on a node, under the node's URL: GitHub's issue-comment anchor, GitLab's note anchor. */
export function nodeCommentUrl(repo: Repo, nodeWebUrl: string, commentId: number | string): string {
 return `${nodeWebUrl}${refOf(repo).forge === "github" ? "#issuecomment-" : "#note_"}${commentId}`;
}

/** The CI evidence pointer: a GitHub check run, a GitLab pipeline. */
export function ciRunUrl(repo: Repo, runId: number, webUrl?: string): string {
 const ref = refOf(repo);
 return prefer(webUrl, () => ref.forge === "github" ? `${base(ref)}/runs/${runId}` : `${base(ref)}/-/pipelines/${runId}`);
}

/** What one CI run is called: a check run on GitHub, a pipeline on GitLab. */
export function ciRunNoun(repo: Repo): "check run" | "pipeline" {
 return refOf(repo).forge === "github" ? "check run" : "pipeline";
}

/**
 * One green CI run in a sentence. `receipt` is the close resolution's form
 * (GitHub: `check run "build" (901)`), `summary` the evidence line's
 * (`check run build`); GitLab names the pipeline by its id in both.
 */
export function ciRunText(repo: Repo, run: { runId: number; runName: string }, style: "receipt" | "summary"): string {
 if (refOf(repo).forge === "gitlab") return `pipeline ${run.runId}`;
 return style === "receipt" ? `check run "${run.runName}" (${run.runId})` : `check run ${run.runName}`;
}
