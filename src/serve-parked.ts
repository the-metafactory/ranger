import { isGithubRepo, nodeKey, parseForgeRef } from "./forge-ref.ts";
import { changeRequestLabel, changeRequestNoun, changeRequestUrl, nodeUrl } from "./forge-text.ts";
import type { MergeState } from "./forge.ts";
/**
 * `ranger serve`'s "Needs you" section (node #54): every journal worker row
 * that ended parked or failed, and every awaiting-merge row labelled
 * `ranger:needs-eye`, with what the principal can do next — resume, merge,
 * open a session, open the PR.
 *
 * **The reason class is ranger's own reading, never tracker text.** It comes
 * from the row's outcome, written by the builders in `outcomes.ts`, and from
 * the node's journal events since the row was last put in motion.
 *
 * **Actions stay out of process.** Nothing here writes the journal or the
 * graph: a resume spawns the existing `ranger resume-node` verb, a merge runs
 * `gh` (`glab api` on a GitLab map, node #132) with the machine account's
 * tokens and config dropped, so the CLI uses the login stored under this
 * user's HOME (the principal's, on the principal's machine; nothing here
 * checks which account that is), and a session opens
 * iTerm2 the way the grilling button does, in the map's `localCheckout` only:
 * the worker's worktree belongs to the machine-account clone. A queued resume
 * and its cancel run `ranger resume-node --when-free` / `--cancel` (node
 * #166); the drain lives in serve-drain.ts. Every action is re-checked against the journal as it
 * reads when the request arrives, and the spawner is injected so no test runs
 * `gh`, `osascript` or ranger.
 */
import { classifyGithubCheckRuns } from "./github-ci.ts";
import { REPO_PATTERN } from "./config.ts";
import type { EventRow, ResumeQueueRow, WorkerRow } from "./journal.ts";
import { startsImplementSession, type ImplementLane } from "./lanes.ts";
import { whenFreeQueues } from "./resume.ts";
import { childEnv, itermArgv, shellQuote } from "./launch.ts";
import {
 CRASH_PARK_OUTCOME,
 NEEDS_EYE_LABEL,
 parseFailedProbes,
 PROBE_FILE,
 POLICY_BLOCKED_OUTCOME,
 PROBES_FAILED_OUTCOME,
 REVIEW_CAP_HEAD_MOVED_OUTCOME,
 RESPAWNED_EVENT,
 REVIEW_CAP_OUTCOME,
 SUBSTRATE_CAPPED_OUTCOME,
} from "./outcomes.ts";
import { isTransientGitHubError } from "./transient.ts";

const ID_PATTERN = /^\d+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

// ---- the reason class ----

export type ReasonClass =
 | "review cap"
 | "probes failed"
 | "needs-eye"
 | "transient"
 | "substrate capped"
 | "policy blocked"
 | "worker failed"
 | "other";

export interface Reason {
 class: ReasonClass;
 /** One line, built here from ranger's own numbers. */
 detail: string;
 /** `probes failed`: the names the run's `FAILED:` line gave, else the first run's retry selection. */
 probes?: string[];
}

export interface SageRound {
 round: number;
 sha: string;
 blockers: number;
 majors: number;
}

export interface ProbeResult {
 passed: boolean;
 sha: string;
}

/** The `reviewed` event the implement lane writes per sage round. */
const SAGE_EVENT = /^round (\d+) @ ([0-9a-f]{7,40}): [\w-]+, (\d+) blocker\(s\), (\d+) major\(s\)/;
/** The `reviewed` event the probe tier writes per recorded run. */
const PROBE_EVENT = /^probes (passed|FAILED) at ([0-9a-f]{7,40})/;
/** The first probe run's narrowed retry, which names its failures. */
const PROBE_RETRY_EVENT = /^probe run 1 failed \(exit -?\d+\) — retrying only (.+)$/;

/** The newest sage round in `events` (newest first). */
export function lastSageRound(events: EventRow[]): SageRound | null {
 for (const e of events) {
  if (e.kind !== "reviewed") continue;
  const m = SAGE_EVENT.exec(e.detail ?? "");
  if (m !== null) {
   return { round: Number(m[1]), sha: m[2], blockers: Number(m[3]), majors: Number(m[4]) };
  }
 }
 return null;
}

/** The newest recorded probe run in `events` (newest first). */
export function lastProbe(events: EventRow[]): ProbeResult | null {
 for (const e of events) {
  if (e.kind !== "reviewed") continue;
  const m = PROBE_EVENT.exec(e.detail ?? "");
  if (m !== null) return { passed: m[1] === "passed", sha: m[2] };
 }
 return null;
}

/**
 * The events since the row was last put in motion — a claim, or an
 * operator's `resume-node` — newest first. An earlier run's transient error
 * says nothing about why this one stopped.
 */
function sinceMotion(events: EventRow[]): EventRow[] {
 const out: EventRow[] = [];
 for (const e of events) {
  if (e.kind === "claimed") break;
  if (e.kind === "sweep" && (e.detail ?? "").startsWith("resume-node by operator")) break;
  out.push(e);
 }
 return out;
}

/**
 * The events of the last attempt, newest first: up to the sweep's respawn of
 * a crashed worker. An earlier attempt's transient error says nothing about
 * how the last one ended.
 */
function lastAttempt(recent: EventRow[]): EventRow[] {
 const cut = recent.findIndex((e) => e.kind === "sweep" && RESPAWNED_EVENT.test(e.detail ?? ""));
 return cut === -1 ? recent : recent.slice(0, cut);
}

const firstLine = (text: string): string => text.split("\n")[0].trim();

/**
 * Why a row needs the principal, by ranger's rules, in this order: the review
 * cap, failed probes, a policy-hook stop, a substrate limit, a GitHub-side transient error, then
 * any other failed worker; anything else parked is `other` with the outcome's
 * first line.
 */
