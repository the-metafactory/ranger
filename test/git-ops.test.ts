import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCmd } from "../src/exec.ts";
import {
 assertCheckoutOf,
 assertGitUntouched,
 assertNamedRefs,
 fastForwardCanonical,
 gitConfigSnapshot,
 GitSafetyError,
 NODE_BRANCH,
 safeGit,
 utf8Name,
 vettedPush,
} from "../src/git-ops.ts";
import { bootstrapWorktree, slugify, worktreeBranch } from "../src/worker.ts";
import { addTrackedWorktree, createCanonicalRepo, GIT_ENV } from "./support.ts";

/**
 * Node #63: the tamper guard leaves out only the branch-tracking entries
 * ranger writes for its own node branches, and keeps hashing everything else.
 */

let dir: string;
let canonical: string;

const git = async (args: string[], cwd = canonical) => {
 const result = await runCmd("git", args, { cwd, env: { ...process.env, ...GIT_ENV } });
 if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
 return result.stdout.trim();
};
const config = (...args: string[]) =>
 git(["config", "--file", join(canonical, ".git", "config"), ...args]);

beforeEach(async () => {
 dir = mkdtempSync(join(tmpdir(), "ranger-git-ops-"));
 ({ canonical } = await createCanonicalRepo(dir));
});

afterEach(() => {
 rmSync(dir, { recursive: true, force: true });
});

describe("gitConfigSnapshot: ranger's own node branches (node #63)", () => {
 test("a second node's worktree branch leaves the snapshot unchanged (seelite #212/#663)", async () => {
  const before = gitConfigSnapshot(canonical);
  await addTrackedWorktree(canonical, "663", "stations-are-solid");
  expect(await config("--get", "branch.node/663-stations-are-solid.remote")).toBe("origin");
  expect(await config("--get", "branch.node/663-stations-are-solid.merge")).toBe("refs/heads/main");
  expect(gitConfigSnapshot(canonical)).toBe(before);
  await expect(assertGitUntouched(canonical, before)).resolves.toBeDefined();
 });

 // Git writes remote, then merge, as two config writes: a snapshot or an
 // assert can land between them while another node's worktree is created.
 test("a node branch caught between git's remote and merge writes leaves the snapshot unchanged", async () => {
  const before = gitConfigSnapshot(canonical);
  await config("branch.node/663-x.remote", "origin");
  expect(gitConfigSnapshot(canonical)).toBe(before);
  await expect(assertGitUntouched(canonical, before)).resolves.toBeDefined();
  await config("branch.node/663-x.merge", "refs/heads/main");
  expect(gitConfigSnapshot(canonical)).toBe(before);
  await expect(assertGitUntouched(canonical, before)).resolves.toBeDefined();
 });

 // Node #81: one known-good record per checkout, so the filter is the same
 // for every map base on it.
 test("a branch tracking another map base is left out too", async () => {
  await git(["push", "origin", "HEAD:refs/heads/develop"]);
  await git(["fetch", "origin"]);
  const before = gitConfigSnapshot(canonical);
  await addTrackedWorktree(canonical, "70", "on-develop", "develop");
  expect(await config("--get", "branch.node/70-on-develop.merge")).toBe("refs/heads/develop");
  expect(gitConfigSnapshot(canonical)).toBe(before);
 });

 // Sage round 2 on node #86: git takes non-ASCII branch names.
 test("a branch tracking a non-ASCII map base is left out too", async () => {
  await git(["push", "origin", "HEAD:refs/heads/release/été"]);
  await git(["fetch", "origin"]);
  const before = gitConfigSnapshot(canonical);
  await addTrackedWorktree(canonical, "72", "on-release", "release/été");
  expect(await config("--get", "branch.node/72-on-release.merge")).toBe("refs/heads/release/été");
  expect(gitConfigSnapshot(canonical)).toBe(before);
 });

 // Sage round 3 on node #86: only the whole refname `@` is refused, so
 // refs/heads/@ is a branch git takes.
 test("a branch tracking refs/heads/@ is left out too", async () => {
  await git(["push", "origin", "HEAD:refs/heads/@"]);
  await git(["fetch", "origin"]);
  const before = gitConfigSnapshot(canonical);
  await addTrackedWorktree(canonical, "73", "on-at", "@");
  expect(await config("--get", "branch.node/73-on-at.merge")).toBe("refs/heads/@");
  expect(gitConfigSnapshot(canonical)).toBe(before);
 });

 test("a node branch tracking anything but a branch under refs/heads stays in the hash", async () => {
  for (const merge of [
   "refs/tags/v1",
   "refs/heads/../x",
   "main",
   "refs/heads/.x",
   "refs/heads/x.lock",
   "refs/heads/a b",
   "refs/heads/a//b",
   "refs/heads/-x",
  ]) {
   const before = gitConfigSnapshot(canonical);
   await config("branch.node/71-x.remote", "origin");
   await config("branch.node/71-x.merge", merge);
   expect(gitConfigSnapshot(canonical)).not.toBe(before);
   await config("--remove-section", "branch.node/71-x");
  }
 });

 // Node #81: ranger's own worktrees write no tracking lines, whatever the
 // operator's branch.autoSetup* settings, so the state stays put.
 test("bootstrapWorktree writes no tracking lines under autoSetupRebase and autoSetupMerge=always", async () => {
  await config("branch.autoSetupRebase", "always");
  await config("branch.autoSetupMerge", "always");
  const before = gitConfigSnapshot(canonical);
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  await bootstrapWorktree(canonical, "64", "x", "tok", "feature/other");
  const listed = await config("--list");
  expect(listed).not.toContain("branch.node/");
  expect(listed).not.toContain("branch.feature/");
  expect(gitConfigSnapshot(canonical)).toBe(before);
 });

 test("the node-branch pattern matches the branches the worktree code names", async () => {
  for (const title of [
   "Tamper guard: ignore ranger's own node-branch tracking lines",
   "x",
   "",
   "Stations are solid — wire the pro…",
  ]) {
   expect(NODE_BRANCH.test(worktreeBranch("63", slugify(title)))).toBe(true);
  }
  expect(NODE_BRANCH.test("research/node-63")).toBe(false);
  expect(NODE_BRANCH.test("node/x-63")).toBe(false);
 });
});

