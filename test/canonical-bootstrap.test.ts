import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { gitCredential } from "../src/git-ops.ts";
import { bootstrapCanonical, bootstrapWorktree } from "../src/worker.ts";
import { GIT_ENV } from "./support.ts";

const repo = "acme/widgets";
const credential = gitCredential(repo, "placeholder");
const payload = "a study binary\n".repeat(64);
const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize \d+\n$/;

let dir: string;
let origin: string;
let savedHome: string | undefined;
let savedPath: string | undefined;

const git = async (args: string[], cwd: string) => {
 const result = await runCmd("git", args, { cwd, env: { ...process.env, ...GIT_ENV } });
 if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
 return result.stdout.trim();
};

beforeEach(async () => {
 dir = mkdtempSync(join(tmpdir(), "ranger-canonical-bootstrap-"));
 const home = join(dir, "home");
 mkdirSync(home);
 writeFileSync(
  join(home, ".gitconfig"),
  [
   "[filter \"lfs\"]",
   "\tclean = git-lfs clean -- %f",
   "\tsmudge = git-lfs smudge -- %f",
   "\tprocess = git-lfs filter-process",
   "\trequired = true",
   `[url "file://${join(dir, "origin.git")}"]`,
   `\tinsteadOf = https://github.com/${repo}.git`,
   "",
  ].join("\n"),
 );
 savedHome = process.env.HOME;
 savedPath = process.env.PATH;
 process.env.HOME = home;
 const seed = join(dir, "seed");
 mkdirSync(seed);
 writeFileSync(join(seed, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
 writeFileSync(join(seed, "README.md"), "# acme/widgets\n");
 writeFileSync(join(seed, "model.bin"), payload);
 await git(["init", "-b", "main"], seed);
 await git(["add", "-A"], seed);
 await git(["commit", "-m", "initial"], seed);
 origin = join(dir, "origin.git");
 await git(["clone", "--bare", seed, origin], dir);
 cpSync(join(seed, ".git", "lfs"), join(origin, "lfs"), { recursive: true });
});

afterEach(() => {
 if (savedHome === undefined) delete process.env.HOME;
 else process.env.HOME = savedHome;
 process.env.PATH = savedPath;
 rmSync(dir, { recursive: true, force: true });
});

const lfsObjects = (checkout: string): string[] => {
 const store = join(checkout, ".git", "lfs", "objects");
 return existsSync(store) ? readdirSync(store, { recursive: true }).map(String).filter((p) => /[0-9a-f]{64}$/.test(p)) : [];
};

const fakeGitClone = async (behaviour: string): Promise<void> => {
 const realGit = (await runCmd("sh", ["-c", "command -v git"])).stdout.trim();
 const bin = join(dir, "fake-bin");
 mkdirSync(bin);
 writeFileSync(
  join(bin, "git"),
  [
   "#!/bin/sh",
   "for a; do last=\"$a\"; done",
   "case \" $* \" in",
   " *\" clone \"*)",
   "  mkdir -p \"$last/.git\"",
   "  echo 'ref: refs/heads/main' > \"$last/.git/HEAD\"",
   "  : > \"$last/.git/index.lock\"",
   `  ${behaviour}`,
   "  ;;",
   "esac",
   `exec "${realGit}" "$@"`,
   "",
  ].join("\n"),
 );
 chmodSync(join(bin, "git"), 0o755);
 process.env.PATH = `${bin}:${savedPath}`;
};

describe("bootstrapCanonical: a first clone on a new machine (node #455)", () => {
 test("clones into an owner directory that does not exist yet", async () => {
  const canonical = join(dir, "ranger-repos", "acme", "widgets");
  expect(await bootstrapCanonical(canonical, repo, credential)).toBeTrue();
  expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], canonical)).toBe("main");
 });

 test("a spawn whose working directory is missing names the directory", async () => {
  const missing = join(dir, "no", "such", "dir");
  await expect(runCmd("git", ["--version"], { cwd: missing })).rejects.toThrow(missing);
 });
});

describe("bootstrapCanonical: a slow or failed clone (node #460)", () => {
 test("a clone that runs past its limit is reported as a timeout naming the limit", async () => {
  await fakeGitClone("exec sleep 30");
  const canonical = join(dir, "repos", "widgets");
  await expect(bootstrapCanonical(canonical, repo, credential, { cloneTimeoutMs: 500 })).rejects.toThrow(
   /git clone, timed out after 0\.5 s/,
  );
 });

 for (const [what, behaviour] of [
  ["killed at its limit", "exec sleep 30"],
  ["that exits non-zero", "echo 'fatal: early EOF' >&2; exit 128"],
 ] as const) {
  test(`a clone ${what} leaves nothing a later run accepts`, async () => {
   await fakeGitClone(behaviour);
   const parent = join(dir, "repos");
   const canonical = join(parent, "widgets");
   await expect(bootstrapCanonical(canonical, repo, credential, { cloneTimeoutMs: 500 })).rejects.toThrow(/cannot bootstrap/);
   expect(readdirSync(parent)).toEqual([]);
   process.env.PATH = savedPath;
   expect(await bootstrapCanonical(canonical, repo, credential)).toBeTrue();
   expect(readFileSync(join(canonical, "README.md"), "utf8")).toBe("# acme/widgets\n");
   expect(existsSync(join(canonical, ".git", "index.lock"))).toBeFalse();
  });
 }
});

describe("LFS objects are not downloaded up front (node #460)", () => {
 test("the canonical clone leaves LFS files as pointers and fetches no object", async () => {
  const canonical = join(dir, "canonical");
  expect(await bootstrapCanonical(canonical, repo, credential)).toBeTrue();
  expect(readFileSync(join(canonical, "model.bin"), "utf8")).toMatch(POINTER);
  expect(lfsObjects(canonical)).toEqual([]);
  expect(await git(["status", "--porcelain"], canonical)).toBe("");
 });

 test("a node worktree leaves LFS files as pointers and fetches no object", async () => {
  const canonical = join(dir, "canonical");
  await bootstrapCanonical(canonical, repo, credential);
  const worktree = await bootstrapWorktree(canonical, "460", "lfs", credential);
  expect(readFileSync(join(worktree, "model.bin"), "utf8")).toMatch(POINTER);
  expect(lfsObjects(canonical)).toEqual([]);
  expect(await git(["status", "--porcelain"], worktree)).toBe("");
 });

 test("a worker that needs the content gets it with git lfs pull", async () => {
  const canonical = join(dir, "canonical");
  await bootstrapCanonical(canonical, repo, credential);
  const worktree = await bootstrapWorktree(canonical, "461", "lfs", credential);
  await git(["lfs", "pull"], worktree);
  expect(readFileSync(join(worktree, "model.bin"), "utf8")).toBe(payload);
  expect(await git(["status", "--porcelain"], worktree)).toBe("");
 });
});
