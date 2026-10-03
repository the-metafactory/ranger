import { runCmd } from "./exec.ts";
import { gatedEnv } from "./token-gate.ts";
import { workerHostEnv } from "./worker-env.ts";

/**
 * The implement lane's review round (design §4, node #5 interim): an OFFLINE
 * `sage review` of the draft PR — never bus dispatch (no cortex#1503
 * contention, no DORMANT class, no head-of-line), and never `--post`, which
 * would publish under whichever GitHub login the token belongs to.
 *
 * Sage runs under the map's READ-ONLY token (node #8: reads may run under the
 * principal's read-only credential) in the allow-listed host env: it reads
 * worker-written code, so it never sees the machine write PAT or the Discord
 * token. The supervisor posts the rendered review to the PR itself, under the
 * machine account.
 */

export class ReviewError extends Error {
 override readonly name = "ReviewError";
}

export interface ReviewVerdict {
 /** approved | changes-requested | commented (cortex's enum, verbatim). */
 verdict: string;
 summary: string;
 /** The PR head the review read — must equal the SHA ranger pushed. */
 commitId: string;
 blockers: number;
 majors: number;
 nits: number;
 /** The rendered review (stdout before the verdict block). */
 body: string;
}

/** Sage's per-review wall clock (several lenses, each up to ~17 min by default). */
const REVIEW_TIMEOUT_MS = 40 * 60 * 1000;

export async function sageReview(
 repo: string,
 prNumber: number,
 readOnlyToken: string,
 opts: { command?: string; timeoutMs?: number } = {},
): Promise<ReviewVerdict> {
 const gated = gatedEnv(readOnlyToken, {}, workerHostEnv());
 try {
  const result = await runCmd(
   opts.command ?? process.env.RANGER_SAGE_CMD ?? "sage",
   ["review", `${repo}#${prNumber}`, "--emit-verdict-block"],
   {
    env: gated.env,
    timeoutMs: opts.timeoutMs ?? REVIEW_TIMEOUT_MS,
    processGroup: true,
   },
  );
  if (result.code !== 0) {
   throw new ReviewError(
    `sage review ${repo}#${prNumber} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-400)}`,
   );
  }
  return parseVerdictBlock(result.stdout);
 } finally {
  gated.cleanup();
 }
}

/**
 * Parse sage's terminal ```json verdict block (sage#83 contract: the LAST
 * json fence in stdout). Everything before it is the rendered review.
 */
export function parseVerdictBlock(stdout: string): ReviewVerdict {
 const fence = /```json\s*\n([\s\S]*?)\n```/g;
 let last: RegExpExecArray | null = null;
 for (let m = fence.exec(stdout); m !== null; m = fence.exec(stdout)) last = m;
 if (last === null) {
  throw new ReviewError("sage output carries no ```json verdict block");
 }
 let block: Record<string, unknown>;
 try {
  block = JSON.parse(last[1]) as Record<string, unknown>;
 } catch {
  throw new ReviewError("sage verdict block is not valid JSON");
 }
 const findings = (block.findings ?? {}) as Record<string, unknown>;
 const count = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
   throw new ReviewError(`sage verdict block: findings.${name} is not a count`);
  }
  return v;
 };
 if (typeof block.commit_id !== "string" || block.commit_id.length === 0) {
  throw new ReviewError("sage verdict block has no commit_id");
 }
 return {
  verdict: String(block.verdict ?? ""),
  summary: String(block.summary ?? ""),
  commitId: block.commit_id,
  blockers: count(findings.blockers, "blockers"),
  majors: count(findings.majors, "majors"),
  nits: count(findings.nits, "nits"),
  body: stdout.slice(0, last.index).trim(),
 };
}
