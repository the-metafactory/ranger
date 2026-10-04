import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { createCanonicalRepo, GIT_ENV } from "./support.ts";

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
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  expect(await config("--get", "branch.node/663-stations-are-solid.remote")).toBe("origin");
  expect(await config("--get", "branch.node/663-stations-are-solid.merge")).toBe("refs/heads/main");
  expect(gitConfigSnapshot(canonical)).toBe(before);
  expect(() => assertGitUntouched(canonical, before)).not.toThrow();
 });

 test("a branch tracking a non-main map base is left out under that base only", async () => {
  await git(["push", "origin", "HEAD:refs/heads/develop"]);
  await git(["fetch", "origin"]);
  const before = gitConfigSnapshot(canonical, "develop");
  const beforeMain = gitConfigSnapshot(canonical);
  await bootstrapWorktree(canonical, "70", "on-develop", "tok", undefined, "develop");
  expect(gitConfigSnapshot(canonical, "develop")).toBe(before);
  expect(gitConfigSnapshot(canonical)).not.toBe(beforeMain);
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
    await bootstrapWorktree(canonical, "663", "x", "tok");
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
  [
   "a node-branch merge target other than the map base",
   async () => {
    await config("branch.node/663-x.remote", "origin");
    await config("branch.node/663-x.merge", "refs/heads/other");
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

 test("an unparseable config is hashed raw: two different broken files differ", () => {
  const file = join(canonical, ".git", "config");
  writeFileSync(file, "[core\n\tbare = false\n");
  const one = gitConfigSnapshot(canonical);
  writeFileSync(file, "[core\n\tbare = true\n");
  expect(gitConfigSnapshot(canonical)).not.toBe(one);
 });
});
