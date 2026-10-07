import { isGithubRepo, nodeKey } from "./forge-ref.ts";
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
 * `gh` with the machine account's token and config dropped, so gh uses the
 * login stored under this user's HOME (the principal's, on the principal's
 * machine; nothing here checks which account that is), and a session opens
 * iTerm2 the way the grilling button does, in the map's `localCheckout` only:
 * the worker's worktree belongs to the machine-account clone. Every action is re-checked against the journal as it
 * reads when the request arrives, and the spawner is injected so no test runs
 * `gh`, `osascript` or ranger.
 */
import { classifyCi } from "./ci-policy.ts";
import { REPO_PATTERN } from "./config.ts";
import type { EventRow, WorkerRow } from "./journal.ts";
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

/** A PR as the dashboard last read it (REST, under the read-only gate). */
export interface PrView {
 number: number;
 url: string;
 state: "open" | "closed";
 merged: boolean;
 draft: boolean;
 headSha: string;
 /** GitHub's mergeability; null while it is still computing. */
 mergeable: boolean | null;
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

/** The CI state of a head from its check runs, by the merge gate's own policy (`ci-policy.ts`). */
export function ciState(runs: { status: string; conclusion: string | null }[]): PrView["ci"] {
 return classifyCi(runs).state;
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

/** Why a PR cannot be merged from the dashboard, or null when it can. */
export function mergeRefusal(pr: PrView | null): string | null {
 if (pr === null) return "the PR has not been read yet";
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

export interface NeedsYouMap {
 key: string;
 repo: string;
 root: number;
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
 /** `error`: the last failed read of the PR, while `view` is unread. */
 pr: { number: number; url: string; view: PrView | null; error: string | null } | null;
 sage: SageRound | null;
 /**
  * Whether the last sage round read the PR's current head: false when the
  * head moved after it (its counts belong to an earlier head), null when
  * there is no round or no PR read to compare.
  */
 sageOnHead: boolean | null;
 probe: ProbeResult | null;
 actions: {
  resume: boolean;
  merge: { offered: true; headSha: string } | { offered: false; why: string };
  session: { offered: true; cwd: string } | { offered: false; why: string };
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
 for (const row of inputs.workers) {
  const map = inputs.maps.find((m) => m.repo === row.repo && m.root === row.root);
  if (map === undefined) continue;
  const labels = inputs.labels(row.repo, row.nodeId);
  if (!include(row, labels)) continue;
  const waiting = row.status === "parked" || row.status === "failed";
  const events = inputs.events(row.repo, row.nodeId);
  const view = row.prNumber === null ? null : inputs.prs(row.repo, row.prNumber);
  const sage = lastSageRound(events);
  const refused = row.prNumber === null ? "no PR" : mergeRefusal(view);
  // Only the principal's checkout, never the worker's worktree: that is a
  // worktree of the machine-account clone, whose files and git hooks the
  // worker controls (`servedMaps` refuses those clones for the same reason).
  const cwd = map.localCheckout !== undefined && inputs.exists(map.localCheckout) ? map.localCheckout : undefined;
  out.push({
   key: map.key,
   repo: row.repo,
   root: row.root,
   nodeId: row.nodeId,
   title: inputs.titleOf(row.repo, row.nodeId),
   url: `https://github.com/${row.repo}/issues/${row.nodeId}`,
   status: row.status as NeedsYouEntry["status"],
   endedAt: row.finishedAt,
   reason: classifyReason(row, events, labels, inputs.reviewRounds),
   pr:
    row.prNumber === null
     ? null
     : {
        number: row.prNumber,
        url: view?.url || `https://github.com/${row.repo}/pull/${row.prNumber}`,
        view,
        error: inputs.prError?.(row.repo, row.prNumber) ?? null,
       },
   sage,
   sageOnHead: sage === null || view === null || view.headSha === "" ? null : view.headSha.startsWith(sage.sha),
   probe: lastProbe(events),
   actions: {
    resume: waiting,
    merge:
     refused === null && view !== null
      ? { offered: true, headSha: view.headSha }
      : { offered: false, why: refused ?? "no PR" },
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

export type ActionKind = "resume" | "merge" | "session";

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

/** Keys a merge must never carry: they would make gh act as the machine account. */
export const MACHINE_GH_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"] as const;

/**
 * The merge's environment: the launch allowlist, and none of the machine
 * account's gh keys, so `gh` uses the login stored under HOME. What this
 * proves is the absence of the machine account's credential, not whose login
 * HOME holds.
 */
export function mergeEnv(env: Record<string, string | undefined>): Record<string, string> {
 const out = childEnv(env);
 for (const key of MACHINE_GH_KEYS) delete out[key];
 return out;
}

/** `gh pr merge`, squash, pinned to the head the principal confirmed. */
export function mergeArgv(args: { repo: string; pr: number; sha: string }): string[] {
 if (!REPO_PATTERN.test(args.repo)) throw new Error(`bad repo: ${args.repo}`);
 if (!isGithubRepo(args.repo)) throw new Error(`GitLab merge is not implemented: ${args.repo}`);
 if (!Number.isInteger(args.pr) || args.pr <= 0) throw new Error(`bad PR: ${args.pr}`);
 if (!SHA_PATTERN.test(args.sha)) throw new Error(`bad head SHA: ${args.sha}`);
 return ["gh", "pr", "merge", String(args.pr), "--repo", args.repo, "--squash", "--match-head-commit", args.sha];
}

/** `ranger resume-node`, the operator verb: it resets the row and detaches run-node itself. */
export function resumeArgv(args: {
 rangerBin: string;
 configPath: string;
 repo: string;
 root: number;
 nodeId: string;
 force: boolean;
}): string[] {
 if (!REPO_PATTERN.test(args.repo)) throw new Error(`bad repo: ${args.repo}`);
 if (!ID_PATTERN.test(args.nodeId)) throw new Error(`bad node id: ${args.nodeId}`);
 if (!Number.isInteger(args.root) || args.root <= 0) throw new Error(`bad root: ${args.root}`);
 return [
  args.rangerBin,
  "resume-node",
  args.nodeId,
  "--map",
  nodeKey(args.repo, args.root),
  "-c",
  args.configPath,
  ...(args.force ? ["--force"] : []),
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
  * read-only token saw only the Actions runs.
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

const refusal = (status: number, error: string): ActionResponse => ({ status, body: { error } });

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
 const entry = deps.entries.find((e) => e.key === body.key && e.nodeId === body.id);
 if (entry === undefined) {
  return refusal(404, `#${body.id} is not parked, failed or awaiting a merge on ${body.key}`);
 }
 const held = nodeKey(entry.repo, entry.nodeId);
 if (deps.inFlight.has(held)) return refusal(409, `an action on #${entry.nodeId} is already running: wait for it, then reload`);
 deps.inFlight.add(held);
 let exited: Promise<void> | undefined;
 try {
  const response = await runHeldAction(kind, body, deps, entry);
  exited = response.exited;
  return response;
 } finally {
  // Held until the child exits, not until the page is answered: a resume
  // that outlives the HTTP timeout must still refuse a second one.
  if (exited === undefined) deps.inFlight.delete(held);
  else void exited.finally(() => deps.inFlight.delete(held));
 }
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
 } else if (kind === "merge") {
  if (!entry.actions.merge.offered) return refusal(409, entry.actions.merge.why);
  if (typeof body.sha !== "string" || body.sha !== entry.actions.merge.headSha) {
   return refusal(409, "the confirmed head SHA is not the PR's head: reload and confirm again");
  }
  const pr = entry.pr as NonNullable<NeedsYouEntry["pr"]>;
  let live: PrView | null;
  try {
   live = await deps.readPr(entry.repo, pr.number);
  } catch (error) {
   return refusal(502, `could not read PR #${pr.number} live: ${error instanceof Error ? error.message : String(error)}`);
  }
  const stale = mergeRefusal(live);
  if (stale !== null && live?.mergeable === false && live.state === "open" && entry.status === "awaiting-merge" && deps.configPath !== undefined) {
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
   return refusal(409, "the PR head moved since the page read it: reload and confirm again");
  }
  env = mergeEnv(deps.env);
  // The dashboard's token saw only the Actions runs: an external app's
  // failing check would not be in them. Before merging, every check is read
  // under the same gh account the merge itself runs as.
  if ((live as PrView).ciSource === "actions") {
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
 const out: Record<string, unknown> = {
  action: kind,
  nodeId: entry.nodeId,
  ok: result.code === 0,
  code: result.code,
  stderr: tailOf(result.stderr),
 };
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
