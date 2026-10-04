/**
 * The words ranger parks a node with, in one place (node #54): the implement
 * lane writes its review-cap and probe outcomes with these builders, and
 * `ranger serve` reads a parked row's reason class back with the matching
 * patterns, so the dashboard classifies by ranger's own rules rather than by
 * guessing at prose. No imports: `serve.ts` reaches this module, and its
 * import graph must stay free of graph writes (`test/serve.test.ts`).
 */

/** A node that needs the principal's eye (or ear): its PR is merged by hand, never by ranger. */
export const NEEDS_EYE_LABEL = "ranger:needs-eye";

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

/** Sage rounds ran out with blockers or majors still open. */
export function reviewCapOutcome(r: { blockers: number; majors: number; round: number; pr: number }): string {
 return `${r.blockers} blocker(s) and ${r.majors} major(s) remain after ${r.round} sage round(s) on PR #${r.pr} — good-enough is the principal's call (design §4/§7)`;
}

/** Sage rounds ran out and the head moved after the last one. */
export function reviewCapHeadMovedOutcome(r: { rounds: number; pr: number }): string {
 return `review cap reached: ${r.rounds} sage round(s) on PR #${r.pr} and the head moved since the last one — a further round is the principal's call (design §4)`;
}

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
 tail: string;
}): string {
 const names = r.failed.filter((n) => PROBE_FILE.test(n));
 return [
  `browser probes failed twice at ${r.sha.slice(0, 8)} on PR #${r.pr} (exit ${r.exit})`,
  ...(names.length > 0 ? [`FAILED: ${names.join(" · ")}`] : []),
  r.tail,
 ].join("\n");
}

export const PROBES_FAILED_OUTCOME = /^browser probes failed twice\b/;

/** A session or review that stopped on its substrate's limit (node #45). */
export const SUBSTRATE_CAPPED_OUTCOME = /\bhit its rate limit\b/;