export function classifyReason(
 row: Pick<WorkerRow, "status" | "outcome" | "reviewRound">,
 events: EventRow[],
 labels: string[] | null,
 reviewRounds: number,
): Reason {
 if (row.status === "awaiting-merge" && labels?.includes(NEEDS_EYE_LABEL) === true) {
  return { class: "needs-eye", detail: `labelled ${NEEDS_EYE_LABEL}: your eye is the check, and the merge is yours` };
 }
 const outcome = row.outcome ?? "";
 const recent = sinceMotion(events);
 if (REVIEW_CAP_HEAD_MOVED_OUTCOME.test(outcome)) {
  // The counts of the last round belong to the head before the move: the
  // stop is that the current head has no review at all.
  const sage = lastSageRound(recent) ?? lastSageRound(events);
  return {
   class: "review cap",
   detail:
    `review cap of ${reviewRounds} sage round(s) reached and the head moved after the last one: ` +
    (sage === null
     ? "the current head is unreviewed"
     : `the current head is unreviewed (round ${sage.round} read the earlier head ${sage.sha.slice(0, 8)})`),
  };
 }
 if (REVIEW_CAP_OUTCOME.test(outcome)) {
  const sage = lastSageRound(recent) ?? lastSageRound(events);
  const round = sage?.round ?? row.reviewRound;
  return {
   class: "review cap",
   detail:
    sage === null
     ? `review cap of ${reviewRounds} sage round(s) reached`
     : `${sage.majors} major(s) and ${sage.blockers} blocker(s) still open after ${round} sage round(s) (cap ${reviewRounds})`,
  };
 }
 if (PROBES_FAILED_OUTCOME.test(outcome) || /^merge gate failed \(probes\)/.test(outcome)) {
  const probes = parseFailedProbes(outcome);
  if (probes.length > 0) return { class: "probes failed", detail: `failed: ${probes.join(", ")}`, probes };
  // The outcome named none (a cut or a timed-out retry): the first run's
  // failures are what the retry selected, not proof of how the retry ended.
  const retry = recent
   .map((e) => (e.kind === "reviewed" ? PROBE_RETRY_EVENT.exec(e.detail ?? "") : null))
   .find((m) => m !== null);
  const first = retry?.[1].split(",").map((n) => n.trim()).filter((n) => PROBE_FILE.test(n)) ?? [];
  return {
   class: "probes failed",
   detail:
    first.length > 0
     ? `the first run failed ${first.join(", ")}; the retry's own failures are not recorded`
     : "the run named no failed probes",
   probes: first,
  };
 }
 if (POLICY_BLOCKED_OUTCOME.test(outcome)) {
  return { class: "policy blocked", detail: firstLine(outcome).slice(0, 200) };
 }
 if (SUBSTRATE_CAPPED_OUTCOME.test(outcome)) {
  return { class: "substrate capped", detail: firstLine(outcome).slice(0, 200) };
 }
 // An outcome that names its own failure is that failure. Only a crash park,
 // which names none, takes its cause from the last attempt's events.
 if (
  isTransientGitHubError(outcome) ||
  (CRASH_PARK_OUTCOME.test(outcome) && lastAttempt(recent).some((e) => e.kind === "transient"))
 ) {
  // A text match (timeouts, 5xx, connection resets), not a provenance check:
  // it cannot say the error came from GitHub or that the node did nothing
  // wrong, so the detail names the match and keeps the outcome beside it.
  const said = firstLine(outcome).slice(0, 160);
  return {
   class: "transient",
   detail: `reads like a transient network or HTTP error${said ? ` (${said})` : ""}; if that is all it was, resuming usually clears it`,
  };
 }
 if (row.status === "failed") {
  return { class: "worker failed", detail: firstLine(outcome).slice(0, 200) || "no outcome recorded" };
 }
 return { class: "other", detail: firstLine(outcome).slice(0, 200) || "no outcome recorded" };
}

// ---- the entries ----

/** A PR or MR as the dashboard last read it (REST, under the read-only gate). */
export interface PrView {
 number: number;
 url: string;
 state: "open" | "closed";
 merged: boolean;
 draft: boolean;
 headSha: string;
 /** GitHub's mergeability; null while it is still computing. On GitLab, read off `mergeState`. */
 mergeable: boolean | null;
 /** GitLab only: the port's merge state, and GitLab's own word for it. Absent on GitHub. */
 mergeState?: MergeState;
 mergeDetail?: string;
 /** GitLab only: the MR is `locked`, being merged right now. */
 merging?: true;
 /**
  * Check runs on the head: none yet, still running, any failed, all passed
  * but none concluded success, green (all passed, at least one success),
  * unreadable (the check-runs read failed: nothing is known), or not-read (the
  * PR is closed or merged, so its checks are not fetched).
  */
 ci: "none" | "pending" | "failed" | "no-success" | "green" | "unreadable" | "not-read";
 /**
  * Where `ci` came from: the check runs (every check, Actions and external
  * apps alike), or only the Actions workflow runs when the token could not
  * read checks. Actions-only evidence is shown, never merged on: a failing
  * external check would not be in it.
  */
 ciSource?: "checks" | "actions";
 readAt: string;
}

/** The CI display state from the GitHub classifier also used to build the port's merge verdict. */
export function ciState(runs: { status: string; conclusion: string | null }[]): PrView["ci"] {
 return classifyGithubCheckRuns(runs).state;
}

/**
 * The check runs from `gh api --paginate --slurp` (an array of pages), or
 * null when any page is malformed: a dropped page could hide a failure.
 */
export function checkRunsFromPages(raw: unknown): { status: string; conclusion: string | null }[] | null {
 if (!Array.isArray(raw)) return null;
 const runs: { status: string; conclusion: string | null }[] = [];
 for (const page of raw) {
  const list = (page as { check_runs?: unknown } | null)?.check_runs;
  if (!Array.isArray(list)) return null;
  for (const c of list as { status?: unknown; conclusion?: unknown }[]) {
   runs.push({ status: String(c?.status ?? ""), conclusion: typeof c?.conclusion === "string" ? c.conclusion : null });
  }
 }
 return runs;
}

