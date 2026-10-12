import { runCmd, type RunOptions, type RunResult } from "./exec.ts";

/**
 * Transient GitHub failures (found live 2026-10-03: #45 lost a finished build
 * to a GraphQL "couldn't respond in time" inside sage, and #663 failed its
 * first map read the same way seven minutes later).
 *
 * These are GitHub-side, short-lived and say nothing about the node, so a
 * READ that hits one is retried with backoff, and a failure that is still
 * transient after the retries does not count toward the dead-man switch.
 * Writes are never retried here: a timed-out POST may have landed, and a
 * second one would duplicate a PR, a comment or a merge attempt.
 */
const TRANSIENT = [
 /couldn't respond to your request in time/i,
 /something went wrong while executing your query/i,
 /\bHTTP (?:502|503|504)\b/,
 /\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\b/i,
 /\bstream error\b.*\bCANCEL\b/i,
 /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/,
 /\bi\/o timeout\b/i,
 /\bTLS handshake timeout\b/i,
];

export function isTransientGitHubError(text: string): boolean {
 return TRANSIENT.some((pattern) => pattern.test(text));
}

/**
 * A bare HTTP 500 is retried on a read only (2026-10-07: one on seelite #482's
 * close read of its merged head's check runs failed the node). It stays off
 * `TRANSIENT`: that list also classifies worker outcomes, whose failing test
 * names may well say "HTTP 500", and a test failure must still count.
 */
const READ_RETRYABLE = [/\bHTTP 500\b/, /\b500 Internal Server Error\b/i];

function isRetryableRead(text: string): boolean {
 return isTransientGitHubError(text) || READ_RETRYABLE.some((pattern) => pattern.test(text));
}

/**
 * A GitLab refusal for rate limiting (node #130): glab and soma's GitLab
 * backend report a 429 as its status line or reason phrase. Anchored to the
 * HTTP status: a bare "429" may be a node or issue number. Never retried
 * here: requests sent while limited can extend the limit, so it becomes a
 * RateLimitError and a cooldown instead (src/graph.ts, src/budget.ts).
 */
const GITLAB_RATE_LIMITED = [
 /\bHTTP(?:\/[\d.]+)?:?\s+429\b/i,
 /\b429 Too Many Requests\b/i,
 /\bToo Many Requests\b/i,
];

export function isGitLabRateLimit(text: string): boolean {
 return GITLAB_RATE_LIMITED.some((pattern) => pattern.test(text));
}

/** Delays between attempts: three attempts in all, about 40 s of waiting. */
export const TRANSIENT_BACKOFF_MS = [10_000, 30_000];

export interface TransientRetryOptions {
 backoffMs?: number[];
 sleep?: (ms: number) => Promise<void>;
 /** Extra veto on a retry, checked after the transient-error test (e.g. a result that carries a verdict). */
 shouldRetry?: (result: RunResult) => boolean;
 /** Called before each retry, with the attempt about to run (2, 3, …). */
 onRetry?: (attempt: number, result: RunResult) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * `runCmd` for read-only commands: a non-zero exit whose output is a transient
 * GitHub error is retried after each backoff delay. Any other result, success
 * or failure, returns at once. The last result is returned when the retries
 * run out, so the caller's own error handling still applies.
 */
export async function runReadRetryingTransient(
 bin: string,
 args: string[],
 opts: RunOptions = {},
 retry: TransientRetryOptions = {},
): Promise<RunResult> {
 const backoff = retry.backoffMs ?? TRANSIENT_BACKOFF_MS;
 const sleep = retry.sleep ?? defaultSleep;
 let result = await runCmd(bin, args, opts);
 for (let i = 0; i < backoff.length; i++) {
  if (result.code === 0 || !isRetryableRead(`${result.stderr}\n${result.stdout}`)) break;
  if (retry.shouldRetry !== undefined && !retry.shouldRetry(result)) break;
  retry.onRetry?.(i + 2, result);
  await sleep(backoff[i]);
  result = await runCmd(bin, args, opts);
 }
 return result;
}
