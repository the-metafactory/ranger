import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { stageSource, restoreSource, SourceError, type SourceErrorCode } from "../src/remote-test/source.ts";

const roots: string[] = [];
const jobId = "6c7e8091-1234-4234-8234-123456789abc";
async function git(cwd: string, ...args: string[]) {
 const r = await runCmd("git", args, { cwd });
 if (r.code) throw new Error(r.stderr);
 return r.stdout.trim();
}
async function fixture(format: "sha1" | "sha256" = "sha1") {
 const root = await mkdtemp(join(tmpdir(), "ranger-source-")); roots.push(root);
 const repo = join(root, "repo"), stagingRoot = join(root, "staging"), jobsRoot = join(root, "jobs");
 await Promise.all([mkdir(repo), mkdir(stagingRoot), mkdir(jobsRoot)]);
 await git(repo, "init", "--initial-branch=main", `--object-format=${format}`);
 await git(repo, "config", "user.name", "Source Test");
 await git(repo, "config", "user.email", "source@example.invalid");
 await writeFile(join(repo, "hello.txt"), "ancestor\n");
 await git(repo, "add", "."); await git(repo, "commit", "-m", "ancestor");
 const ancestor = await git(repo, "rev-parse", "HEAD");
 await writeFile(join(repo, "hello.txt"), "unpushed\n");
 await git(repo, "commit", "-am", "unpushed");
 return { root, repo, stagingRoot, jobsRoot, ancestor };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function code(p: Promise<unknown>, expected: SourceErrorCode) {
 try { await p; throw new Error("Expected failure"); }
 catch (e) { expect(e).toBeInstanceOf(SourceError); expect((e as SourceError).code).toBe(expected); }
}

test("stages an unpushed HEAD and restores exact detached commit, tree and ancestry", async () => {
 const f = await fixture();
 const staged = await stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId });
 expect(staged.manifest.commitDigest).toBe(await git(f.repo, "rev-parse", "HEAD"));
 expect(staged.manifest.treeDigest).toBe(await git(f.repo, "rev-parse", "HEAD^{tree}"));
 expect(staged.manifest.bundleDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
 expect(JSON.parse(await readFile(staged.manifestPath, "utf8"))).toEqual(staged.manifest);
 const restored = await restoreSource({ bundlePath: staged.bundlePath, manifest: staged.manifest, jobsRoot: f.jobsRoot, jobId });
 expect(await git(restored.checkoutPath, "rev-parse", "HEAD")).toBe(staged.manifest.commitDigest);
 expect(await git(restored.checkoutPath, "rev-parse", "HEAD^{tree}")).toBe(staged.manifest.treeDigest);
 expect(await git(restored.checkoutPath, "cat-file", "-t", f.ancestor)).toBe("commit");
 expect(await git(restored.checkoutPath, "status", "--porcelain")).toBe("");
 expect((await runCmd("git", ["symbolic-ref", "-q", "HEAD"], { cwd: restored.checkoutPath })).code).not.toBe(0);
 expect(await readFile(join(restored.checkoutPath, "hello.txt"), "utf8")).toBe("unpushed\n");
});

