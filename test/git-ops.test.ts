import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import {
 assertGitUntouched,
 gitConfigSnapshot,
 GitSafetyError,
 NODE_BRANCH,
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
  expect(() => assertGitUntouched(canonical, before)).not.toThrow();
 });

 // Git writes remote, then merge, as two config writes: a snapshot or an
 // assert can land between them while another node's worktree is created.
 test("a node branch caught between git's remote and merge writes leaves the snapshot unchanged", async () => {
  const before = gitConfigSnapshot(canonical);
  await config("branch.node/663-x.remote", "origin");
  expect(gitConfigSnapshot(canonical)).toBe(before);
  expect(() => assertGitUntouched(canonical, before)).not.toThrow();
  await config("branch.node/663-x.merge", "refs/heads/main");
  expect(gitConfigSnapshot(canonical)).toBe(before);
  expect(() => assertGitUntouched(canonical, before)).not.toThrow();
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

 test("a node branch tracking anything but a branch under refs/heads stays in the hash", async () => {
  for (const merge of ["refs/tags/v1", "refs/heads/../x", "main"]) {
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

 test("the node-branch pattern matches the branches the worktree code names", () => {
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
  ["an include.path", () => config("include.path", "/tmp/evil.gitconfig")],
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
   expect(() => assertGitUntouched(canonical, before)).toThrow(GitSafetyError);
   expect(() => assertGitUntouched(canonical, before)).toThrow(
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
   expect(() => assertGitUntouched(canonical, before)).toThrow(GitSafetyError);
  });
 }

 // Values are bytes, not UTF-8: two invalid bytes must not hash alike.
 test("a core.sshCommand differing only in a non-UTF-8 byte changes the snapshot", () => {
  const file = join(canonical, ".git", "config");
  const original = readFileSync(file);
  const withByte = (byte: number) =>
   Buffer.concat([original, Buffer.from("[core]\n\tsshCommand = /tmp/ssh"), Buffer.from([byte, 0x0a])]);
  writeFileSync(file, withByte(0xff));
  const one = gitConfigSnapshot(canonical);
  writeFileSync(file, withByte(0xfe));
  expect(gitConfigSnapshot(canonical)).not.toBe(one);
  expect(() => assertGitUntouched(canonical, one)).toThrow(GitSafetyError);
 });

 // A subsection may hold "=": these two records join to the same
 // "key=value" string, yet only the second rewrites GitHub URLs.
 test("moving '=' between a url subsection and its insteadOf value changes the snapshot", () => {
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
  expect(() => assertGitUntouched(canonical, one)).toThrow(GitSafetyError);
 });

 // Bare concatenation hashed path A, body A, path B, body B: deleting B and
 // appending its path and body to A fed the hash the same bytes.
 test("moving a hook's bytes across a file boundary changes the snapshot", () => {
  const hooks = join(canonical, ".git", "hooks");
  const [a, b] = [join(hooks, "zz-a"), join(hooks, "zz-b")];
  writeFileSync(a, "#!/bin/sh\n");
  writeFileSync(b, "exit 0\n");
  const one = gitConfigSnapshot(canonical);
  rmSync(b);
  writeFileSync(a, `#!/bin/sh\n${b}exit 0\n`);
  expect(gitConfigSnapshot(canonical)).not.toBe(one);
  expect(() => assertGitUntouched(canonical, one)).toThrow(GitSafetyError);
 });

 test("an unparseable config is hashed raw: two different broken files differ", () => {
  const file = join(canonical, ".git", "config");
  writeFileSync(file, "[core\n\tbare = false\n");
  const one = gitConfigSnapshot(canonical);
  writeFileSync(file, "[core\n\tbare = true\n");
  expect(gitConfigSnapshot(canonical)).not.toBe(one);
 });
});