/**
 * The latest workflow run per workflow and event for `sha`, read off a
 * slurped `actions/runs?head_sha=` listing: what a read-only token that is
 * refused check runs can still see (2026-10-05: seelite's fine-grained token
 * was, and the dashboard read every PR's CI as unreadable). Actions runs
 * only: an external app's checks are not in it. Null on any malformed page
 * or a run for another head.
 */
export function workflowRunsFromPages(raw: unknown, sha: string): { status: string; conclusion: string | null }[] | null {
 if (!Array.isArray(raw)) return null;
 const latest = new Map<string, { id: number; status: string; conclusion: string | null }>();
 for (const page of raw) {
  const list = (page as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(list)) return null;
  for (const r of list as Record<string, unknown>[]) {
   if (r?.head_sha !== sha) return null;
   const run = { id: Number(r.id), status: String(r.status ?? ""), conclusion: typeof r.conclusion === "string" ? r.conclusion : null };
   const key = `${String(r.workflow_id)}:${String(r.event)}`;
   const seen = latest.get(key);
   if (seen === undefined || seen.id < run.id) latest.set(key, run);
  }
 }
 return [...latest.values()].map(({ status, conclusion }) => ({ status, conclusion }));
}

/** Why GitLab's merge state offers no tap, or null when it is `mergeable`. */
function mergeStateRefusal(state: MergeState, detail: string | undefined): string | null {
 const said = detail === undefined ? "" : ` (${detail})`;
 switch (state) {
  case "mergeable": return null;
  case "needs-rebase": return `GitLab needs the MR rebased onto its target${said}: the merge desk rebases it, not the dashboard`;
  case "conflict": return `the MR conflicts with its target${said}: the merge desk sends it back for a base merge and a new review round`;
  case "blocked": return `GitLab blocks the merge${said}`;
  case "pending": return `GitLab is still checking whether the MR can merge${said}`;
  case "unknown": return `GitLab's merge status is unknown${said}`;
 }
}

/**
 * Why a PR (an MR on GitLab) cannot be merged from the dashboard, or null
 * when it can. `noun` names an unread one; a read GitLab MR carries its
 * merge state and says MR itself.
 */
export function mergeRefusal(pr: PrView | null, noun: "PR" | "MR" = "PR"): string | null {
 if (pr === null) return `the ${noun} has not been read yet`;
 if (pr.mergeState !== undefined) return mrRefusal(pr, pr.mergeState);
 if (pr.merged) return "the PR is already merged";
 if (pr.state !== "open") return "the PR is closed";
 if (pr.draft) return "the PR is a draft: mark it ready first";
 if (pr.mergeable !== true) {
  return pr.mergeable === null
   ? "GitHub is still computing mergeability"
   : "the PR conflicts with its base: the merge desk sends it back for a base merge and a new review round";
 }
 if (!SHA_PATTERN.test(pr.headSha)) return "the PR head is unknown";
 if (pr.ci === "no-success") return "no check run concluded success (all neutral/skipped): the close has nothing to cite";
 if (pr.ci === "unreadable") return "the check runs could not be read";
 if (pr.ci !== "green") return `CI is ${pr.ci}`;
 return null;
}

/** `mergeRefusal` for a GitLab MR: any merge state but `mergeable` offers no tap. */
function mrRefusal(mr: PrView, state: MergeState): string | null {
 if (mr.merged) return "the MR is already merged";
 if (mr.merging) return "GitLab is merging the MR now";
 if (mr.state !== "open") return "the MR is closed";
 if (mr.draft) return "the MR is a draft: mark it ready first";
 const held = mergeStateRefusal(state, mr.mergeDetail);
 if (held !== null) return held;
 if (!SHA_PATTERN.test(mr.headSha)) return "the MR head is unknown";
 if (mr.ci === "unreadable") return "the pipeline could not be read";
 if (mr.ci !== "green") return `the pipeline is ${mr.ci}`;
 return null;
}

/** The GitLab merge states the merge desk acts on: a send-back, or a rebase. */
export const DESK_MERGE_STATES: readonly MergeState[] = ["conflict", "needs-rebase"];

export interface NeedsYouMap {
 key: string;
 repo: string;
 root: number;
 /** The map's implement lane; unset offers no queued resume. */
 lane?: ImplementLane;
 localCheckout?: string;
}

export interface NeedsYouEntry {
 /** The map's `owner/name#root`. */
 key: string;
 repo: string;
 root: number;
 nodeId: string;
 title: string | null;
 url: string;
 status: "parked" | "failed" | "awaiting-merge";
 endedAt: string | null;
 reason: Reason;
 /**
  * `error`: the last failed read of the PR, while `view` is unread.
  * `label` names it in its forge's words, "PR #N" or "MR !N" (node #132).
  */
 pr: { number: number; url: string; label: string; noun: "PR" | "MR"; view: PrView | null; error: string | null } | null;
 /** The map's forge: the page words a GitLab card's merge and link by it. */
 forge: "github" | "gitlab";
 sage: SageRound | null;
 /**
  * Whether the last sage round read the PR's current head: false when the
  * head moved after it (its counts belong to an earlier head), null when
  * there is no round or no PR read to compare.
  */
 sageOnHead: boolean | null;
 probe: ProbeResult | null;
 /** Its place in its lane's resume queue (node #166), 1 = the head; null when not queued. */
 queued: { lane: ImplementLane; position: number } | null;
 actions: {
  resume: boolean;
  merge: { offered: true; headSha: string } | { offered: false; why: string };
  session: { offered: true; cwd: string } | { offered: false; why: string };
  /** `resume-node --when-free`: offered only where that verb would queue rather than start. */
  queueResume: { offered: true } | { offered: false; why: string };
  /** `resume-node --cancel`: offered while the node is queued. */
  cancelResume: boolean;
 };
}

