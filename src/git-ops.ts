import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * config and hooks must match a pre-worker snapshot (`assertGitUntouched`),
 * and that snapshot must match the state the supervisor last saw clean in an
 * earlier run (`git-trust.ts`, node #81).
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

/** Config every supervisor git call runs with: no hooks, no fsmonitor (either runs a program the config names). */
const GIT_SAFETY_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * Config every credentialed call runs with: no submodule recursion. A fetch
 * defaults to fetching submodules on demand, each from its own
 * `.git/modules/<name>/config`, which `readGitState` never vets, and the
 * child git inherits the auth header (sage round 4 on node #86). Command-line
 * `-c` outranks every config file; an explicit `--recurse-submodules` flag
 * would outrank it, and `assertNamedRefs` refuses one.
 */
const NO_SUBMODULE_RECURSION = [
 "-c", "fetch.recurseSubmodules=false",
 "-c", "push.recurseSubmodules=no",
 "-c", "submodule.recurse=false",
];

/**
 * Run git with hooks and fsmonitor disabled, in a minimal env. `token` adds
 * the auth header (remote calls only) and turns submodule recursion off
 * (`NO_SUBMODULE_RECURSION`); every such call but `clone` names the
 * `canonical` checkout whose git state was vetted, and runs only where git
 * resolves its repository to that one (`assertCheckoutOf`). Git's remote
 * helper gets the header: that is what it is for.
 */
export async function safeGit(
 args: string[],
 opts: { cwd: string; token?: string; canonical?: string; timeoutMs?: number },
): Promise<RunResult> {
 if (opts.token !== undefined) {
  assertNamedRefs(args);
  if (args[0] !== "clone") {
   if (opts.canonical === undefined) {
    throw new GitSafetyError(`refusing a credentialed \`git ${args[0]}\`: it names no canonical checkout to check its repository against`);
   }
   await assertCheckoutOf(opts.cwd, opts.canonical);
  }
 }
 const base = minimalGitEnv();
 return runCmd(
  "git",
  [
   ...GIT_SAFETY_ARGS,
   ...(opts.token === undefined ? [] : NO_SUBMODULE_RECURSION),
   ...args,
  ],
  {
   cwd: opts.cwd,
   env: opts.token === undefined ? base : gitAuthEnv(opts.token, base),
   timeoutMs: opts.timeoutMs ?? 60_000,
  },
 );
}

/**
 * A git call that carries the write credential names its remote and refs:
 * `fetch`/`push` take a remote and at least one refspec, and `clone` and
 * `worktree add` reach no remote through a branch's upstream. The tamper
 * state leaves out node branches' tracking lines (`configRecords`), which is
 * safe only while no credentialed call falls back to an upstream: a bare
 * `fetch`, `push` or any `pull` would. No call asks for submodule recursion
 * (`NO_SUBMODULE_RECURSION`).
 */
export function assertNamedRefs(args: string[]): void {
 const [verb, ...rest] = args;
 if (rest.some((a) => a.startsWith("--recurse-submodules"))) {
  throw new GitSafetyError(
   `refusing a credentialed \`git ${args.join(" ")}\`: submodules fetch from config the git state never vets`,
  );
 }
 if (verb === "clone" || (verb === "worktree" && rest[0] === "add")) return;
 const positional = rest.filter((a) => !a.startsWith("-"));
 if ((verb === "fetch" || verb === "push") && positional.length >= 2) return;
 throw new GitSafetyError(
  `refusing a credentialed \`git ${args.join(" ")}\`: it must name its remote and refs, never fall back to a branch's upstream`,
 );
}

/**
 * Throw unless git, run in `cwd`, uses the canonical checkout's own `.git`:
 * its common dir is `<canonical>/.git`, the directory `readGitState` vets,
 * and its git dir is that one (`cwd` is the canonical checkout) or one of
 * its `worktrees/<name>` (a linked worktree). A worker can rewrite its
 * worktree's `.git` file or `worktrees/<name>/commondir`, or plant a
 * `commondir` in the main `.git`: each points git at another repository,
 * whose config (another origin) the hash never covered, and a credentialed
 * call would send the write credential there. Git resolves the pointers
 * itself (`rev-parse`, no credential, hooks off): ranger does not
 * re-implement how git reads a gitfile. Paths are compared as bytes, never
 * decoded: UTF-8 decoding maps every invalid byte to U+FFFD, so
 * `worktrees/raw\xff` read as a decoy `worktrees/raw�` (sage round 4 on
 * node #86). Which `worktrees/<name>` it is does not matter here: while
 * `extensions.worktreeConfig` is on, every one is in the hash and
 * `readGitState` refuses a name that is not UTF-8; while it is off, git reads
 * no config from any of them.
 */
export async function assertCheckoutOf(cwd: string, canonical: string): Promise<void> {
 const got = await gitBytes(
  [
   ...GIT_SAFETY_ARGS,
   "rev-parse", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir",
  ],
  cwd,
 );
 const [common, gitDir] = got === null ? [] : gitDirLines(got);
 const vetted = realPath(join(canonical, ".git"));
 const commonReal = realPath(common);
 const gitDirReal = realPath(gitDir);
 const ours =
  vetted !== null &&
  commonReal === vetted &&
  gitDirReal !== null &&
  (realPath(cwd) === realPath(canonical)
   ? gitDirReal === vetted
   : dirname(gitDirReal) === realPath(join(canonical, ".git", "worktrees")));
 if (!ours) {
  const shown = (p: string | null) => (p === null ? null : Buffer.from(p, "latin1").toString("utf8"));
  throw new GitSafetyError(
   `refusing a credentialed git call in ${cwd}: git there uses ${shown(gitDirReal) ?? "no repository"} (common dir ${shown(commonReal) ?? "none"}), not the vetted ${join(canonical, ".git")}`,
  );
 }
}

/**
 * Git's stdout as bytes, or null when it fails, exits nonzero or runs past
 * 10s. Awaited, so the supervisor's event loop keeps running meanwhile.
 */
function gitBytes(args: string[], cwd: string): Promise<Buffer | null> {
 return new Promise((resolvePromise) => {
  execFile(
   "git",
   args,
   { cwd, env: minimalGitEnv(), encoding: "buffer", timeout: 10_000, maxBuffer: 1024 * 1024 },
   (error, stdout) => resolvePromise(error === null ? stdout : null),
  );
 });
}

/**
 * `rev-parse`'s two paths, or none unless the output is exactly two nonempty
 * lines each ending in one newline. A path may hold a newline: a common dir
 * named `<canonical>/.git\n<canonical>/.git` printed its first line as the
 * vetted directory, so a split that kept the first two lines accepted a
 * foreign repository (sage round 2 on node #86).
 */
function gitDirLines(stdout: Buffer): [Buffer, Buffer] | [] {
 const first = stdout.indexOf(0x0a);
 if (first <= 0) return [];
 const second = stdout.indexOf(0x0a, first + 1);
 if (second === first + 1 || second !== stdout.length - 1) return [];
 return [stdout.subarray(0, first), stdout.subarray(first + 1, second)];
}

/**
 * A path with every symlink resolved, as a latin1 string: one char per byte,
 * so no two paths collide and `dirname` still splits on "/". Null when it is
 * empty or not there.
 */
function realPath(path: Buffer | string | undefined): string | null {
 if (path === undefined || path.length === 0) return null;
 try {
  return realpathSync(typeof path === "string" ? Buffer.from(path) : path, { encoding: "latin1" });
 } catch {
  return null;
 }
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
 * ranger wrote for its own node branches before node #81 (`bootstrapWorktree`
 * now adds `--no-track`; branches from older builds keep theirs, and an
 * operator's `git worktree add -b` writes them too). Adding a node worktree off
 * origin/<base> wrote `branch."node/…".remote` + `.merge` to the SHARED
 * config, so a second node started in the same clone during a worker session
 * tripped the first one's tamper check (node #63: seelite #212 parked by
 * #663). Remove, don't select: every other record stays in the hash, and a
 * node-branch section is dropped only when it holds exactly `remote=origin`
 * and `merge=refs/heads/<branch>`, or `remote=origin` alone. Any branch
 * name, not only the map's base: the known-good record is one per checkout
 * (two maps on one repo can have two bases), and every git call that carries
 * the write credential names its remote and refs (`assertNamedRefs`), so a
 * tracking target never steers one. Git writes the
 * two keys as separate config writes, remote first (branch.c
 * `install_branch_config_multiple_remotes`), so a snapshot or an assert taken
 * while another node's worktree is being created can see the remote-only
 * section; it is a strict subset of the full one, so dropping it lets nothing
 * through the full rule does not. Merge-only never comes from git's write
 * order and stays in the hash. Parsed by git without includes (an include
 * line is refused, `includeKeys`); a file git cannot parse is hashed raw,
 * never as an empty listing, and anything but a regular file is never read
 * (`readIfFile`). Records keep git's file order, never
 * sorted: for a repeated single-value key the last one wins, so reordering
 * `http.sslVerify` or `core.sshCommand` entries changes what git runs.
 */
function configRecords(
 file: string,
 read: ConfigReader,
): { bytes: Buffer | string; records: Records | null; worktreeConfig: boolean } {
 const body = readIfFile(file);
 if (body === null) return { bytes: "(absent)", records: null, worktreeConfig: true };
 if (body === NOT_A_FILE) return { bytes: NOT_A_FILE_ENTRY, records: null, worktreeConfig: true };
 const records = read.parse(body);
 if (records === null) {
  return { bytes: Buffer.concat([Buffer.from("(unparsed)\0"), body]), records: null, worktreeConfig: true };
 }
 const sections = new Map<string, { key: string; value: string | null }[]>();
 for (const [key, value] of records) {
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
   merge[0].value !== null &&
   isTrackedHead(merge[0].value);
  if (tracksOrigin && (midWrite || complete)) own.add(name);
 }
 const kept = records
  .filter(([key]) => {
   const parsed = branchKey(key);
   return parsed === null || !own.has(parsed.name);
  });
 // [key, value] tuples, never "key=value": a key may hold "=" (a url.<x>
 // subsection), so a joined string lets two different records collide.
 return { bytes: JSON.stringify(kept), records: kept, worktreeConfig: worktreeConfigEnabled(body) };
}

/**
 * A tracking target ranger's node branches may carry: a branch under
 * refs/heads/ by git's own ref-name rules (`git check-ref-format --branch`,
 * refs.c `check_refname_component`), so a base such as `release/été` is one.
 * No control byte, space, `~^:?*[\`, `..` or `@{`; no empty component, none
 * starting with `.` or ending in `.lock`; no trailing `.` and no leading `-`.
 * `refs/heads/@` is a branch: only the whole refname `@` is refused.
 */
function isTrackedHead(ref: string): boolean {
 const prefix = "refs/heads/";
 if (!ref.startsWith(prefix)) return false;
 const name = ref.slice(prefix.length);
 if (name === "" || name.startsWith("-") || name.endsWith(".")) return false;
 if (name.includes("..") || name.includes("@{") || /[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
 return name.split("/").every((c) => c !== "" && !c.startsWith(".") && !c.endsWith(".lock"));
}

/** A config file's `[key, value]` records; a valueless boolean key has a null value. */
type Records = [string, string | null][];

/**
 * Git, run once per distinct config body within one `readGitState`: it
 * reads one `config.worktree` copy per worktree, mostly alike.
 */
interface ConfigReader {
 /** Config bytes to records, or null when git cannot parse them (`listConfig`). */
 parse(body: Buffer): Records | null;
}

function configReader(): ConfigReader {
 const parsed = new Map<string, Records | null>();
 return {
  parse(body) {
   const key = digest(body);
   if (!parsed.has(key)) parsed.set(key, listConfig(body));
   return parsed.get(key) ?? null;
  },
 };
}

/**
 * Config bytes' records in file order, as git parses them (no includes), or
 * null when git cannot parse them. The bytes go in on stdin, so no path is
 * re-encoded on the way. Keys and values are byte strings (latin1, not utf8:
 * one char per byte), so a value with bytes that are not valid UTF-8 (FF vs
 * FE in a command path) never collapses to the same replacement character
 * and hashes alike. Null only when git rejects the bytes (it then refuses
 * them on every call too); a call that fails or is cut short throws, never
 * reads as unparsed: a listing past spawnSync's default 1 MiB output cap
 * (ENOBUFS) once skipped the include check while git still followed it.
 */
function listConfig(body: Buffer): Records | null {
 const listed = spawnSync(
  "git",
  [
   ...GIT_SAFETY_ARGS,
   "config", "--file", "-", "--no-includes", "--list", "--null",
  ],
  { env: minimalGitEnv(), encoding: "latin1", input: body, timeout: 10_000, maxBuffer: Infinity },
 );
 if (listed.error !== undefined || listed.status === null || listed.signal !== null) {
  throw new GitSafetyError(
   `cannot list a git config file to vet it (${listed.error?.message ?? `signal ${listed.signal}`}) — refusing to judge the git state`,
  );
 }
 if (listed.status !== 0) return null;
 // --null: each record ends in NUL; the key ends at the first newline, and a
 // valueless boolean key has none.
 return listed.stdout
  .split("\0")
  .filter((r) => r.length > 0)
  .map((r): Records[number] => {
   const nl = r.indexOf("\n");
   return nl === -1 ? [r, null] : [r.slice(0, nl), r.slice(nl + 1)];
  });
}

/**
 * Whether git reads `config.worktree` files in this repository: the shared
 * config's `extensions.worktreeConfig`, read by git as a bool from the same
 * bytes that are hashed (git takes the repository format from that file
 * alone, never from global or system config). Unset is off; a value git
 * cannot read as a bool, or a failed call, counts as on, so every
 * `config.worktree` stays in the state (fails closed).
 */
function worktreeConfigEnabled(body: Buffer): boolean {
 const got = spawnSync(
  "git",
  [
   ...GIT_SAFETY_ARGS,
   "config", "--file", "-", "--no-includes", "--type=bool", "--get", "extensions.worktreeconfig",
  ],
  { env: minimalGitEnv(), encoding: "utf8", input: body, timeout: 10_000, maxBuffer: Infinity },
 );
 if (got.error === undefined && got.status === 1) return false;
 return !(got.error === undefined && got.status === 0 && got.stdout.trim() === "false");
}

/**
 * The `include.*` and `includeIf.*` keys in `records` (git lists the section
 * lowercased). Ranger never follows an include (decided 2026-10-05 for node
 * #81): five review rounds each found a new way a hand-rolled walker missed
 * the file git reads (unicode paths, `~user/`, symlinks, nesting). Any such
 * key, whatever its variable or condition, refuses the state instead.
 */
function includeKeys(records: Records): string[] {
 return records
  .map(([key]) => key)
  .filter((key) => {
   const dot = key.indexOf(".");
   const section = dot === -1 ? "" : key.slice(0, dot).toLowerCase();
   return section === "include" || section === "includeif";
  });
}

/**
 * Whether a linked worktree's `config.worktree` is git's own copy of the
 * main one. With `extensions.worktreeConfig` on, `git worktree add` copies
 * the adding worktree's `config.worktree` into the new one, less
 * `core.worktree` and a true `core.bare` (worktree.c
 * `copy_filtered_worktree_config`). Every node worktree and every scratch
 * worktree ranger adds would otherwise read as a change to the shared state.
 * Only a copy of the main file counts, never of another linked one: two
 * planted files that copy each other must not both drop out. The copy holds
 * the main file's records in its order, so it sets nothing the main worktree
 * does not already run with.
 */
function isWorktreeConfigCopy(main: Records, linked: Records): boolean {
 const same = (a: Records, b: Records) =>
  a.length === b.length && a.every(([k, v], i) => k === b[i][0] && v === b[i][1]);
 const kept = main.filter(([key]) => key !== "core.worktree");
 return same(linked, kept) || same(linked, kept.filter(([key]) => key !== "core.bare"));
}

/** A main `config.worktree` whose copy git would write empty: it sets only `core.worktree` / `core.bare`, or nothing. */
const setsNothing = (main: Records): boolean => isWorktreeConfigCopy(main, []);

/**
 * The git state as the tamper check reads it: `hash` gates (order-sensitive,
 * every byte of the files `readGitState` lists), `entries` only names what
 * moved. One digest per config key (its values in file order), per
 * `config.worktree` file and per hook, so a mismatch can
 * say `http.sslverify` without the journal ever holding a
 * config value (a remote URL can carry a token). A key can carry one too
 * (`url.https://bot:TOKEN@host/.insteadof`), so URL-keyed subsections are
 * named by digest (`keyLabel`). `includes` names every include key found
 * (`includeKeys`), each with the file that holds it: a state with any is
 * refused, never recorded or adopted.
 */
export interface GitState {
 hash: string;
 entries: Record<string, string>;
 includes: string[];
}

const digest = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/** Sections whose subsection is a URL, which can hold userinfo or a token in the query. */
const URL_SECTIONS = new Set(["url", "http", "credential"]);

/**
 * The name a config key goes by in `GitState.entries`, and so in the
 * journal, park outcomes and cards. A subsection that is a URL, or holds
 * anything but ref-name characters, is replaced by a digest of the whole key:
 * `url.<3f2a…>.insteadof`. Two keys never share a name, and a changed one is
 * still named by section and variable; `git config --list` shows the rest.
 */
export function keyLabel(key: string): string {
 const first = key.indexOf(".");
 const last = key.lastIndexOf(".");
 if (first === -1 || last === first) return key;
 const section = key.slice(0, first).toLowerCase();
 const subsection = key.slice(first + 1, last);
 if (!URL_SECTIONS.has(section) && /^[A-Za-z0-9._/-]*$/.test(subsection)) return key;
 return `${key.slice(0, first)}.<${digest(key).slice(0, 12)}>${key.slice(last)}`;
}

/** The entry value of a linked `config.worktree` that is not there. */
const ABSENT = "(absent)";

/** The entry value of an empty linked `config.worktree`. */
const EMPTY_DIGEST = createHash("sha256").update("").digest("hex");

/** A path that is there but not a regular file: a FIFO, a device, a directory. */
const NOT_A_FILE = Symbol("not a file");
const NOT_A_FILE_ENTRY = "(not a file)";

/**
 * A regular file's bytes; null when nothing is there; `NOT_A_FILE` for
 * anything else, which is never read: a worker could swap the shared config
 * for a FIFO and hang the supervisor's check. Opened non-blocking and
 * checked on the open descriptor, so a swap between check and read cannot
 * slip one in.
 */
function readIfFile(path: string): Buffer | null | typeof NOT_A_FILE {
 let fd: number;
 try {
  fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
 }
 try {
  return fstatSync(fd).isFile() ? readFileSync(fd) : NOT_A_FILE;
 } finally {
  closeSync(fd);
 }
}

/** A config file's records as git parses it; null when it is not a file or git cannot parse it. */
function readConfigFile(file: string, read: ConfigReader): Records | null {
 const body = readIfFile(file);
 return body instanceof Buffer ? read.parse(body) : null;
}

/**
 * The linked worktrees' `config.worktree` files `readGitState` hashes, with
 * the include keys of every one of them added to `includes` (a left-out copy
 * of the main file included). A linked file is left out when it is git's
 * copy of the main one (`isWorktreeConfigCopy`), and when it is empty or
 * missing while the main one sets nothing (so it sets what a copy would).
 * Once the main file sets something, an empty or missing linked file drops
 * that for its worktree (a main `http.sslVerify=true` over a shared
 * `false`), so it is kept: emptying or deleting a copy is a change.
 */
/**
 * A directory's entry names, sorted; throws on a name that is not UTF-8.
 * Node decodes names as UTF-8 by default, which maps every invalid byte to
 * U+FFFD: `worktrees/raw\xff` read as `worktrees/raw�`, so a decoy
 * directory of that name was vetted in place of the one git reads (sage
 * round 4 on node #86). A name is UTF-8 when it survives the round trip
 * byte for byte; `TextDecoder` would also drop a leading BOM.
 */
function entryNames(dir: string): string[] {
 return readdirSync(dir, { encoding: "buffer" })
  .map((bytes) => {
   const name = utf8Name(bytes);
   if (name === null) {
    throw new GitSafetyError(
     `${join(dir, Buffer.from(bytes).toString("utf8"))} has a name that is not UTF-8 (hex ${Buffer.from(bytes).toString("hex")}) — refusing to judge the git state. Remove it, then resume the node.`,
    );
   }
   return name;
  })
  .sort();
}

/** A file name's bytes as a string, or null unless they are UTF-8 (they survive the round trip byte for byte). */
export function utf8Name(bytes: Uint8Array): string | null {
 // Bun's readdirSync hands back plain Uint8Arrays, whose toString lists the bytes.
 const raw = Buffer.from(bytes);
 const name = raw.toString("utf8");
 return Buffer.from(name, "utf8").equals(raw) ? name : null;
}

function linkedWorktreeConfigs(
 gitDir: string,
 main: { present: boolean; records: Records | null },
 includes: (file: string, records: Records) => void,
 read: ConfigReader,
): string[] {
 const worktrees = join(gitDir, "worktrees");
 if (!existsSync(worktrees)) return [];
 const mainSetsNothing = !main.present || (main.records !== null && setsNothing(main.records));
 const kept: string[] = [];
 for (const entry of entryNames(worktrees)) {
  if (statSync(join(worktrees, entry), { throwIfNoEntry: false })?.isDirectory() !== true) continue;
  const file = join(worktrees, entry, "config.worktree");
  const records = readConfigFile(file, read);
  if (records !== null) includes(file, records);
  if (mainSetsNothing && (!existsSync(file) || records?.length === 0)) continue;
  if (records !== null && main.records !== null && isWorktreeConfigCopy(main.records, records)) continue;
  kept.push(file);
 }
 return kept;
}

/**
 * Read the git state a worker could tamper with: the shared `config` (less
 * ranger's own node-branch tracking, see `configRecords`), the main
 * `config.worktree` and the linked ones that set something of their own
 * (`linkedWorktreeConfigs`) while `extensions.worktreeConfig` is on
 * (`worktreeConfigEnabled`), and the hooks directory. Include keys in any
 * of those config files are listed in `includes`; the files they name are
 * never read.
 */
export function readGitState(canonical: string): GitState {
 const gitDir = join(canonical, ".git");
 const hash = createHash("sha256");
 const entries: Record<string, string> = {};
 const includes = new Set<string>();
 const read = configReader();
 const name = (file: string) => file.slice(gitDir.length + 1);
 const noteIncludes = (file: string, records: Records) => {
  for (const key of includeKeys(records)) includes.add(`${keyLabel(key)} in ${name(file)}`);
 };
 // Every part is length-framed, a missing file is "-" where a length would
 // be, and a path that is not a file is "*": bare concatenation let bytes
 // move across a file boundary (hook B deleted, its path and body appended
 // to hook A) and hash alike.
 const part = (data: Buffer | string | null | typeof NOT_A_FILE) => {
  if (data === null || data === NOT_A_FILE) {
   hash.update(data === null ? "-\0" : "*\0");
   return;
  }
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  hash.update(`${bytes.length}\0`);
  hash.update(bytes);
 };
 const add = (file: string, nameAbsent = false): void => {
  part(file);
  const body = readIfFile(file);
  part(body);
  if (body === null) {
   if (nameAbsent) entries[name(file)] = ABSENT;
  } else {
   entries[name(file)] = body === NOT_A_FILE ? NOT_A_FILE_ENTRY : digest(body);
  }
 };
 const config = join(gitDir, "config");
 part(config);
 const listed = configRecords(config, read);
 part(listed.bytes);
 if (listed.records === null) {
  entries[`config ${typeof listed.bytes === "string" ? listed.bytes : "(unparsed)"}`] = digest(listed.bytes);
 } else {
  noteIncludes(config, listed.records);
  const byKey = new Map<string, (string | null)[]>();
  for (const [key, value] of listed.records) {
   const values = byKey.get(key);
   if (values === undefined) byKey.set(key, [value]);
   else values.push(value);
  }
  for (const [key, values] of byKey) entries[keyLabel(key)] = digest(JSON.stringify(values));
 }
 const mainWorktreeConfig = join(gitDir, "config.worktree");
 if (listed.worktreeConfig) {
  const mainPresent = existsSync(mainWorktreeConfig);
  add(mainWorktreeConfig);
  const mainRecords = mainPresent ? readConfigFile(mainWorktreeConfig, read) : null;
  if (mainRecords !== null) noteIncludes(mainWorktreeConfig, mainRecords);
  const linked = linkedWorktreeConfigs(gitDir, { present: mainPresent, records: mainRecords }, noteIncludes, read);
  for (const file of linked) add(file, true);
 } else {
  // Git reads no config.worktree with the extension off, and copies none
  // into a new worktree: the main file hashes as absent (as a state recorded
  // before node #86 did), and no file is read, named or vetted for includes.
  // A leftover main file is not flagged: turning the extension on is a
  // shared-config change, which mismatches, and the file is judged then.
  part(mainWorktreeConfig);
  part(null);
 }
 const hooks = join(gitDir, "hooks");
 if (existsSync(hooks)) {
  for (const entry of entryNames(hooks)) add(join(hooks, entry));
 }
 return { hash: hash.digest("hex"), entries, includes: [...includes].sort() };
}

/**
 * What differs between two states, by name: config keys, `config.worktree`
 * files and hooks, each marked new or gone when only one side has it. Empty
 * when the hashes differ only in record order, which still changes what git
 * runs (`gitStateChanges` callers gate on the hash, never on this list).
 */
export function gitStateChanges(was: GitState["entries"], now: GitState["entries"]): string[] {
 const names = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
 return names.flatMap((name) => {
  if (!(name in was)) return [`${name} (new)`];
  if (!(name in now)) return [`${name} (gone)`];
  return was[name] === now[name] ? [] : [name];
 });
}

/**
 * The hash of `readGitState`: taken before the worker runs, compared by
 * `assertGitUntouched` before any git call after.
 */
export function gitConfigSnapshot(canonical: string): string {
 return readGitState(canonical).hash;
}

/** A linked worktree's file, read as missing or empty. */
const LINKED_CONFIG = /^worktrees\/[^/]+\/config\.worktree$/;

/**
 * `readGitState`, read again a few times while it differs from `expected`
 * and holds a missing or empty linked `config.worktree`: git creates a new
 * worktree's directory before it writes git's copy into it, and creates the
 * copy empty before it fills it, so another node's `git worktree add` or
 * `remove` can be caught midway. Returns the last read; a change that stays
 * is still a change. Waits without blocking the event loop.
 */
export async function readGitStateSettled(canonical: string, expected: string): Promise<GitState> {
 let state = readGitState(canonical);
 for (let attempt = 0; attempt < 3 && state.hash !== expected; attempt++) {
  const midway = Object.entries(state.entries).some(
   ([name, value]) => LINKED_CONFIG.test(name) && (value === ABSENT || value === EMPTY_DIGEST),
  );
  if (!midway) break;
  await Bun.sleep(100);
  state = readGitState(canonical);
 }
 return state;
}

/** The refusal for a state that holds include keys (node #81), naming them. */
export function includeRefusal(includes: string[]): string {
 const names = includes.join(", ");
 return `git config include refused: ${names.length > 200 ? `${names.slice(0, 197)}…` : names} — ranger never follows include paths. Remove the line, then resume the node.`;
}

/**
 * Throw unless the git state still hashes to `snapshot` and holds no
 * include key; returns the state it read (the one it vetted).
 */
export async function assertGitUntouched(canonical: string, snapshot: string): Promise<GitState> {
 const state = await readGitStateSettled(canonical, snapshot);
 if (state.includes.length > 0) throw new GitSafetyError(includeRefusal(state.includes));
 if (state.hash !== snapshot) {
  throw new GitSafetyError(
   "the git config or hooks changed while the worker ran — refusing to run git against a tampered checkout",
  );
 }
 return state;
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
 * `branch`, from an untampered checkout. Returns the state it vetted.
 */
export async function vettedPush(opts: {
 worktree: string;
 canonical: string;
 branch: string;
 token: string;
 configSnapshot: string;
 /** What to push (default HEAD); research pushes its named local branch. */
 source?: string;
}): Promise<GitState> {
 const vetted = await assertGitUntouched(opts.canonical, opts.configSnapshot);
 const push = await safeGit(
  ["push", "--no-verify", "origin", `${opts.source ?? "HEAD"}:refs/heads/${opts.branch}`],
  { cwd: opts.worktree, token: opts.token, canonical: opts.canonical, timeoutMs: 120_000 },
 );
 if (push.code !== 0) {
  throw new GitSafetyError(`push of ${opts.branch} failed: ${push.stderr.trim()}`);
 }
 return vetted;
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
  canonical,
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
