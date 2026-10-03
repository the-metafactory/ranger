import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCmd, type RunResult } from "./exec.ts";

/**
 * Git operations the SUPERVISOR performs in the canonical checkout and in
 * worktrees the worker wrote to. The worker shares the canonical checkout's
 * `.git` (a linked worktree) and runs as the same OS user, so it can plant
 * hooks or config that a later supervisor git call would execute. Every
 * supervisor git call therefore goes through `safeGit`: hooks and fsmonitor
 * off, and a minimal env — never the supervisor's own, which holds the write
 * PATs and the Discord token; the auth header is added only to the calls that
 * talk to the remote. Before any git call after a worker session, the git
 * config and hooks must match a pre-worker snapshot (`assertGitUntouched`).
 *
 * This is a tamper check, not a sandbox: a same-user process could still
 * write elsewhere on the machine. It closes the paths by which worker-written
 * git state would run with ranger's credentials.
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

/** The env every supervisor git call runs with: enough to find git and the user's home, nothing else. */
function minimalGitEnv(): NodeJS.ProcessEnv {
 const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
 for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
 }
 return env;
}

/**
 * Run git with hooks and fsmonitor disabled, in a minimal env. `token` adds
 * the auth header (remote calls only).
 */
export function safeGit(
 args: string[],
 opts: { cwd: string; token?: string; timeoutMs?: number },
): Promise<RunResult> {
 const base = minimalGitEnv();
 return runCmd(
  "git",
  ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
  {
   cwd: opts.cwd,
   env: opts.token === undefined ? base : gitAuthEnv(opts.token, base),
   timeoutMs: opts.timeoutMs ?? 60_000,
  },
 );
}

/**
 * Snapshot of the git state a worker could tamper with: the shared `config`,
 * per-worktree `config.worktree` files, and the hooks directory. Taken before
 * the worker runs; `assertGitUntouched` compares it before any git call after.
 */
export function gitConfigSnapshot(canonical: string): string {
 const gitDir = join(canonical, ".git");
 const hash = createHash("sha256");
 const add = (file: string) => {
  hash.update(file);
  hash.update(existsSync(file) ? readFileSync(file) : "(absent)");
 };
 add(join(gitDir, "config"));
 add(join(gitDir, "config.worktree"));
 const worktrees = join(gitDir, "worktrees");
 if (existsSync(worktrees)) {
  for (const entry of readdirSync(worktrees).sort()) {
   const file = join(worktrees, entry, "config.worktree");
   if (existsSync(file)) add(file);
  }
 }
 const hooks = join(gitDir, "hooks");
 if (existsSync(hooks)) {
  for (const entry of readdirSync(hooks).sort()) add(join(hooks, entry));
 }
 return hash.digest("hex");
}

export function assertGitUntouched(canonical: string, snapshot: string): void {
 if (gitConfigSnapshot(canonical) !== snapshot) {
  throw new GitSafetyError(
   "the git config or hooks changed while the worker ran — refusing to run git against a tampered checkout",
  );
 }
}

/** GitHub's closing keywords followed by an issue reference (same repo, cross-repo, or URL). */
const CLOSING_KEYWORD =
 /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]+(?:[\w.-]+\/[\w.-]+)?#\d+|\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]+https?:\/\/github\.com\/[^\s]+\/issues\/\d+/i;

export function findClosingKeyword(text: string): string | null {
 const match = text.match(CLOSING_KEYWORD);
 return match === null ? null : match[0];
}

export async function headSha(worktree: string): Promise<string> {
 const result = await safeGit(["rev-parse", "HEAD"], {
  cwd: worktree,
  timeoutMs: 10_000,
 });
 if (result.code !== 0) {
  throw new GitSafetyError(`cannot read HEAD in ${worktree}: ${result.stderr.trim()}`);
 }
 return result.stdout.trim();
}

/** Uncommitted or untracked files the worker left (gitignored files do not count). */
export async function dirtyFiles(worktree: string): Promise<string[]> {
 const result = await safeGit(["status", "--porcelain"], {
  cwd: worktree,
  timeoutMs: 30_000,
 });
 if (result.code !== 0) {
  throw new GitSafetyError(`cannot read the worktree status: ${result.stderr.trim()}`);
 }
 return result.stdout.split("\n").filter((l) => l.trim().length > 0);
}

/** Commits on the branch that are not on origin/<base>. */
export async function commitsAhead(
 worktree: string,
 base: string,
): Promise<number> {
 const result = await safeGit(["rev-list", "--count", `origin/${base}..HEAD`], {
  cwd: worktree,
  timeoutMs: 10_000,
 });
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
 const log = await safeGit(["log", `origin/${base}..HEAD`, "--format=%B"], {
  cwd: worktree,
  timeoutMs: 10_000,
 });
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
 * `branch`, from an untampered checkout.
 */
export async function vettedPush(opts: {
 worktree: string;
 canonical: string;
 branch: string;
 token: string;
 configSnapshot: string;
 /** What to push (default HEAD); research pushes its named local branch. */
 source?: string;
}): Promise<void> {
 assertGitUntouched(opts.canonical, opts.configSnapshot);
 const push = await safeGit(
  ["push", "--no-verify", "origin", `${opts.source ?? "HEAD"}:refs/heads/${opts.branch}`],
  { cwd: opts.worktree, token: opts.token, timeoutMs: 120_000 },
 );
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
 const fetch = await safeGit(["fetch", "origin", base], {
  cwd: canonical,
  token,
  timeoutMs: 120_000,
 });
 if (fetch.code !== 0) {
  throw new GitSafetyError(`fetch origin ${base} failed: ${fetch.stderr.trim()}`);
 }
 const current = await safeGit(["symbolic-ref", "--short", "HEAD"], {
  cwd: canonical,
  timeoutMs: 10_000,
 });
 const onBase = current.code === 0 && current.stdout.trim() === base;
 const result = onBase
  ? await safeGit(["merge", "--ff-only", `origin/${base}`], { cwd: canonical })
  : await safeGit(["fetch", ".", `origin/${base}:${base}`], { cwd: canonical });
 if (result.code !== 0) {
  throw new GitSafetyError(
   `cannot fast-forward ${base} in the canonical checkout ${canonical}: ${result.stderr.trim()}`,
  );
 }
}