export interface NeedsYouInputs {
 maps: NeedsYouMap[];
 workers: WorkerRow[];
 /** A node's events, newest first. */
 events: (repo: string, nodeId: string) => EventRow[];
 /** The issue's labels as last read, null when not read yet. */
 labels: (repo: string, nodeId: string) => string[] | null;
 prs: (repo: string, pr: number) => PrView | null;
 /** The last failed read of a PR, null when none failed. */
 prError?: (repo: string, pr: number) => string | null;
 titleOf: (repo: string, nodeId: string) => string | null;
 reviewRounds: number;
 exists: (path: string) => boolean;
 /** The journal's resume queue, every lane, FIFO (node #166); absent means empty. */
 resumeQueue?: ResumeQueueRow[];
 /** Each implement lane's holder now; absent means both are free. */
 laneHolders?: Partial<Record<ImplementLane, { repo: string; nodeId: string } | null>>;
}

/** One queued resume as the dashboard shows it, at its FIFO place in its lane. */
export interface QueuedResumeView {
 /** The map's `owner/name#root`. */
 key: string;
 repo: string;
 root: number;
 nodeId: string;
 title: string | null;
 url: string;
 lane: ImplementLane;
 /** 1 = the lane's head. */
 position: number;
 queuedAt: string;
 failedStarts: number;
}

/** The resume queue per lane, each in FIFO order (the journal lists it by id). */
export function resumeQueueViews(
 queue: ResumeQueueRow[],
 titleOf: (repo: string, nodeId: string) => string | null,
): Record<ImplementLane, QueuedResumeView[]> {
 const out: Record<ImplementLane, QueuedResumeView[]> = { visual: [], headless: [] };
 for (const e of queue) {
  out[e.lane].push({
   key: nodeKey(e.repo, e.root),
   repo: e.repo,
   root: e.root,
   nodeId: e.nodeId,
   title: titleOf(e.repo, e.nodeId),
   url: nodeUrl(e.repo, e.nodeId),
   lane: e.lane,
   position: out[e.lane].length + 1,
   queuedAt: e.queuedAt,
   failedStarts: e.failedStarts,
  });
 }
 return out;
}

/**
 * Whether `resume-node --when-free` would queue this row, by the verb's own
 * `whenFreeQueues`. Anywhere else the verb starts the resume at once, so the
 * button would be a Resume under another name.
 */
function queueOffer(
 row: WorkerRow,
 map: NeedsYouMap,
 queued: boolean,
 inputs: NeedsYouInputs,
): NeedsYouEntry["actions"]["queueResume"] {
 if (queued) return { offered: false, why: "already queued" };
 if (map.lane === undefined) return { offered: false, why: "the map's implement lane is unknown" };
 if (!startsImplementSession(row)) return { offered: false, why: "takes no implement lane: Resume starts it now" };
 const holder = inputs.laneHolders?.[map.lane] ?? null;
 const lane = {
  // The verb's lane read leaves the node itself out.
  held: holder !== null && !(holder.repo === row.repo && holder.nodeId === row.nodeId),
  queued: false,
  backlog: (inputs.resumeQueue ?? []).filter((e) => e.lane === map.lane).length,
 };
 if (!whenFreeQueues(row, lane)) return { offered: false, why: `the ${map.lane} lane is free: Resume starts it now` };
 return { offered: true };
}

/** Each queued node's lane and FIFO place in it (1 = the head), by `repo#id`: the lane list's own places. */
function queuePlaces(queue: ResumeQueueRow[]): Map<string, { lane: ImplementLane; position: number }> {
 const places = new Map<string, { lane: ImplementLane; position: number }>();
 for (const views of Object.values(resumeQueueViews(queue, () => null))) {
  for (const v of views) places.set(nodeKey(v.repo, v.nodeId), { lane: v.lane, position: v.position });
 }
 return places;
}

/** The rows that wait on the principal, newest first. */
export function needsYouEntries(inputs: NeedsYouInputs): NeedsYouEntry[] {
 return rowEntries(inputs, (row, labels) =>
  row.status === "parked" ||
  row.status === "failed" ||
  (row.status === "awaiting-merge" && labels?.includes(NEEDS_EYE_LABEL) === true));
}

/**
 * Every awaiting-merge row on a served map, needs-eye or not: the Current
 * job's "Merge now". The merge is the principal's either way; needs-eye only
 * says the principal's eye is the check.
 */
export function awaitingMergeEntries(inputs: NeedsYouInputs): NeedsYouEntry[] {
 return rowEntries(inputs, (row) => row.status === "awaiting-merge");
}