for (const dirty of ["tracked", "untracked", "staged", "assume-unchanged", "skip-worktree"] as const) {
 test(`rejects ${dirty} source before staging`, async () => {
  const f = await fixture();
  if (dirty === "assume-unchanged" || dirty === "skip-worktree") await git(f.repo, "update-index", `--${dirty}`, "hello.txt");
  await writeFile(join(f.repo, dirty === "untracked" ? "new.txt" : "hello.txt"), "dirty\n");
  if (dirty === "staged") await git(f.repo, "add", ".");
  await code(stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId }), "dirty_source");
  expect(await readdir(f.stagingRoot)).toEqual([]);
 });
}
for (const kind of ["submodule", "lfs-attributes", "lfs-pointer"] as const) {
 test(`rejects unsupported ${kind}`, async () => {
  const f = await fixture();
  if (kind === "submodule") await git(f.repo, "update-index", "--add", "--cacheinfo", `160000,${f.ancestor},nested`);
  else {
   await writeFile(join(f.repo, kind === "lfs-attributes" ? ".gitattributes" : "data.bin"), kind === "lfs-attributes" ? "*.bin filter=lfs diff=lfs\n" : "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 1\n");
   await git(f.repo, "add", ".");
  }
  await git(f.repo, "commit", "-m", "unsupported");
  if (kind === "lfs-pointer") await git(f.repo, "config", "grep.patternType", "fixed");
  await code(stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId }), "unsupported_source");
  const bundlePath = join(f.root, "incoming.bundle");
  await git(f.repo, "bundle", "create", bundlePath, "HEAD");
  const manifest = { version: 1, commitDigest: await git(f.repo, "rev-parse", "HEAD"), treeDigest: await git(f.repo, "rev-parse", "HEAD^{tree}"), bundleDigest: "sha256:" + createHash("sha256").update(await readFile(bundlePath)).digest("hex") };
  await code(restoreSource({ bundlePath, manifest, jobsRoot: f.jobsRoot, jobId }), "unsupported_source");
  expect(await readdir(f.jobsRoot)).toEqual([]);
 });
}
test("rejects wrong digest, missing commit and wrong tree without leaving a checkout", async () => {
 const f = await fixture(), staged = await stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId });
 for (const [field, value, error] of [
  ["bundleDigest", "sha256:" + "0".repeat(64), "digest_mismatch"],
  ["commitDigest", "0".repeat(40), "invalid_bundle"],
  ["treeDigest", "0".repeat(40), "identity_mismatch"],
 ] as const) {
  await code(restoreSource({ bundlePath: staged.bundlePath, manifest: { ...staged.manifest, [field]: value }, jobsRoot: f.jobsRoot, jobId }), error);
  expect(await readdir(f.jobsRoot)).toEqual([]);
 }
 await writeFile(staged.bundlePath, "corrupt");
 await code(restoreSource({ bundlePath: staged.bundlePath, manifest: staged.manifest, jobsRoot: f.jobsRoot, jobId }), "digest_mismatch");
});
test("rejects an incremental bundle whose prerequisite is absent", async () => {
 const f = await fixture(), bundlePath = join(f.root, "incremental.bundle");
 await git(f.repo, "bundle", "create", bundlePath, "HEAD", `^${f.ancestor}`);
 const manifest = { version: 1, commitDigest: await git(f.repo, "rev-parse", "HEAD"), treeDigest: await git(f.repo, "rev-parse", "HEAD^{tree}"), bundleDigest: "sha256:" + createHash("sha256").update(await readFile(bundlePath)).digest("hex") };
 await code(restoreSource({ bundlePath, manifest, jobsRoot: f.jobsRoot, jobId }), "invalid_bundle");
 expect(await readdir(f.jobsRoot)).toEqual([]);
});
test("rejects unsafe job IDs, revisions, extra manifest authority and existing job paths", async () => {
 const f = await fixture();
 for (const unsafe of ["../escape", "--upload-pack=bad", "/absolute", "a/b", "x\0y"]) {
  await code(stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId: unsafe }), "invalid_input");
  const manifest = { version: 1, commitDigest: "a".repeat(40), treeDigest: "b".repeat(40), bundleDigest: "sha256:" + "c".repeat(64) };
  await code(restoreSource({ bundlePath: join(f.root, "incoming.bundle"), manifest, jobsRoot: f.jobsRoot, jobId: unsafe }), "invalid_input");
 }
 await code(stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId, commitDigest: "--help" }), "invalid_input");
 const staged = await stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId });
 await code(stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId }), "path_conflict");
 await code(restoreSource({ bundlePath: staged.bundlePath, manifest: { ...staged.manifest, commands: ["bad"] }, jobsRoot: f.jobsRoot, jobId }), "invalid_input");
 await symlink(f.repo, join(f.jobsRoot, jobId));
 await code(restoreSource({ bundlePath: staged.bundlePath, manifest: staged.manifest, jobsRoot: f.jobsRoot, jobId }), "path_conflict");
 expect(await readFile(join(f.repo, "hello.txt"), "utf8")).toBe("unpushed\n");
});
test("refuses a requested commit other than current HEAD", async () => {
 const f = await fixture();
 await code(stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId, commitDigest: f.ancestor }), "identity_mismatch");
});
test("supports full SHA-256 Git object IDs", async () => {
 const f = await fixture("sha256");
 const staged = await stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId });
 expect(staged.manifest.commitDigest).toHaveLength(64);
 const restored = await restoreSource({ bundlePath: staged.bundlePath, manifest: staged.manifest, jobsRoot: f.jobsRoot, jobId });
 expect(await git(restored.checkoutPath, "rev-parse", "HEAD")).toBe(staged.manifest.commitDigest);
});
test("rejects shallow sources", async () => {
 const f = await fixture(), shallow = join(f.root, "shallow");
 await git(f.root, "clone", "--depth=1", `file://${f.repo}`, shallow);
 await code(stageSource({ worktree: shallow, stagingRoot: f.stagingRoot, jobId }), "unsupported_source");
});
test("local core.worktree configuration cannot hide a dirty requested worktree", async () => {
 const f = await fixture(), alternate = join(f.root, "alternate");
 await mkdir(alternate); await writeFile(join(alternate, "hello.txt"), "unpushed\n");
 await git(f.repo, "config", "core.worktree", alternate);
 await writeFile(join(f.repo, "hello.txt"), "hidden dirty content\n");
 await code(stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId }), "dirty_source");
});
test("ignores inherited Git repository/config injection", async () => {
 const f = await fixture(), other = await fixture();
 await writeFile(join(other.repo, "hello.txt"), "different repository identity\n");
 await git(other.repo, "commit", "-am", "distinct injection target");
 const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
 const previous = keys.map(k => process.env[k]);
 const restoreEnv = () => keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; });
 try {
  process.env.GIT_DIR = join(other.repo, ".git"); process.env.GIT_WORK_TREE = other.repo;
  process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "core.bare"; process.env.GIT_CONFIG_VALUE_0 = "true";
  const staged = await stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId });
  const restored = await restoreSource({ bundlePath: staged.bundlePath, manifest: staged.manifest, jobsRoot: f.jobsRoot, jobId });
  // Our test helper still inherits injected Git vars, so restore them first.
  restoreEnv();
  expect(await git(restored.checkoutPath, "rev-parse", "HEAD")).toBe(await git(f.repo, "rev-parse", "HEAD"));
  expect(await git(restored.checkoutPath, "rev-parse", "HEAD")).not.toBe(await git(other.repo, "rev-parse", "HEAD"));
 } finally { restoreEnv(); }
});
test("disables a configured source fsmonitor hook that would otherwise execute", async () => {
 const f = await fixture(), hook = join(f.root, "fsmonitor"), marker = join(f.root, "hook-ran");
 await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nprintf 'token\\0'\n`);
 await chmod(hook, 0o700); await git(f.repo, "config", "core.fsmonitor", hook);
 await git(f.repo, "status", "--porcelain");
 expect((await stat(marker)).isFile()).toBe(true); // prove the hook is executable.
 await rm(marker);
 const staged = await stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId });
 await restoreSource({ bundlePath: staged.bundlePath, manifest: staged.manifest, jobsRoot: f.jobsRoot, jobId });
 expect(await stat(marker).then(() => true, () => false)).toBe(false);
});
test("restores exact bytes from bundles spanning multiple copy chunks", async () => {
 const f = await fixture(), bytes = randomBytes(256 * 1024);
 await writeFile(join(f.repo, "large.bin"), bytes);
 await git(f.repo, "add", "."); await git(f.repo, "commit", "-m", "large blob");
 const staged = await stageSource({ worktree: f.repo, stagingRoot: f.stagingRoot, jobId });
 expect((await stat(staged.bundlePath)).size).toBeGreaterThan(64 * 1024);
 const restored = await restoreSource({ bundlePath: staged.bundlePath, manifest: staged.manifest, jobsRoot: f.jobsRoot, jobId });
 expect(await readFile(join(restored.checkoutPath, "large.bin"))).toEqual(bytes);
});
