import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { expandHome, type RangerConfig } from "./config.ts";

const READ_ONLY_GIT = new Set([
 "blame", "cat-file", "check-ignore", "count-objects", "describe", "diff", "fetch", "for-each-ref", "grep", "help",
 "log", "ls-files", "ls-remote", "ls-tree", "merge-base", "name-rev", "rev-list", "rev-parse", "shortlog", "show",
 "show-ref", "status", "var", "version",
]);

const LIST_MODE = new Set(["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort"]);

const LISTING_FLAGS = new Set([...LIST_MODE, "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "-n", "--show-current", "--column", "--no-column", "--color", "--no-color"]);

const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "-l", "--list"]);

const READ_ONLY_SUBVERBS = new Map([
 ["worktree", new Set(["list"])],
 ["remote", new Set(["-v", "--verbose", "get-url", "show"])],
 ["stash", new Set(["list", "show"])],
 ["reflog", new Set(["show"])],
 ["sparse-checkout", new Set(["list"])],
]);

const OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** The canonical checkouts a guarded session must not write to: the canonical root and each map's own clone. */
export function guardedRoots(config: Pick<RangerConfig, "state" | "maps">): string[] {
 const roots = new Set([resolve(expandHome(config.state.canonicalRoot))]);
 for (const map of config.maps) if (map.canonical !== undefined) roots.add(resolve(expandHome(map.canonical)));
 return [...roots];
}

function inside(path: string, root: string): boolean {
 return path === root || path.startsWith(root + sep);
}

/** The canonical checkout `dir` sits in, or undefined when it is outside every root or inside a checkout's `.worktrees/`. */
export function canonicalCheckout(dir: string, roots: string[], canonicalRoot: string): string | undefined {
 for (const root of roots) {
  if (!inside(dir, root)) continue;
  const parts = relative(root, dir).split(sep).filter((part) => part.length > 0);
  const depth = root === canonicalRoot ? 2 : 0;
  if (parts.length < depth) continue;
  if (parts[depth] === ".worktrees") return undefined;
  return resolve(root, ...parts.slice(0, depth));
 }
 return undefined;
}

function words(segment: string): string[] {
 const out: string[] = [];
 let current = "";
 let quote: string | undefined;
 let started = false;
 for (const char of segment) {
  if (quote !== undefined) {
   if (char === quote) quote = undefined;
   else current += char;
  } else if (char === "'" || char === "\"") {
   quote = char;
   started = true;
  } else if (/\s/.test(char)) {
   if (started || current.length > 0) out.push(current);
   current = "";
   started = false;
  } else {
   current += char;
  }
 }
 if (started || current.length > 0) out.push(current);
 return out;
}

function segments(command: string): string[][] {
 return command
  .split(/&&|\|\||[;|\n()]/)
  .map((segment) => words(segment.trim()))
  .filter((segment) => segment.length > 0);
}

function pathFrom(base: string, target: string): string {
 const expanded = target === "~" ? homedir() : expandHome(target);
 return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

function gitWrites(args: string[]): boolean {
 const verb = args.at(0);
 const rest = args.slice(1);
 if (verb === undefined) return false;
 if (READ_ONLY_GIT.has(verb)) return false;
 if (verb === "config") {
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  return !rest.some((arg) => CONFIG_READS.has(arg)) && positional.length !== 1;
 }
 if (verb === "branch" || verb === "tag") {
  const flags = rest.filter((arg) => arg.startsWith("-")).map((arg) => arg.split("=")[0]);
  if (flags.some((flag) => !LISTING_FLAGS.has(flag))) return true;
  return rest.length > flags.length && !flags.some((flag) => LIST_MODE.has(flag));
 }
 const subverbs = READ_ONLY_SUBVERBS.get(verb);
 const sub = rest.at(0);
 if (subverbs !== undefined) return sub !== undefined && !subverbs.has(sub);
 return true;
}

export interface CanonicalWrite {
 checkout: string;
 git: string;
}

/**
 * The first git command in a Bash command line that would write to a canonical checkout, following
 * `cd` and `git -C` from `cwd`. Read-only git (status, log, diff, fetch, listing a branch or a
 * worktree) passes; so does anything run inside a checkout's `.worktrees/`.
 */
export function findCanonicalWrite(command: string, cwd: string, roots: string[], canonicalRoot: string): CanonicalWrite | undefined {
 let dir = resolve(cwd);
 for (const segment of segments(command)) {
  let at = 0;
  while (at < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[at])) at++;
  const head = segment.at(at);
  if (head === "cd" || head === "pushd") {
   const target = segment.at(at + 1);
   dir = target === undefined ? homedir() : pathFrom(dir, target);
   continue;
  }
  if (head !== "git") continue;
  let gitDir = dir;
  let index = at + 1;
  while (index < segment.length && segment[index].startsWith("-")) {
   const option = segment[index];
   const value = segment.at(index + 1);
   if (option === "-C" && value !== undefined) gitDir = pathFrom(gitDir, value);
   index += OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  const args = segment.slice(index);
  const checkout = canonicalCheckout(gitDir, roots, canonicalRoot);
  if (checkout !== undefined && gitWrites(args)) return { checkout, git: ["git", ...args].join(" ") };
 }
 return undefined;
}

export function denyReason(write: CanonicalWrite): string {
 return `${write.checkout} is ranger's canonical checkout: \`${write.git}\` would change its git state, and ranger then parks every node of its maps until the principal vets it with \`ranger trust-git\`. Work in your own clone or in a worktree of the principal's checkout instead; read-only git here is fine.`;
}