function rowEntries(
 inputs: NeedsYouInputs,
 include: (row: WorkerRow, labels: string[] | null) => boolean,
): NeedsYouEntry[] {
 const out: NeedsYouEntry[] = [];
 const placeOf = queuePlaces(inputs.resumeQueue ?? []);
 for (const row of inputs.workers) {
  const map = inputs.maps.find((m) => m.repo === row.repo && m.root === row.root);
  if (map === undefined) continue;
  const labels = inputs.labels(row.repo, row.nodeId);
  if (!include(row, labels)) continue;
  const waiting = row.status === "parked" || row.status === "failed";
  const events = inputs.events(row.repo, row.nodeId);
  const view = row.prNumber === null ? null : inputs.prs(row.repo, row.prNumber);
  const sage = lastSageRound(events);
  const noun = changeRequestNoun(row.repo);
  const refused = row.prNumber === null ? `no ${noun}` : mergeRefusal(view, noun);
  // Only the principal's checkout, never the worker's worktree: that is a
  // worktree of the machine-account clone, whose files and git hooks the
  // worker controls (`servedMaps` refuses those clones for the same reason).
  const cwd = map.localCheckout !== undefined && inputs.exists(map.localCheckout) ? map.localCheckout : undefined;
  const place = placeOf.get(nodeKey(row.repo, row.nodeId));
  out.push({
   key: map.key,
   repo: row.repo,
   root: row.root,
   nodeId: row.nodeId,
   title: inputs.titleOf(row.repo, row.nodeId),
   url: nodeUrl(row.repo, row.nodeId),
   status: row.status as NeedsYouEntry["status"],
   endedAt: row.finishedAt,
   reason: classifyReason(row, events, labels, inputs.reviewRounds),
   pr:
    row.prNumber === null
     ? null
     : {
        number: row.prNumber,
        url: changeRequestUrl(row.repo, row.prNumber, view?.url),
        label: changeRequestLabel(row.repo, row.prNumber),
        noun,
        view,
        error: inputs.prError?.(row.repo, row.prNumber) ?? null,
       },
   forge: parseForgeRef(row.repo).forge,
   sage,
   sageOnHead: sage === null || view === null || view.headSha === "" ? null : view.headSha.startsWith(sage.sha),
   probe: lastProbe(events),
   queued: place ?? null,
   actions: {
    resume: waiting,
    queueResume: waiting ? queueOffer(row, map, place !== undefined, inputs) : { offered: false, why: `#${row.nodeId} is ${row.status}, not parked or failed` },
    cancelResume: place !== undefined,
    merge:
     refused === null && view !== null
      ? { offered: true, headSha: view.headSha }
      : { offered: false, why: refused ?? `no ${noun}` },
    session:
     cwd === undefined
      ? {
         offered: false,
         why:
          map.localCheckout === undefined
           ? "the map has no localCheckout (the worker's worktree is the machine account's, never a session's)"
           : `${map.localCheckout} does not exist`,
        }
      : { offered: true, cwd },
   },
  });
 }
 return out.sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
}

/**
 * The awaiting-merge rows on a served map whose labels are not known —
 * unread yet, or the read failed — as `repo#id`. Any of them may need the
 * principal's eye, so the section never says "nothing waits" while one is
 * left.
 */
export function uncheckedNeedsEye(inputs: Pick<NeedsYouInputs, "maps" | "workers" | "labels">): string[] {
 return inputs.workers
  .filter(
   (row) =>
    row.status === "awaiting-merge" &&
    inputs.maps.some((m) => m.repo === row.repo && m.root === row.root) &&
    inputs.labels(row.repo, row.nodeId) === null,
  )
  .map((row) => nodeKey(row.repo, row.nodeId));
}

// ---- the actions ----

export type ActionKind = "resume" | "merge" | "session" | "queue-resume" | "cancel-resume";

export interface ActionResult {
 /** The child's exit code; null when it could not start or timed out. */
 code: number | null;
 /** The tail of its stderr (or the spawn error). */
 stderr: string;
 /**
  * Settles when the child has actually exited. A timed-out result answers the
  * page early, but the child may still be running, and the node's in-flight
  * hold lasts until this settles. Absent means the child is already gone.
  */
 exited?: Promise<void>;
}

/** Spawns a child and resolves with its exit; injected so tests run nothing. */
export type ActionRunner = (
 argv: string[],
 env: Record<string, string>,
 opts: { detached: boolean },
) => Promise<ActionResult>;

/** Keys a human merge must never carry: machine credentials or forge overrides. */
export { MACHINE_FORGE_KEYS } from "./forge-env.ts";
import { MACHINE_FORGE_KEYS } from "./forge-env.ts";
/** @deprecated Use MACHINE_FORGE_KEYS; this alias includes GitLab keys. */
export const MACHINE_GH_KEYS = MACHINE_FORGE_KEYS;

/**
 * The merge's environment: the launch allowlist, and none of the machine
 * account's forge keys, so the CLI uses the login stored under HOME. What this
 * proves is the absence of the machine account's credential, not whose login
 * HOME holds.
 */
export function mergeEnv(env: Record<string, string | undefined>): Record<string, string> {
 const out = childEnv(env);
 for (const key of MACHINE_FORGE_KEYS) delete out[key];
 return out;
}

/**
 * `gh pr merge`, squash, pinned to the head the principal confirmed. On
 * GitLab, the merge endpoint under the principal's glab login (ranger issue
 * #97 ruling Q6), squashed and pinned the same way: `sha` makes GitLab refuse
 * a head that moved.
 */
export function mergeArgv(args: { repo: string; pr: number; sha: string }): string[] {
 if (!REPO_PATTERN.test(args.repo)) throw new Error(`bad repo: ${args.repo}`);
 if (!Number.isInteger(args.pr) || args.pr <= 0) throw new Error(`bad PR: ${args.pr}`);
 if (!SHA_PATTERN.test(args.sha)) throw new Error(`bad head SHA: ${args.sha}`);
 if (!isGithubRepo(args.repo)) {
  const ref = parseForgeRef(args.repo);
  return [
   "glab", "api", "--hostname", ref.host, "-X", "PUT",
   `projects/${encodeURIComponent(ref.path)}/merge_requests/${args.pr}/merge`,
   "-f", "squash=true", "-f", `sha=${args.sha}`,
  ];
 }
 return ["gh", "pr", "merge", String(args.pr), "--repo", args.repo, "--squash", "--match-head-commit", args.sha];
}

/**
 * `ranger resume-node`, the operator verb: it resets the row and detaches
 * run-node itself. `queue` makes it `--when-free` (queue while the lane is
 * held) or `--cancel` (drop the queued entry), node #166.
 */
