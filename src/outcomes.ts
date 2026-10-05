/**
 * The words ranger parks a node with, in one place (node #54): the implement
 * lane writes its review-cap and probe outcomes with these builders, and
 * `ranger serve` reads a parked row's reason class back with the matching
 * patterns, so the dashboard classifies by ranger's own rules rather than by
 * guessing at prose. No imports: `serve.ts` reaches this module, and its
 * import graph must stay free of graph writes (`test/serve.test.ts`).
 */

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

/**
 * The checks each failed probe failed, by the seelite runner's layout: a
 * `FAIL <file> (<n>s) …` header, then the probe's own output indented under
 * `│`, where a failed check reads `FAIL  <check> — <detail>`. The detail
 * carries run-specific values, so only the check's name is kept. A probe
 * whose output names no failed check (a crash, a timeout) maps to an empty set.
 */
export function parseFailedChecks(stdout: string): Map<string, Set<string>> {
 const out = new Map<string, Set<string>>();
 let current: Set<string> | null = null;
 for (const line of stdout.split("\n")) {
  const header = /^(ok|FAIL|warn) +([\w.-]+\.m?js) \(/.exec(line);
  if (header !== null) {
   current = null;
   if (header[1] === "FAIL" && PROBE_FILE.test(header[2])) {
    current = new Set();
    out.set(header[2], current);
   }
   continue;
  }
  const check = /^\s*│\s*FAIL\s+(.+?)(?:\s+—\s.*)?$/.exec(line);
  if (check !== null && current !== null) current.add(check[1].trim());
 }
 return out;
}

/** Sage rounds ran out with blockers or majors still open. */
export function reviewCapOutcome(r: { blockers: number; majors: number; round: number; pr: number }): string {
 return `${r.blockers} blocker(s) and ${r.majors} major(s) remain after ${r.round} sage round(s) on PR #${r.pr} — good-enough is the principal's call (design §4/§7)`;
}

/** Sage rounds ran out and the head moved after the last one. */
export function reviewCapHeadMovedOutcome(r: { rounds: number; pr: number }): string {
 return `review cap reached: ${r.rounds} sage round(s) on PR #${r.pr} and the head moved since the last one — a further round is the principal's call (design §4)`;
}

/** The head-moved variant alone: the last sage round read an earlier head. */
export const REVIEW_CAP_HEAD_MOVED_OUTCOME = /^review cap reached: \d+ sage round\(s\) on PR #\d+ and the head moved since the last one/;

export const REVIEW_CAP_OUTCOME = /^(?:\d+ blocker\(s\) and \d+ major\(s\) remain after \d+ sage round\(s\)|review cap reached: )/;

/**
 * The probe tier failed twice. The failed names go on their own `FAILED:`
 * line ahead of the output's tail: the journal keeps 400 characters of an
 * outcome, and a tail that ends the run's output cuts the runner's own line.
 */
export function probesFailedOutcome(r: {
 sha: string;
 pr: number;
 exit: number;
 failed: string[];
 /** The failed probes that fail at the merge base too (the rest are this branch's). */
 redOnBase?: string[];
 tail: string;
}): string {
 const names = r.failed.filter((n) => PROBE_FILE.test(n));
 const onBase = (r.redOnBase ?? []).filter((n) => PROBE_FILE.test(n));
 return [
  `browser probes failed twice at ${r.sha.slice(0, 8)} on PR #${r.pr} (exit ${r.exit})`,
  ...(names.length > 0 ? [`FAILED: ${names.join(" · ")}`] : []),
  ...(onBase.length > 0 ? [`red on the merge base too: ${onBase.join(" · ")}`] : []),
  r.tail,
 ].join("\n");
}

export const PROBES_FAILED_OUTCOME = /^browser probes failed twice\b/;

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
