/**
 * The words ranger parks a node with, in one place (node #54): the implement
 * lane writes its review-cap and probe outcomes with these builders, and
 * `ranger serve` reads a parked row's reason class back with the matching
 * patterns, so the dashboard classifies by ranger's own rules rather than by
 * guessing at prose. Text-only imports: `serve.ts` reaches this module, and
 * its import graph must stay free of graph writes (`test/serve.test.ts`).
 * `forge-text.ts` names the change request the way its forge does (node #129).
 */

import { changeRequestLabel } from "./forge-text.ts";

/** Defined once in labels.ts; re-exported for the outcome texts that name it. */
export { NEEDS_EYE_LABEL } from "./labels.ts";

/** A probe file name as the runner prints it: no path, no shell metacharacters. */
export const PROBE_FILE = /^[\w.-]+\.m?js$/;

/**
 * The probes a failed run names on its `FAILED: a.mjs · b.mjs` line (the
 * seelite runner's summary). Empty when there is no such line or any name
 * is not a plain probe file name, so the caller falls back to the full suite.
 */
export function parseFailedProbes(stdout: string): string[] {
 const line = stdout.match(/^FAILED: (.+)$/m)?.[1];
 if (line === undefined) return [];
 const names = line.split("·").map((n) => n.trim()).filter(Boolean);
 return names.length > 0 && names.every((n) => PROBE_FILE.test(n)) ? names : [];
}

/** How a failed probe failed, as the runner's header and the probe's own output say. */
export interface FailedProbeRun {
 /** The runner's failure kind (`assert`, `crash`, …); null when the header names none. */
 kind: string | null;
 /** The names of the checks it failed, without their run-specific detail. */
 checks: Set<string>;
}

/**
 * The failed probes of a run, by the seelite runner's layout: a
 * `FAIL <file> (<n>s) exit=<code> <kind> …` header, then the probe's own
 * output indented under `│`, where a failed check reads
 * `FAIL  <check> — <detail>`. The detail carries run-specific values, so only
 * the check's name is kept. A probe that names no failed check (a crash, a
 * timeout) has an empty set.
 */
export function parseFailedChecks(stdout: string): Map<string, FailedProbeRun> {
 const out = new Map<string, FailedProbeRun>();
 let current: FailedProbeRun | null = null;
 for (const line of stdout.split("\n")) {
  const header = /^(ok|FAIL|warn) +([\w.-]+\.m?js) \([^)]*\)(?: exit=(?:-?\d+|killed:[\w]+) (\w+))?/.exec(line);
  if (header !== null) {
   current = null;
   if (header[1] === "FAIL" && PROBE_FILE.test(header[2])) {
    current = { kind: header[3] ?? null, checks: new Set() };
    out.set(header[2], current);
   }
   continue;
  }
  const check = /^\s*│\s*FAIL\s+(.+?)(?:\s+—\s.*)?$/.exec(line);
  if (check !== null && current !== null) current.checks.add(check[1].trim());
 }
 return out;
}

/** The branch still conflicts with its base after every base merge pass it gets. */
export function baseConflictOutcome(r: { repo: string; pr: number; base: string; passes: number }): string {
 return `${changeRequestLabel(r.repo, r.pr)} conflicts with ${r.base} again after ${r.passes} base merge pass(es) — the base keeps moving under it; resolving it is the principal's call`;
}

/**
 * The probes a run selected (the seelite selector lists them, indented, after
 * `selected: <n>`, a semantic pick with ` (p=0.750)` after the name) that
 * had not passed when it stopped: no `ok` or `warn` line from the runner.
 * Failed and never-started ones alike. Empty, so the caller falls back to
 * the full suite, when the output names no selection or a listing shorter
 * than the count it announced (a run killed while printing it): a narrowed
 * retry must never certify probes that were not listed.
 */