export function resumeArgv(args: {
 rangerBin: string;
 configPath: string;
 repo: string;
 root: number;
 nodeId: string;
 force: boolean;
 queue?: "when-free" | "cancel";
}): string[] {
 if (!REPO_PATTERN.test(args.repo)) throw new Error(`bad repo: ${args.repo}`);
 if (!ID_PATTERN.test(args.nodeId)) throw new Error(`bad node id: ${args.nodeId}`);
 if (!Number.isInteger(args.root) || args.root <= 0) throw new Error(`bad root: ${args.root}`);
 if (args.force && args.queue !== undefined) throw new Error(`--force and --${args.queue} are mutually exclusive`);
 return [
  args.rangerBin,
  "resume-node",
  args.nodeId,
  "--map",
  nodeKey(args.repo, args.root),
  "-c",
  args.configPath,
  ...(args.force ? ["--force"] : []),
  ...(args.queue === undefined ? [] : [`--${args.queue}`]),
 ];
}

/**
 * The merge desk's own gate for one node, run before a dashboard merge of an
 * awaiting-merge row: the dashboard reads CI and mergeability, but not
 * ranger's review and probe records at the head, which the desk holds a
 * merge card behind.
 */
export function gateArgv(args: { rangerBin: string; configPath: string; repo: string; root: number; nodeId: string; sha: string }): string[] {
 if (!REPO_PATTERN.test(args.repo)) throw new Error(`bad repo: ${args.repo}`);
 if (!ID_PATTERN.test(args.nodeId)) throw new Error(`bad node id: ${args.nodeId}`);
 if (!Number.isInteger(args.root) || args.root <= 0) throw new Error(`bad root: ${args.root}`);
 if (!SHA_PATTERN.test(args.sha)) throw new Error(`bad head SHA: ${args.sha}`);
 return [args.rangerBin, "merge-gate", args.nodeId, "--map", `${args.repo}#${args.root}`, "--sha", args.sha, "-c", args.configPath];
}

/**
 * One map's merge desk, run right after a dashboard merge: the merged node
 * starts its close now instead of on the next tick.
 */
export function deskArgv(args: { rangerBin: string; configPath: string; repo: string; root: number; settle?: boolean }): string[] {
 if (!REPO_PATTERN.test(args.repo)) throw new Error(`bad repo: ${args.repo}`);
 if (!Number.isInteger(args.root) || args.root <= 0) throw new Error(`bad root: ${args.root}`);
 return [args.rangerBin, "merge-desk", "--map", `${args.repo}#${args.root}`, ...(args.settle ? ["--settle"] : []), "-c", args.configPath];
}

/**
 * The session the principal opens on a parked node. The prompt carries the
 * repo, the id and the reason class only: the session reads the node, the
 * PR and the journal itself.
 */
export function sessionPlan(args: {
 repo: string;
 nodeId: string;
 reason: ReasonClass;
 cwd: string;
}): { prompt: string; shellCommand: string; argv: string[] } {
 if (!REPO_PATTERN.test(args.repo)) throw new Error(`bad repo: ${args.repo}`);
 if (!ID_PATTERN.test(args.nodeId)) throw new Error(`bad node id: ${args.nodeId}`);
 const prompt =
  `Node #${args.nodeId} on ${args.repo} stopped and needs me (ranger's reason: ${args.reason}). ` +
  `Read the node with \`soma graph node ${args.nodeId} --repo ${args.repo}\`, its PR, and ranger's ` +
  `journal for it (\`ranger journal --repo ${args.repo}\`), then tell me what the next step is.`;
 const shellCommand = `cd ${shellQuote(args.cwd)} && claude ${shellQuote(prompt)}`;
 return { prompt, shellCommand, argv: itermArgv(shellCommand) };
}

export interface ActionBody {
 key?: unknown;
 id?: unknown;
 force?: unknown;
 sha?: unknown;
 dryRun?: unknown;
}

export interface ActionDeps {
 /** The entries as the journal reads now: "Needs you", and every awaiting-merge row. */
 entries: NeedsYouEntry[];
 /** Every queued resume as the journal reads now, all lanes: what a cancel may name. */
 queue?: QueuedResumeView[];
 run: ActionRunner;
 env: Record<string, string | undefined>;
 rangerBin: string;
 configPath: string | undefined;
 /** Read the PR live before a merge; null when it cannot be read. */
 readPr: (repo: string, pr: number) => Promise<PrView | null>;
 /**
  * Every check run on `sha`, read under the merge's own environment (the
  * `gh` account stored under HOME, machine credentials removed): the CI
  * state, or null when it cannot be read. Used when the dashboard's
  * read-only token saw only the Actions runs, and before every GitLab merge
  * (the pipeline verdict, under the principal's glab login).
  */
 verifyChecks?: (repo: string, sha: string, env: Record<string, string>) => Promise<PrView["ci"] | null>;
 exists: (path: string) => boolean;
 /**
  * Nodes with an action running now (`repo#id`), owned by the server. Held
  * from the row check until the child returns: the journal only shows a
  * resumed row as claimed once `resume-node` has written it, so two clicks
  * inside that window would otherwise both pass the parked check.
  */
 inFlight: Set<string>;
}

export interface ActionResponse {
 status: number;
 body: Record<string, unknown>;
 /** The entry acted on, when the action ran. */
 entry?: NeedsYouEntry;
 /** The child's real exit (see `ActionResult.exited`); never sent to the page. */
 exited?: Promise<void>;
}

export const refusal = (status: number, error: string): ActionResponse => ({ status, body: { error } });

/** Serve has no config path to hand the verb. */
export const noConfigPath = (what: string): ActionResponse => refusal(409, `serve was started without a config path to ${what} with`);

const tailOf = (text: string): string => text.trim().slice(-1500);

/**
 * One action, guarded: a numeric id naming a row the journal holds in the
 * action's state now, then the action's own checks. The caller has already
 * checked the Host, the Origin and the page token.
 */
