import { spawnSync } from "node:child_process";
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

/** Ranger's own node branches: `node/<N>-<slug>` (`worktreeBranch` + `slugify` in worker.ts). */
export const NODE_BRANCH = /^node\/\d+-[a-z0-9-]+$/;

/** The remote ranger's node branches track (`worktree add -b … origin/<base>`). */
const MAP_REMOTE = "origin";

/** `branch.<name>.<key>` → name and key (subsection split on the first and last dot; names may hold dots). */
function branchKey(key: string): { name: string; key: string } | null {
 const first = key.indexOf(".");
 const last = key.lastIndexOf(".");
 if (first === -1 || last === first) return null;
 if (key.slice(0, first).toLowerCase() !== "branch") return null;
 return { name: key.slice(first + 1, last), key: key.slice(last + 1).toLowerCase() };
}

/**
 * The shared `config` as hashable bytes, less the branch-tracking entries
 * ranger writes for its own node branches. Adding a node worktree off
 * origin/<base> writes `branch."node/…".remote` + `.merge` to the SHARED
 * config, so a second node started in the same clone during a worker session
 * tripped the first one's tamper check (node #63: seelite #212 parked by
 * #663). Remove, don't select: every other record stays in the hash, and a
 * node-branch section is dropped only when it holds exactly `remote=origin`
 * and `merge=refs/heads/<base>`, or `remote=origin` alone. Git writes the
 * two keys as separate config writes, remote first (branch.c
 * `install_branch_config_multiple_remotes`), so a snapshot or an assert taken
 * while another node's worktree is being created can see the remote-only
 * section; it is a strict subset of the full one, so dropping it lets nothing
 * through the full rule does not. Merge-only never comes from git's write
 * order and stays in the hash. Parsed by git without includes, so an
 * include line is hashed as the line it is; a file git cannot parse is
 * hashed raw, never as an empty listing. Records keep git's file order, never
 * sorted: for a repeated single-value key the last one wins, so reordering
 * `http.sslVerify` or `core.sshCommand` entries changes what git runs.
 */
function configRecords(file: string, base: string): Buffer | string {
 if (!existsSync(file)) return "(absent)";
 const listed = spawnSync(
  "git",
  [
   "-c", "core.hooksPath=/dev/null",
   "-c", "core.fsmonitor=false",
   "config", "--file", file, "--no-includes", "--list", "--null",
  ],
  // latin1, not utf8: one char per byte, so a value with bytes that are not
  // valid UTF-8 (FF vs FE in a command path) never collapses to the same
  // replacement character and hashes alike.
  { env: minimalGitEnv(), encoding: "latin1", timeout: 10_000 },
 );
 if (listed.status !== 0 || listed.error !== undefined) {
  return Buffer.concat([Buffer.from("(unparsed)\0"), readFileSync(file)]);
 }
 // --null: each record ends in NUL; the key ends at the first newline, and a
 // valueless boolean key has none.
 const records = listed.stdout
  .split("\0")
  .filter((r) => r.length > 0)
  .map((r) => {
   const nl = r.indexOf("\n");
   return nl === -1
    ? { key: r, value: null }
    : { key: r.slice(0, nl), value: r.slice(nl + 1) };
  });
 const sections = new Map<string, { key: string; value: string | null }[]>();
 for (const { key, value } of records) {
  const parsed = branchKey(key);
  if (parsed === null) continue;
  const entries = sections.get(parsed.name) ?? [];
  entries.push({ key: parsed.key, value });
  sections.set(parsed.name, entries);
 }
 const own = new Set<string>();
 for (const [name, entries] of sections) {
  const remote = entries.filter((e) => e.key === "remote");
  const merge = entries.filter((e) => e.key === "merge");
  const tracksOrigin =
   NODE_BRANCH.test(name) && remote.length === 1 && remote[0].value === MAP_REMOTE;
  const midWrite = entries.length === 1;
  const complete =
   entries.length === 2 &&
   merge.length === 1 &&
   merge[0].value === `refs/heads/${base}`;
  if (tracksOrigin && (midWrite || complete)) own.add(name);
 }
 return JSON.stringify(
  records
   .filter(({ key }) => {
    const parsed = branchKey(key);
    return parsed === null || !own.has(parsed.name);
   })
   // [key, value] tuples, never "key=value": a key may hold "=" (a url.<x>
   // subsection), so a joined string lets two different records collide.
   .map(({ key, value }) => [key, value]),
 );
}

/**
 * Snapshot of the git state a worker could tamper with: the shared `config`
 * (less ranger's own node-branch tracking, see `configRecords`), per-worktree
 * `config.worktree` files, and the hooks directory. Taken before the worker
 * runs; `assertGitUntouched` compares it before any git call after. `base` is
 * the map's base branch, the merge target of those tracking entries: the
 * snapshot and its assert must be given the same one.
 */
export function gitConfigSnapshot(canonical: string, base = "main"): string {
 const gitDir = join(canonical, ".git");
 const hash = createHash("sha256");
 // Every part is length-framed, and a missing file is "-" where a length
 // would be: bare concatenation let bytes move across a file boundary
 // (hook B deleted, its path and body appended to hook A) and hash alike.
 const part = (data: Buffer | string | null) => {
  if (data === null) {
   hash.update("-\0");
   return;
  }
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  hash.update(`${bytes.length}\0`);
  hash.update(bytes);
 };
 const add = (file: string) => {
  part(file);
  part(existsSync(file) ? readFileSync(file) : null);
 };
 const config = join(gitDir, "config");
 part(config);
 part(configRecords(config, base));
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

export function assertGitUntouched(
 canonical: string,
 snapshot: string,
 base = "main",
): void {
 if (gitConfigSnapshot(canonical, base) !== snapshot) {
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
 /** The map's base, as given to `gitConfigSnapshot` (default main). */
 base?: string;
 /** What to push (default HEAD); research pushes its named local branch. */
 source?: string;
}): Promise<void> {
 assertGitUntouched(opts.canonical, opts.configSnapshot, opts.base);
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
 *
 * Run-nodes share the canonical checkout, and two closes after back-to-back
 * merges fetch at the same moment (2026-10-04: #686 and #687, "cannot lock
 * ref 'refs/remotes/origin/main'"). Git's own ref lock is the mutex: the
 * loser waits and runs the whole fetch + fast-forward again, which is
 * idempotent once the winner has moved the refs.
 */
export async function fastForwardCanonical(
 canonical: string,
 base: string,
 token: string,
 opts: { attempts?: number; backoffMs?: number } = {},
): Promise<void> {
 const attempts = opts.attempts ?? 4;
 for (let attempt = 1; ; attempt++) {
  try {
   return await fastForwardOnce(canonical, base, token);
  } catch (error) {
   const contended = error instanceof GitSafetyError && GIT_LOCK_CONTENTION.test(error.message);
   if (!contended || attempt >= attempts) throw error;
   await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 2_000) * attempt));
  }
 }
}

/** Git refusing a ref update because another git process holds that ref's lock. */
export const GIT_LOCK_CONTENTION = /cannot lock ref|Unable to create '[^']+\.lock'/;

async function fastForwardOnce(canonical: string, base: string, token: string): Promise<void> {
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