export function unfinishedProbes(stdout: string): string[] {
 const lines = stdout.split("\n");
 const at = lines.findIndex((l) => /^selected: \d+$/.test(l));
 if (at < 0) return [];
 const count = Number(lines[at].slice("selected: ".length));
 const selected: string[] = [];
 for (const line of lines.slice(at + 1)) {
  const m = /^ {2}([\w.-]+\.m?js)(?: \(p=[\d.]+\))?$/.exec(line);
  if (m === null) break;
  if (!PROBE_FILE.test(m[1])) return [];
  selected.push(m[1]);
 }
 if (selected.length !== count) return [];
 const passed = new Set<string>();
 for (const line of lines) {
  const m = /^(ok|warn) +([\w.-]+\.m?js) \(/.exec(line);
  if (m !== null) passed.add(m[2]);
 }
 return selected.filter((n) => !passed.has(n));
}

/** Sage rounds ran out with blockers or majors still open. */
export function reviewCapOutcome(r: { repo: string; blockers: number; majors: number; round: number; pr: number }): string {
 return `${r.blockers} blocker(s) and ${r.majors} major(s) remain after ${r.round} sage round(s) on ${changeRequestLabel(r.repo, r.pr)} — good-enough is the principal's call (design §4/§7)`;
}

/** Sage rounds ran out and the head moved after the last one. */
export function reviewCapHeadMovedOutcome(r: { repo: string; rounds: number; pr: number }): string {
 return `review cap reached: ${r.rounds} sage round(s) on ${changeRequestLabel(r.repo, r.pr)} and the head moved since the last one — a further round is the principal's call (design §4)`;
}

/** The head-moved variant alone: the last sage round read an earlier head. */
export const REVIEW_CAP_HEAD_MOVED_OUTCOME = /^review cap reached: \d+ sage round\(s\) on (?:PR #|MR !)\d+ and the head moved since the last one/;

export const REVIEW_CAP_OUTCOME = /^(?:\d+ blocker\(s\) and \d+ major\(s\) remain after \d+ sage round\(s\)|review cap reached: )/;

export type ProbeFailureClass = "infrastructure" | "assertion" | "unknown";

/** Classify all attempts: a timeout must not erase an earlier assertion. */
export function probeFailureClass(runs: readonly { code: number; stdout: string; stderr: string }[]): ProbeFailureClass {
 const failed = runs.filter((run) => run.code !== 0);
 if (failed.length === 0) return "unknown";
 const kinds = failed.flatMap((run) => [...parseFailedChecks(run.stdout).values()]);
 if (kinds.some((run) => run.kind === "assert" || run.kind === "pageerror" || run.checks.size > 0) ||
  failed.some((run) => /(?:^\s*│\s*FAIL\s|^(?:PAGEERROR|SHADERERROR) |failed by kind:.*\b(?:assert|pageerror) \d+)/m.test(run.stdout))) {
  return "assertion";
 }
 return failed.every((run) => {
  if (run.code < 0 || (run.code >= 129 && run.code <= 192)) return true;
  const failures = [...parseFailedChecks(run.stdout).values()];
  return failures.length > 0 && failures.every((failure) => failure.kind === "crash" || failure.kind === "killed");
 }) ? "infrastructure" : "unknown";
}

/** Explicit classes survive outcome truncation. Legacy signal-only parks can retry. */
export function infrastructureProbeHead(outcome: string): string | null {
 const head = /^browser probes failed twice at ([0-9a-f]{8}) on (?:PR #|MR !)\d+ \(exit (-?\d+)\)/.exec(outcome);
 if (head === null) return null;
 const classification = /^probe failure class: (\w+)$/m.exec(outcome)?.[1];
 if (classification !== undefined) {
  if (classification !== "infrastructure") return null;
  const fullHead = /^probe failure head: ([0-9a-f]{40})$/m.exec(outcome)?.[1];
  return fullHead?.startsWith(head[1]) ? fullHead : null;
 }
 const code = Number(head[2]);
 return parseFailedProbes(outcome).length === 0 && (code < 0 || (code >= 129 && code <= 192)) ? head[1] : null;
}

/**
 * The probe tier failed twice. The failed names go on their own `FAILED:`
 * line ahead of the output's tail: the journal keeps 400 characters of an
 * outcome, and a tail that ends the run's output cuts the runner's own line.
 */
export function probesFailedOutcome(r: {
 repo: string;
 sha: string;
 pr: number;
 exit: number;
 failed: string[];
 failureClass?: ProbeFailureClass;
 /** The failed probes that fail at the merge base too (the rest are this branch's). */
 redOnBase?: string[];
 /** `probeFailureSummary` of the run: each failed probe's kind and checks, ahead of the tail. */
 summary?: string[];
 tail: string;
}): string {
 const names = r.failed.filter((n) => PROBE_FILE.test(n));
 const onBase = (r.redOnBase ?? []).filter((n) => PROBE_FILE.test(n));
 const summary = r.summary ?? [];
 return [
  `browser probes failed twice at ${r.sha.slice(0, 8)} on ${changeRequestLabel(r.repo, r.pr)} (exit ${r.exit})`,
  ...(r.failureClass === undefined ? [] : [`probe failure class: ${r.failureClass}`]),
  ...(r.failureClass === undefined ? [] : [`probe failure head: ${r.sha}`]),
  ...(names.length > 0 ? [`FAILED: ${names.join(" · ")}`] : []),
  ...(onBase.length > 0 ? [`red on the merge base too: ${onBase.join(" · ")}`] : []),
  // After the names and the base line, and capped: the row keeps 400 characters of the outcome.
  ...(summary.length > 0 ? [`failing: ${summary.join(" · ")}`.slice(0, 160)] : []),
  r.tail,
 ].join("\n");
}

export const PROBES_FAILED_OUTCOME = /^browser probes failed twice\b/;

/** At most this many probes are named in a summary, each in at most this many characters. */
const SUMMARY_PROBES = 20;
const SUMMARY_LINE = 300;

/**
 * A failed probe run, named (node #107): each failed probe with its failure
 * kind and the checks it failed, for the head of a PR record or journal line.
 * A tail of the output can hold only passing probes (2026-10-05: seelite
 * #702's record reached 113/114 and omitted the failing check). A run that
 * stopped before naming failures lists the selected probes it had not passed;
 * one that names nothing ranger reads says so rather than guessing. Empty on
 * a passing run.
 */
export function probeFailureSummary(stdout: string, exit: number): string[] {
 if (exit === 0) return [];
 const runs = parseFailedChecks(stdout);
 const names = [...new Set([...runs.keys(), ...parseFailedProbes(stdout)])];
 if (names.length === 0) {
  const unfinished = unfinishedProbes(stdout);
  return unfinished.length > 0
   ? [`stopped (exit ${exit}) before passing ${unfinished.slice(0, SUMMARY_PROBES).join(", ")}`.slice(0, SUMMARY_LINE)]
   : [`names unavailable: the run (exit ${exit}) printed no failing probe names ranger reads`];
 }
 const lines = names.slice(0, SUMMARY_PROBES).map((name) => {
  const run = runs.get(name);
  const checks = run === undefined || run.checks.size === 0 ? "" : `: ${[...run.checks].join("; ")}`;
  return `${name} (${run?.kind ?? "kind not printed"})${checks}`.slice(0, SUMMARY_LINE);
 });
 return names.length > SUMMARY_PROBES ? [...lines, `and ${names.length - SUMMARY_PROBES} more`] : lines;
}

/**
 * A hook (soma's runtime-policy guard, in practice) stopped a worker session
 * before its first turn. The prompt is rebuilt from the same node and review
 * text on a resume, so a resume stops again: the rule or the text must change
 * first. A park, not a failure: it is no evidence against the node or the
 * worker, so it does not count toward the dead-man.
 */
export function policyBlockedOutcome(r: { pass: string; reason: string; log: string }): string {
 return `policy-blocked: a hook stopped the ${r.pass} before its first turn (${r.reason}) — a resume re-sends the same prompt and stops again; change the rule or the text it matched first (worker log: ${r.log})`;
}

export const POLICY_BLOCKED_OUTCOME = /^policy-blocked: /;

/** The merge desk parked an awaiting-merge row on a hard merge-gate failure; `check` is the gate's check name. */
export function mergeGateFailedOutcome(r: { check: string; reason: string }): string {
 return `merge gate failed (${r.check}): ${r.reason}`;
}

/**
 * A merge-gate park on CI alone (node #104): the gate reads CI before the
 * review, base and probe checks, so the row is reconsidered once CI recovers,
 * with every check re-read at the live head.
 */
export const CI_FAILED_PARK_OUTCOME = /^merge gate failed \(ci-green\): /;

/** A session or review that stopped on its substrate's limit (node #45). */
export const SUBSTRATE_CAPPED_OUTCOME = /\bhit its rate limit\b/;

/** The sweep parked a row whose worker crashed `attempts` times. */
export function crashParkOutcome(r: { attempts: number; released: boolean; assignees: string[] }): string {
 return `parked after ${r.attempts} crash(es); release ${r.released ? "ok" : `refused: ${r.assignees.join(",") || "unclaimed"}`}`;
}

/** A crash park names no failure of its own: the cause is in the last attempt's events. */
export const CRASH_PARK_OUTCOME = /^parked after \d+ crash\(es\); release /;

/** The sweep's event when it respawns a crashed worker: a new attempt begins. */
export function respawnedEvent(attempt: number): string {
 return `respawned (attempt ${attempt})`;
}

export const RESPAWNED_EVENT = /^respawned \(attempt \d+\)$/;