export async function runAction(
 kind: ActionKind,
 body: ActionBody,
 deps: ActionDeps,
): Promise<ActionResponse> {
 if (typeof body.key !== "string" || typeof body.id !== "string") {
  return refusal(400, "key and id are required strings");
 }
 if (!ID_PATTERN.test(body.id)) return refusal(400, "id must be numeric");
 if (kind === "cancel-resume") {
  // A queued entry may outlive its row's parked state, so a cancel names the queue, not the card.
  const queued = deps.queue?.find((q) => q.key === body.key && q.nodeId === body.id);
  if (queued === undefined) return refusal(404, `#${body.id} has no queued resume on ${body.key}`);
  return holdingNode(deps, queued.repo, queued.nodeId, () => runCancel(queued, body, deps));
 }
 const entry = deps.entries.find((e) => e.key === body.key && e.nodeId === body.id);
 if (entry === undefined) {
  return refusal(404, `#${body.id} is not parked, failed or awaiting a merge on ${body.key}`);
 }
 return holdingNode(deps, entry.repo, entry.nodeId, () => runHeldAction(kind, body, deps, entry));
}

const holdingNode = (deps: Pick<ActionDeps, "inFlight">, repo: string, nodeId: string, act: () => Promise<ActionResponse>) =>
 holding(deps.inFlight, nodeKey(repo, nodeId), `an action on #${nodeId} is already running: wait for it, then reload`, act);

/**
 * Runs `act` holding `held` in the server's in-flight set, or refuses with
 * `busy` while another action holds it.
 */
export async function holding(
 inFlight: Set<string>,
 held: string,
 busy: string,
 act: () => Promise<ActionResponse>,
): Promise<ActionResponse> {
 if (inFlight.has(held)) return refusal(409, busy);
 inFlight.add(held);
 let exited: Promise<void> | undefined;
 try {
  const response = await act();
  exited = response.exited;
  return response;
 } finally {
  // Held until the child exits, not until the page is answered: a resume
  // that outlives the HTTP timeout must still refuse a second one.
  if (exited === undefined) inFlight.delete(held);
  else void exited.finally(() => inFlight.delete(held));
 }
}

/** The page's view of a verb's exit: its code and the tail of its stderr. */
export const verbResult = (action: string, result: ActionResult, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
 action,
 ...extra,
 ok: result.code === 0,
 code: result.code,
 stderr: tailOf(result.stderr),
});

/** `resume-node <id> --when-free` or `--cancel`, or the refusal when serve has no config path. */
function queuedResumeArgv(
 deps: Pick<ActionDeps, "rangerBin" | "configPath">,
 target: { repo: string; root: number; nodeId: string },
 queue: "when-free" | "cancel",
): string[] | ActionResponse {
 if (deps.configPath === undefined) return noConfigPath(queue === "cancel" ? "cancel" : "resume");
 return resumeArgv({
  rangerBin: deps.rangerBin,
  configPath: deps.configPath,
  repo: target.repo,
  root: target.root,
  nodeId: target.nodeId,
  force: false,
  queue,
 });
}

/** `resume-node <id> --cancel`: the verb drops the entry, or refuses and changes nothing. */
async function runCancel(queued: QueuedResumeView, body: ActionBody, deps: ActionDeps): Promise<ActionResponse> {
 const argv = queuedResumeArgv(deps, queued, "cancel");
 if (!Array.isArray(argv)) return argv;
 return runOperatorVerb(argv, body.dryRun, deps, "cancel-resume", { nodeId: queued.nodeId });
}

/**
 * One operator verb for the page: a dry run answers with its argv and the
 * env keys it would pass; otherwise it runs and answers with its exit.
 */
export async function runOperatorVerb(
 argv: string[],
 dryRun: unknown,
 deps: Pick<ActionDeps, "run" | "env">,
 action: string,
 extra: Record<string, unknown> = {},
 detached = false,
): Promise<ActionResponse> {
 const env = childEnv(deps.env);
 if (dryRun === true) return { status: 200, body: { dryRun: true, argv, envKeys: Object.keys(env).sort() } };
 const result = await deps.run(argv, env, { detached });
 return { status: 200, body: verbResult(action, result, extra), exited: result.exited };
}

