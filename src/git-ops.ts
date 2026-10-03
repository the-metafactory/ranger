import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCmd } from "./exec.ts";

/**
 * Git operations the SUPERVISOR performs on a worktree the worker wrote to.
 * The worker shares the canonical checkout's `.git` (a linked worktree), so
 * it can plant hooks or config that the supervisor's credentialed push would
 * then run with the write PAT in its env. The vetted push neutralises hooks,
 * refuses a changed `.git/config`, and refuses commits carrying GitHub closing
 * keywords (the #588 fail-open path: an auto-close skips the close gate).
 */

export class GitSafetyError extends Error {
 override readonly name = "GitSafetyError";
}

/** Basic-auth git header env (no credential persistence; the token never lands in .git/config). */
export function gitAuthEnv(
 token: string,
 base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
 const header = `AUTHORIZATION: basic ${Buffer.from(`${token}:x-oauth-basic`).toString("base64")}`;
 return {
  ...base,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraheader",
  GIT_CONFIG_VALUE_0: header,
 };
}

/**
 * Snapshot of the git config files a worker could tamper with: the shared
 * `config` and any per-worktree `config.worktree`. Taken before the worker
 * runs, compared before the credentialed push.
 */
export function gitConfigSnapshot(canonical: string): string {
 const gitDir = join(canonical, ".git");
 const hash = createHash("sha256");
 for (const file of [join(gitDir, "config"), join(gitDir, "config.worktree")]) {
  hash.update(file);
  hash.update(existsSync(file) ? readFileSync(file) : "(absent)");
 }
 const worktrees = join(gitDir, "worktrees");
 if (existsSync(worktrees)) {
  for (const entry of readdirSync(worktrees).sort()) {
   const file = join(worktrees, entry, "config.worktree");
   if (existsSync(file)) {
    hash.update(file);
    hash.update(readFileSync(file));
   }
  }
 }
 return hash.digest("hex");
}

/** GitHub's closing keywords followed by an issue reference (same repo, cross-repo, or URL). */
const CLOSING_KEYWORD =
 /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]+(?:[\w.-]+\/[\w.-]+)?#\d+|\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]+https?:\/\/github\.com\/[^\s]+\/issues\/\d+/i;

export function findClosingKeyword(text: string): string | null {
 const match = text.match(CLOSING_KEYWORD);
 return match === null ? null : match[0];
}

export async function headSha(worktree: string): Promise<string> {
 const result = await runCmd("git", ["rev-parse", "HEAD"], {
  cwd: worktree,
  timeoutMs: 10_000,
 });
 if (result.code !== 0) {
  throw new GitSafetyError(`cannot read HEAD in ${worktree}: ${result.stderr.trim()}`);
 }
 return result.stdout.trim();
}

/** Commits on the branch that are not on origin/<base>. */
export async function commitsAhead(
 worktree: string,
 base: string,
): Promise<number> {
 const result = await runCmd(
  "git",
  ["rev-list", "--count", `origin/${base}..HEAD`],
  { cwd: worktree, timeoutMs: 10_000 },
 );
 if (result.code !== 0) {
  throw new GitSafetyError(`cannot count commits ahead of origin/${base}: ${result.stderr.trim()}`);
 }
 return Number(result.stdout.trim()) || 0;
}

/** Refuse the push when any branch commit message carries a closing keyword. */
export async function assertNoClosingKeywords(
 worktree: string,
 base: string,
): Promise<void> {
 const log = await runCmd(
  "git",
  ["log", `origin/${base}..HEAD`, "--format=%B"],
  { cwd: worktree, timeoutMs: 10_000 },
 );
 if (log.code !== 0) {
  throw new GitSafetyError(`cannot read branch commit messages: ${log.stderr.trim()}`);
 }
 const hit = findClosingKeyword(log.stdout);
 if (hit !== null) {
  throw new GitSafetyError(
   `a commit message carries a GitHub closing keyword ("${hit}") — a squash merge would auto-close the node and skip the close gate (#588). Refusing to push.`,
  );
 }
}

/**
 * The vetted push: the supervisor's single credentialed write of exactly
 * `branch`. Hooks are disabled (`core.hooksPath=/dev/null`, `--no-verify`)
 * and the git config must match the pre-worker snapshot.
 */
export async function vettedPush(opts: {
 worktree: string;
 canonical: string;
 branch: string;
 token: string;
 configSnapshot: string;
 force?: boolean;
 /** What to push (default HEAD); research pushes its named local branch. */
 source?: string;
}): Promise<void> {
 if (gitConfigSnapshot(opts.canonical) !== opts.configSnapshot) {
  throw new GitSafetyError(
   "the git config changed while the worker ran — refusing a credentialed push from a tampered checkout",
  );
 }
 const args = [
  "-c",
  "core.hooksPath=/dev/null",
  "push",
  "--no-verify",
  ...(opts.force === true ? ["--force-with-lease"] : []),
  "origin",
  `${opts.source ?? "HEAD"}:refs/heads/${opts.branch}`,
 ];
 const push = await runCmd("git", args, {
  env: gitAuthEnv(opts.token),
  cwd: opts.worktree,
  timeoutMs: 60_000,
 });
 if (push.code !== 0) {
  throw new GitSafetyError(`push of ${opts.branch} failed: ${push.stderr.trim()}`);
 }
}

/**
 * Fast-forward the canonical checkout's base to origin (design §4: "maintained
 * by ranger, fast-forwarded post-merge"), so `atRef: <base>` probes see the
 * merge. Refuses anything but a fast-forward.
 */
export async function fastForwardCanonical(
 canonical: string,
 base: string,
 token: string,
): Promise<void> {
 const fetch = await runCmd("git", ["fetch", "origin", base], {
  env: gitAuthEnv(token),
  cwd: canonical,
  timeoutMs: 120_000,
 });
 if (fetch.code !== 0) {
  throw new GitSafetyError(`fetch origin ${base} failed: ${fetch.stderr.trim()}`);
 }
 const current = await runCmd("git", ["symbolic-ref", "--short", "HEAD"], {
  cwd: canonical,
  timeoutMs: 10_000,
 });
 const onBase = current.code === 0 && current.stdout.trim() === base;
 const result = onBase
  ? await runCmd("git", ["merge", "--ff-only", `origin/${base}`], {
     cwd: canonical,
     timeoutMs: 60_000,
    })
  : await runCmd("git", ["fetch", ".", `origin/${base}:${base}`], {
     cwd: canonical,
     timeoutMs: 60_000,
    });
 if (result.code !== 0) {
  throw new GitSafetyError(
   `cannot fast-forward ${base} in the canonical checkout ${canonical}: ${result.stderr.trim()}`,
  );
 }
}