describe("gitConfigSnapshot: everything else stays in the hash", () => {
 const changes: [string, () => Promise<unknown>][] = [
  ["core.hooksPath", () => config("core.hooksPath", "/tmp/hooks")],
  ["a url.<x>.insteadOf", () => config("url.https://evil.example/.insteadOf", "https://github.com/")],
  ["a credential.helper", () => config("credential.helper", "!evil")],
  [
   "a new hook file",
   async () => {
    const hook = join(canonical, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    chmodSync(hook, 0o755);
   },
  ],
  [
   "a node-branch section that gains pushRemote",
   async () => {
    await addTrackedWorktree(canonical, "663", "x");
    // The snapshot taken after the branch exists, then the section grows.
    const mid = gitConfigSnapshot(canonical);
    await config("branch.node/663-x.pushRemote", "origin");
    expect(gitConfigSnapshot(canonical)).not.toBe(mid);
   },
  ],
  [
   "a node-branch remote other than origin",
   async () => {
    await config("branch.node/663-x.remote", "evil");
    await config("branch.node/663-x.merge", "refs/heads/main");
   },
  ],
  ["a remote-only node-branch section with another remote", () => config("branch.node/663-x.remote", "evil")],
  ["a merge-only node-branch section", () => config("branch.node/663-x.merge", "refs/heads/main")],
  ["a remote-only non-node branch section", () => config("branch.feature/x.remote", "origin")],
  [
   "a node-branch merge target outside refs/heads",
   async () => {
    await config("branch.node/663-x.remote", "origin");
    await config("branch.node/663-x.merge", "refs/remotes/origin/main");
   },
  ],
  [
   "a node-branch section with a rebase line (autoSetupRebase)",
   async () => {
    await config("branch.node/663-x.remote", "origin");
    await config("branch.node/663-x.merge", "refs/heads/main");
    await config("branch.node/663-x.rebase", "true");
   },
  ],
  [
   "a duplicated node-branch key",
   async () => {
    await config("branch.node/663-x.remote", "origin");
    await config("branch.node/663-x.merge", "refs/heads/main");
    await config("--add", "branch.node/663-x.merge", "refs/heads/main");
   },
  ],
  [
   "a non-node branch section",
   async () => {
    await config("branch.feature/x.remote", "origin");
    await config("branch.feature/x.merge", "refs/heads/main");
   },
  ],
  [
   "a per-worktree config.worktree",
   async () => {
    // Git reads config.worktree only with the extension on (node #86).
    await config("extensions.worktreeConfig", "true");
    await bootstrapWorktree(canonical, "663", "x", "tok");
    const [entry] = readdirSync(join(canonical, ".git", "worktrees"));
    // The snapshot taken after the worktree exists, then its config changes.
    const mid = gitConfigSnapshot(canonical);
    writeFileSync(
     join(canonical, ".git", "worktrees", entry, "config.worktree"),
     "[core]\n\tsshCommand = evil\n",
    );
    expect(gitConfigSnapshot(canonical)).not.toBe(mid);
   },
  ],
  [
   "a config git cannot parse",
   async () => {
    writeFileSync(join(canonical, ".git", "config"), "[core\n\tbare = false\n");
   },
  ],
 ];

 for (const [what, change] of changes) {
  test(`${what} changes the snapshot`, async () => {
   const before = gitConfigSnapshot(canonical);
   await change();
   expect(gitConfigSnapshot(canonical)).not.toBe(before);
   await expect(assertGitUntouched(canonical, before)).rejects.toThrow(GitSafetyError);
   await expect(assertGitUntouched(canonical, before)).rejects.toThrow(
    "the git config or hooks changed while the worker ran — refusing to run git against a tampered checkout",
   );
  });
 }

 // The last of a repeated single-value key wins, so order is behaviour.
 for (const [key, first, second] of [
  ["http.sslVerify", "false", "true"],
  ["core.sshCommand", "ssh -o ProxyCommand=evil", "ssh"],
 ]) {
  test(`reversing repeated ${key} entries changes the snapshot`, async () => {
   await config("--add", key, first);
   await config("--add", key, second);
   const before = gitConfigSnapshot(canonical);
   await config("--unset-all", key);
   await config("--add", key, second);
   await config("--add", key, first);
   expect(await config("--get", key)).toBe(first);
   expect(gitConfigSnapshot(canonical)).not.toBe(before);
   await expect(assertGitUntouched(canonical, before)).rejects.toThrow(GitSafetyError);
  });
 }

 // Values are bytes, not UTF-8: two invalid bytes must not hash alike.
 test("a core.sshCommand differing only in a non-UTF-8 byte changes the snapshot", async () => {
  const file = join(canonical, ".git", "config");
  const original = readFileSync(file);
  const withByte = (byte: number) =>
   Buffer.concat([original, Buffer.from("[core]\n\tsshCommand = /tmp/ssh"), Buffer.from([byte, 0x0a])]);
  writeFileSync(file, withByte(0xff));
  const one = gitConfigSnapshot(canonical);
  writeFileSync(file, withByte(0xfe));
  expect(gitConfigSnapshot(canonical)).not.toBe(one);
  await expect(assertGitUntouched(canonical, one)).rejects.toThrow(GitSafetyError);
 });

 // A subsection may hold "=": these two records join to the same
 // "key=value" string, yet only the second rewrites GitHub URLs.
 test("moving '=' between a url subsection and its insteadOf value changes the snapshot", async () => {
  const file = join(canonical, ".git", "config");
  const original = readFileSync(file, "utf8");
  writeFileSync(
   file,
   `${original}[url "https://github.com"]\n\tinsteadOf = @evil.example/.insteadof=https://github.com/\n`,
  );
  const one = gitConfigSnapshot(canonical);
  writeFileSync(
   file,
   `${original}[url "https://github.com.insteadof=@evil.example/"]\n\tinsteadOf = https://github.com/\n`,
  );
  expect(gitConfigSnapshot(canonical)).not.toBe(one);
  await expect(assertGitUntouched(canonical, one)).rejects.toThrow(GitSafetyError);
 });

 // Bare concatenation hashed path A, body A, path B, body B: deleting B and
 // appending its path and body to A fed the hash the same bytes.
 test("moving a hook's bytes across a file boundary changes the snapshot", async () => {
  const hooks = join(canonical, ".git", "hooks");
  const [a, b] = [join(hooks, "zz-a"), join(hooks, "zz-b")];
  writeFileSync(a, "#!/bin/sh\n");
  writeFileSync(b, "exit 0\n");
  const one = gitConfigSnapshot(canonical);
  rmSync(b);
  writeFileSync(a, `#!/bin/sh\n${b}exit 0\n`);
  expect(gitConfigSnapshot(canonical)).not.toBe(one);
  await expect(assertGitUntouched(canonical, one)).rejects.toThrow(GitSafetyError);
 });

 test("an unparseable config is hashed raw: two different broken files differ", async () => {
  const file = join(canonical, ".git", "config");
  writeFileSync(file, "[core\n\tbare = false\n");
  const one = gitConfigSnapshot(canonical);
  writeFileSync(file, "[core\n\tbare = true\n");
  expect(gitConfigSnapshot(canonical)).not.toBe(one);
 });
});

describe("assertGitUntouched: include keys (node #81)", () => {
 test("an include added while the worker ran is refused by name", async () => {
  const before = gitConfigSnapshot(canonical);
  await config("include.path", "/tmp/evil.gitconfig");
  await expect(assertGitUntouched(canonical, before)).rejects.toThrow(
   /^git config include refused: include\.path in config/,
  );
 });

 test("an include present in the snapshot itself is still refused", async () => {
  await config("includeIf.gitdir:/x/.path", "/tmp/evil.gitconfig");
  await expect(assertGitUntouched(canonical, gitConfigSnapshot(canonical))).rejects.toThrow(/include refused/);
 });
});

/**
 * The tamper state leaves node branches' tracking lines out, safe only while
 * no credentialed git call falls back to a branch's upstream.
 */
describe("assertNamedRefs: credentialed git calls name their remote and refs", () => {
 test("the calls ranger makes pass", () => {
  for (const args of [
   ["fetch", "origin", "main"],
   ["push", "--no-verify", "origin", "HEAD:refs/heads/node/81-x"],
   ["clone", "https://github.com/acme/widgets.git", "/tmp/x"],
   ["worktree", "add", "--no-track", "/tmp/x", "-b", "node/81-x", "origin/main"],
  ]) {
   expect(() => assertNamedRefs(args)).not.toThrow();
  }
 });

 test("an upstream fallback is refused", () => {
  for (const args of [
   ["fetch"],
   ["fetch", "origin"],
   ["push"],
   ["push", "--no-verify", "origin"],
   ["pull", "origin", "main"],
   ["remote", "update"],
  ]) {
   expect(() => assertNamedRefs(args)).toThrow(GitSafetyError);
  }
 });

 // Sage round 4 on node #86: submodules fetch from config the hash never vets.
 test("a request for submodule recursion is refused", () => {
  for (const args of [
   ["fetch", "--recurse-submodules", "origin", "main"],
   ["fetch", "--recurse-submodules=on-demand", "origin", "main"],
   ["push", "--recurse-submodules=on-demand", "origin", "HEAD:refs/heads/node/81-x"],
   ["clone", "--recurse-submodules", "https://github.com/acme/widgets.git", "/tmp/x"],
  ]) {
   expect(() => assertNamedRefs(args)).toThrow(/submodules/);
  }
 });

 test("safeGit runs the guard on every call that carries the credential", async () => {
  await expect(safeGit(["pull"], { cwd: canonical, token: "placeholder" })).rejects.toThrow(GitSafetyError);
 });
});

/**
 * Sage round 1 on node #86: the hash vets `<canonical>/.git`, so a
 * credentialed call runs only where git resolves to that directory. A
 * worktree's `.git` file or `commondir` pointed at another repository would
 * otherwise read that repository's origin and send the credential there.
 */
describe("assertCheckoutOf: credentialed calls run only against the vetted .git", () => {
 let origin: string;
 let evil: string;
 let attacker: string;

 beforeEach(async () => {
  origin = await git(["remote", "get-url", "origin"]);
  evil = join(dir, "evil.git");
  await git(["init", "--bare", evil], dir);
  attacker = join(dir, "attacker");
  await git(["clone", origin, attacker], dir);
  await git(["remote", "set-url", "origin", evil], attacker);
 });

 const push = (worktree: string, snapshot: string) =>
  vettedPush({ worktree, canonical, branch: "node/86-x", token: "placeholder", configSnapshot: snapshot });
 const evilHeads = () => git(["for-each-ref", "refs/heads"], evil);

 test("a clean node worktree pushes to the vetted origin", async () => {
  const worktree = await bootstrapWorktree(canonical, "86", "x", "placeholder");
  await push(worktree, gitConfigSnapshot(canonical));
  expect(await git(["for-each-ref", "--format=%(refname)", "refs/heads/node/86-x"], origin)).toBe("refs/heads/node/86-x");
 });

 test("a worktree commondir pointed at another repository refuses the push", async () => {
  const worktree = await bootstrapWorktree(canonical, "86", "x", "placeholder");
  const snapshot = gitConfigSnapshot(canonical);
  writeFileSync(join(canonical, ".git", "worktrees", "node-86", "commondir"), `${join(attacker, ".git")}\n`);
  expect(gitConfigSnapshot(canonical)).toBe(snapshot);
  await expect(push(worktree, snapshot)).rejects.toThrow(/not the vetted/);
  expect(await evilHeads()).toBe("");
 });

 test("a worktree .git file pointed at another repository refuses the push", async () => {
  const worktree = await bootstrapWorktree(canonical, "86", "x", "placeholder");
  const snapshot = gitConfigSnapshot(canonical);
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(attacker, ".git")}\n`);
  await expect(push(worktree, snapshot)).rejects.toThrow(/not the vetted/);
  expect(await evilHeads()).toBe("");
 });

 test("a worktree with no .git file (git climbs to the canonical checkout) refuses the push", async () => {
  const worktree = await bootstrapWorktree(canonical, "86", "x", "placeholder");
  const snapshot = gitConfigSnapshot(canonical);
  rmSync(join(worktree, ".git"));
  await expect(push(worktree, snapshot)).rejects.toThrow(/not the vetted/);
 });

 test("a commondir planted in the canonical .git refuses the fetch and the worktree add", async () => {
  writeFileSync(join(canonical, ".git", "commondir"), `${join(attacker, ".git")}\n`);
  await expect(fastForwardCanonical(canonical, "main", "placeholder", { attempts: 1 })).rejects.toThrow(/not the vetted/);
  await expect(bootstrapWorktree(canonical, "86", "x", "placeholder")).rejects.toThrow(/not the vetted/);
 });

 // Sage round 2 on node #86: a path may hold a newline, and the first line
 // of a common dir named `<canonical>/.git\n<canonical>/.git` is the vetted one.
 test("a commondir whose path embeds the vetted .git after a newline refuses the fetch", async () => {
  const vetted = join(canonical, ".git");
  const foreign = `${vetted}\n${vetted}`;
  mkdirSync(dirname(foreign), { recursive: true });
  renameSync(join(attacker, ".git"), foreign);
  writeFileSync(join(vetted, "commondir"), `${foreign}\n`);
  await expect(assertCheckoutOf(canonical, canonical)).rejects.toThrow(/not the vetted/);
  await expect(fastForwardCanonical(canonical, "main", "placeholder", { attempts: 1 })).rejects.toThrow(/not the vetted/);
 });

 test("a worktree commondir whose path embeds the vetted lines after a newline refuses the push", async () => {
  const worktree = await bootstrapWorktree(canonical, "86", "x", "placeholder");
  const snapshot = gitConfigSnapshot(canonical);
  const vetted = join(canonical, ".git");
  const foreign = `${vetted}\n${join(vetted, "worktrees", "node-86")}`;
  mkdirSync(dirname(foreign), { recursive: true });
  renameSync(join(attacker, ".git"), foreign);
  writeFileSync(join(vetted, "worktrees", "node-86", "commondir"), `${foreign}\n`);
  expect(gitConfigSnapshot(canonical)).toBe(snapshot);
  await expect(push(worktree, snapshot)).rejects.toThrow(/not the vetted/);
  expect(await evilHeads()).toBe("");
 });

 test("a credentialed call that names no canonical checkout is refused", async () => {
  await expect(safeGit(["fetch", "origin", "main"], { cwd: canonical, token: "placeholder" })).rejects.toThrow(
   /names no canonical checkout/,
  );
  await expect(assertCheckoutOf(canonical, canonical)).resolves.toBeUndefined();
 });

 // Sage round 4 on node #86: node decodes `worktrees/raw\xff` as
 // `worktrees/raw�`, so an empty decoy directory of that name was
 // vetted while git read the raw-byte one. APFS refuses names that are not
 // UTF-8 (EILSEQ); ext4 (CI) takes them.
 test.skipIf(!takesRawByteNames())("a worktree whose git dir name is not UTF-8 refuses the push", async () => {
  const worktree = await bootstrapWorktree(canonical, "86", "x", "placeholder");
  const snapshot = gitConfigSnapshot(canonical);
  const worktrees = join(canonical, ".git", "worktrees");
  const raw = Buffer.concat([Buffer.from(`${worktrees}/raw`), Buffer.from([0xff])]);
  renameSync(join(worktrees, "node-86"), raw);
  mkdirSync(join(worktrees, "raw�"));
  writeFileSync(join(worktree, ".git"), Buffer.concat([Buffer.from("gitdir: "), raw, Buffer.from("\n")]));
  writeFileSync(Buffer.concat([raw, Buffer.from("/config.worktree")]), `[remote "origin"]\n\turl = ${evil}\n`);
  expect(() => gitConfigSnapshot(canonical)).toThrow(/not UTF-8/);
  await expect(push(worktree, snapshot)).rejects.toThrow(/not UTF-8/);
  expect(await evilHeads()).toBe("");
 });

 test.skipIf(!takesRawByteNames())("a hook name that is not UTF-8 is refused, never read under a decoded name", () => {
  const hooks = join(canonical, ".git", "hooks");
  writeFileSync(Buffer.concat([Buffer.from(`${hooks}/pre-push`), Buffer.from([0xfe])]), "#!/bin/sh\n");
  expect(() => gitConfigSnapshot(canonical)).toThrow(/not UTF-8/);
 });
});

describe("utf8Name: entry names are judged as bytes (sage round 4 on node #86)", () => {
 test("bytes that are not UTF-8 have no name", () => {
  expect(utf8Name(new Uint8Array([0x72, 0x61, 0x77, 0xff]))).toBeNull();
  // A UTF-16 surrogate encoded as UTF-8 (CESU-8) is not UTF-8 either.
  expect(utf8Name(new Uint8Array([0xed, 0xa0, 0x80]))).toBeNull();
 });

 test("UTF-8 names keep every byte, a leading BOM included", () => {
  expect(utf8Name(Buffer.from("été"))).toBe("été");
  expect(utf8Name(Buffer.from("﻿node-86"))).toBe("﻿node-86");
  expect(utf8Name(Buffer.from("raw�"))).toBe("raw�");
 });
});

/**
 * Whether the temp filesystem takes a file name that is not UTF-8. APFS
 * refuses one (EILSEQ); any other error is a broken probe, never a skip.
 */
function takesRawByteNames(): boolean {
 const probe = mkdtempSync(join(tmpdir(), "ranger-raw-name-"));
 try {
  writeFileSync(Buffer.concat([Buffer.from(`${probe}/x`), Buffer.from([0xff])]), "");
  return true;
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EILSEQ") return false;
  throw error;
 } finally {
  rmSync(probe, { recursive: true, force: true });
 }
}

/**
 * Sage round 4 on node #86: `git fetch` fetches submodules on demand, each
 * from its own `.git/modules/<name>/config`, which the hash never covers,
 * and the child fetch inherits the auth header. A credentialed fetch turns
 * recursion off.
 */
describe("credentialed calls never recurse into submodules", () => {
 let home: string | undefined;

 beforeEach(() => {
  home = process.env.HOME;
  // Git 2.38.1+ refuses file:// submodule transport by default; the fixture
  // remotes are local paths. minimalGitEnv passes HOME through.
  const fakeHome = join(dir, "home");
  mkdirSync(fakeHome);
  writeFileSync(join(fakeHome, ".gitconfig"), "[protocol \"file\"]\n\tallow = always\n");
  process.env.HOME = fakeHome;
 });

 afterEach(() => {
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
 });

 test("a fetch that brings a new submodule commit leaves the submodule's remote alone", async () => {
  const commit = async (repo: string, file: string) => {
   writeFileSync(join(repo, file), `${file}\n`);
   await git(["add", "-A"], repo);
   await git(["commit", "-m", file], repo);
   return git(["rev-parse", "HEAD"], repo);
  };
  // A submodule whose remote the worker repoints at a repository it owns.
  const subSeed = join(dir, "sub-seed");
  mkdirSync(subSeed);
  await git(["init", "-b", "main"], subSeed);
  await commit(subSeed, "a");
  const subOrigin = join(dir, "sub.git");
  await git(["clone", "--bare", subSeed, subOrigin], dir);
  const super_ = join(dir, "super");
  await git(["clone", await git(["remote", "get-url", "origin"]), super_], dir);
  await git(["submodule", "add", subOrigin, "sub"], super_);
  await git(["commit", "-m", "add sub"], super_);
  await git(["push", "origin", "HEAD:main"], super_);
  await git(["pull", "--ff-only", "origin", "main"]);
  await git(["submodule", "update", "--init"]);
  const evilSub = join(dir, "evil-sub.git");
  await git(["clone", "--bare", subOrigin, evilSub], dir);
  // Upstream moves the submodule to a commit only the worker's remote holds.
  await git(["remote", "add", "evil", evilSub], subSeed);
  const bumped = await commit(subSeed, "b");
  await git(["push", "evil", "HEAD:main"], subSeed);
  await git(["fetch", evilSub, "main"], join(super_, "sub"));
  await git(["checkout", bumped], join(super_, "sub"));
  await git(["commit", "-am", "bump sub"], super_);
  await git(["push", "origin", "HEAD:main"], super_);
  await git(["config", "--file", join(canonical, ".git", "modules", "sub", "config"), "remote.origin.url", evilSub]);

  const snapshot = gitConfigSnapshot(canonical);
  const modules = join(canonical, ".git", "modules", "sub");
  const has = async (sha: string) => (await runCmd("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: modules })).code === 0;
  await fastForwardCanonical(canonical, "main", "placeholder", { attempts: 1 });
  expect(gitConfigSnapshot(canonical)).toBe(snapshot);
  expect(await has(bumped)).toBe(false);
  // The control: git's own default fetch does reach the submodule's remote.
  await git(["reset", "--hard", "HEAD~1"]);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(["fetch", "origin", "main:refs/remotes/origin/main"]);
  expect(await has(bumped)).toBe(true);
 });
});