async function runHeldAction(
 kind: ActionKind,
 body: ActionBody,
 deps: ActionDeps,
 entry: NeedsYouEntry,
): Promise<ActionResponse> {
 let argv: string[];
 let env: Record<string, string>;
 let detached = false;
 let gate: string[] | null = null;
 if (kind === "resume") {
  if (!entry.actions.resume) return refusal(409, `#${entry.nodeId} is ${entry.status}, not parked or failed`);
  if (deps.configPath === undefined) return refusal(409, "serve was started without a config path to resume with");
  argv = resumeArgv({
   rangerBin: deps.rangerBin,
   configPath: deps.configPath,
   repo: entry.repo,
   root: entry.root,
   nodeId: entry.nodeId,
   force: body.force === true,
  });
  // The wrapper resolves the machine account's tokens itself; nothing ambient goes along.
  env = childEnv(deps.env);
  detached = true;
 } else if (kind === "queue-resume") {
  if (!entry.actions.queueResume.offered) return refusal(409, entry.actions.queueResume.why);
  const queued = queuedResumeArgv(deps, entry, "when-free");
  if (!Array.isArray(queued)) return queued;
  argv = queued;
  env = childEnv(deps.env);
  // The lane may have freed since the page read it: the verb then starts the resume, as a Resume does.
  detached = true;
 } else if (kind === "merge") {
  if (!entry.actions.merge.offered) return refusal(409, entry.actions.merge.why);
  const pr = entry.pr as NonNullable<NeedsYouEntry["pr"]>;
  if (typeof body.sha !== "string" || body.sha !== entry.actions.merge.headSha) {
   return refusal(409, `the confirmed head SHA is not the ${pr.noun}'s head: reload and confirm again`);
  }
  let live: PrView | null;
  try {
   live = await deps.readPr(entry.repo, pr.number);
  } catch (error) {
   return refusal(502, `could not read ${pr.label} live: ${error instanceof Error ? error.message : String(error)}`);
  }
  const stale = mergeRefusal(live, pr.noun);
  // GitLab's blocked or unknown is nothing the desk fixes; a conflict or a rebase is.
  const deskFixes = live?.mergeState === undefined || DESK_MERGE_STATES.includes(live.mergeState);
  if (stale !== null && live?.mergeable === false && deskFixes && live.state === "open" && entry.status === "awaiting-merge" && deps.configPath !== undefined) {
   // A conflict the page had not seen yet (another merge moved the base):
   // the desk's send-back fixes it, so run the desk now, not on the next tick.
   const desk = await deps.run(
    deskArgv({ rangerBin: deps.rangerBin, configPath: deps.configPath, repo: entry.repo, root: entry.root }),
    childEnv(deps.env),
    { detached: true },
   );
   return {
    ...refusal(409, `read live: ${stale}${desk.code === 0 ? " (the merge desk ran now)" : `; the merge desk failed (exit ${desk.code ?? "none"}): ${tailOf(desk.stderr)}`}`),
    entry,
    exited: desk.exited,
   };
  }
  if (stale !== null) return refusal(409, `read live: ${stale}`);
  if ((live as PrView).headSha !== body.sha) {
   return refusal(409, `the ${pr.noun} head moved since the page read it: reload and confirm again`);
  }
  env = mergeEnv(deps.env);
  if (entry.forge === "gitlab") {
   // The merge runs under the principal's glab login, not the read token the
   // card was built with: the pipeline verdict at this head is re-read under
   // that same login first, and only green merges.
   const pipeline = deps.verifyChecks === undefined ? null : await deps.verifyChecks(entry.repo, body.sha, env);
   if (pipeline === null) return refusal(409, "the pipeline could not be read under your glab login: merge it on GitLab");
   if (pipeline !== "green") return refusal(409, `the pipeline at ${body.sha.slice(0, 8)}, read under your glab login, is ${pipeline}`);
  } else if ((live as PrView).ciSource === "actions") {
   // The dashboard's token saw only the Actions runs: an external app's
   // failing check would not be in them. Before merging, every check is read
   // under the same gh account the merge itself runs as.
   const full = deps.verifyChecks === undefined ? null : await deps.verifyChecks(entry.repo, body.sha, env);
   if (full === null) {
    return refusal(409, "only the Actions runs were readable, and every check could not be read under your login: merge it on GitHub");
   }
   if (full !== "green") return refusal(409, `every check, read under your login: CI is ${full}`);
  }
  argv = mergeArgv({ repo: entry.repo, pr: pr.number, sha: body.sha });
  // An awaiting-merge row merges only past the desk's full gate. A parked or
  // failed row is the principal's override (a review-cap park hands
  // good-enough over), so it keeps the CI-and-mergeable check alone.
  if (entry.status === "awaiting-merge") {
   if (deps.configPath === undefined) return refusal(409, "serve was started without a config path: the merge desk's gate cannot run");
   gate = gateArgv({ rangerBin: deps.rangerBin, configPath: deps.configPath, repo: entry.repo, root: entry.root, nodeId: entry.nodeId, sha: body.sha });
  }
 } else {
  if (!entry.actions.session.offered) return refusal(409, entry.actions.session.why);
  const cwd = entry.actions.session.cwd;
  if (!deps.exists(cwd)) return refusal(409, `${cwd} no longer exists`);
  argv = sessionPlan({ repo: entry.repo, nodeId: entry.nodeId, reason: entry.reason.class, cwd }).argv;
  env = childEnv(deps.env);
 }
 // A merged PR closes through the merge desk, which watches awaiting-merge
 // and parked rows: run it for this map now. A failed row is not watched;
 // its close takes a Resume.
 const close =
  kind === "merge" && entry.status !== "failed" && deps.configPath !== undefined
   ? deskArgv({ rangerBin: deps.rangerBin, configPath: deps.configPath, repo: entry.repo, root: entry.root })
   : null;
 if (body.dryRun === true) {
  return {
   status: 200,
   body: { dryRun: true, argv, envKeys: Object.keys(env).sort(), ...(gate === null ? {} : { gateArgv: gate }), ...(close === null ? {} : { closeArgv: close }) },
  };
 }
 if (gate !== null) {
  // The wrapper resolves the machine account's read credential itself.
  const checked = await deps.run(gate, childEnv(deps.env), { detached: false });
  if (checked.code !== 0) {
   return refusal(409, `the merge desk's gate holds it: ${tailOf(checked.stderr) || `merge-gate exit ${checked.code ?? "none"}`}`);
  }
 }
 const result = await deps.run(argv, env, { detached });
 const out = verbResult(kind, result, { nodeId: entry.nodeId });
 let exited = result.exited;
 if (close !== null && result.code === 0) {
  // The wrapper resolves the machine account's tokens itself, as for a resume.
  const desk = await deps.run(close, childEnv(deps.env), { detached: true });
  out.close = { ok: desk.code === 0, code: desk.code, stderr: tailOf(desk.stderr) };
  // The merge moved the base under the map's other waiting PRs, and GitHub
  // recomputes their mergeability lazily: a second pass waits for it, so a
  // PR that now conflicts goes back for its base merge without a tick. The
  // page is not kept waiting for it; the node stays held until it ends.
  const settle = deps.run(
   deskArgv({ rangerBin: deps.rangerBin, configPath: deps.configPath as string, repo: entry.repo, root: entry.root, settle: true }),
   childEnv(deps.env),
   { detached: true },
  );
  exited = Promise.all([result.exited, desk.exited, settle.then((r) => r.exited)]).then(() => undefined);
 }
 return { status: 200, body: out, entry, exited };
}
