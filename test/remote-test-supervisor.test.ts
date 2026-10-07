import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { assertTestEvidence, createSshTestBackend, runTestBackend, localTestBackend, type TestRequest } from "../src/remote-test/supervisor-backend.ts";
import type { SshRunner } from "../src/remote-test/ssh-client.ts";
import { ConfigError, loadConfig } from "../src/config.ts";

const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
const digest = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const id = "6c7e8091-1234-4234-8234-123456789abc";
const profile = { version: 1, profileId: "unit-v1", profileDigest: digest("profile"), lockDigest: digest("lock"), imageDigest: digest("image"), platform: "linux-arm64", commands: [["bun", "test"]] };
async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-supervisor-"))); roots.push(root);
 const worktree = join(root, "repo"), stateRoot = join(root, "state"), configFile = join(root, "ssh.json");
 await mkdir(worktree); await mkdir(stateRoot, { mode: 0o700 });
 const git = async (args: string[]) => {
  const r = await runCmd("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: worktree, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
  if (r.code) throw Error(r.stderr); return r.stdout.trim();
 };
 await git(["init", "-q"]); await writeFile(join(worktree, "bun.lock"), "lock"); await git(["add", "."]); await git(["commit", "-qm", "fixture"]);
 await writeFile(configFile, JSON.stringify({ target: "fixture-alias", remoteCli: "/reviewed/ranger", remoteConfig: "/private/executor.json", executorId: "fixture", profiles: [profile] }), { mode: 0o600 });
 const request: TestRequest = { worktree, head: await git(["rev-parse", "HEAD"]), repositoryId: "github:github.com/acme/widgets", generation: 1, correlationId: id };
 return { root, worktree, stateRoot, configFile, git, request, selection: { kind: "ssh" as const, configFile, stateRoot, profileId: "unit-v1", lockFile: "bun.lock", deadlineSeconds: 600 } };
}
function runner(change: (receipt: any) => any = r => r, during?: () => Promise<void>) {
 const operations: string[] = [];
 const run: SshRunner = async invocation => {
  const chunks: Buffer[] = []; for await (const b of invocation.input) chunks.push(Buffer.from(b));
  const data = Buffer.concat(chunks), header = JSON.parse(data.subarray(0, data.indexOf(10)).toString());
  operations.push(header.operation); await during?.();
  const receipt = change({ version: 1, identity: header.job, executorId: "fixture", status: "passed", completedAt: Date.now(), exitCode: 0 });
  return { code: 0, stdout: JSON.stringify({ version: 2, receipt }) };
 };
 return { operations, run };
}
const noLocal = async () => { throw Error("must not run local"); };
test("local backend delegates exactly once with its original result", async () => {
 const f = await fixture(); let calls = 0; const result = { code: 0, stdout: "local output", stderr: "" };
 expect(await runTestBackend(localTestBackend, f.request, async () => { calls++; return result; })).toEqual({ result }); expect(calls).toBe(1);
});
test("SSH tests exact unpushed HEAD and profile; resume only retrieves saved exact job", async () => {
 const f = await fixture(), ssh = runner(), backend = createSshTestBackend(f.selection, { runner: ssh.run });
 const first = await runTestBackend(backend, f.request, noLocal);
 expect(first.result.code).toBe(0); expect(first.evidence?.receipt.identity.commitDigest).toBe(f.request.head);
 expect(first.evidence?.receipt.identity.lockDigest).toBe(profile.lockDigest);
 expect(JSON.parse(await readFile(first.evidence!.path, "utf8"))).toEqual(first.evidence!.receipt);
 const second = await runTestBackend(backend, f.request, noLocal);
 expect(second.result.code).toBe(0); expect(ssh.operations).toEqual(["submit", "status"]);
});
test("dirty source, changed HEAD and lock mismatch refuse before any SSH", async () => {
 for (const kind of ["dirty", "head", "lock"] as const) {
  const f = await fixture(), ssh = runner();
  if (kind === "dirty") await writeFile(join(f.worktree, "untracked"), "x");
  else if (kind === "head") { await writeFile(join(f.worktree, "new"), "x"); await f.git(["add", "."]); await f.git(["commit", "-qm", "new"]); }
  else { await writeFile(join(f.worktree, "bun.lock"), "other"); await f.git(["add", "."]); await f.git(["commit", "-qm", "lock"]); f.request.head = await f.git(["rev-parse", "HEAD"]); }
  expect((await runTestBackend(createSshTestBackend(f.selection, { runner: ssh.run }), f.request, noLocal)).result.code).not.toBe(0);
  expect(ssh.operations).toEqual([]);
 }
});
test("mismatched stale wrong-producer and failed receipts never satisfy supervisor tests", async () => {
 const changes = [
  (r: any) => ({ ...r, identity: { ...r.identity, generation: 2 } }),
  (r: any) => ({ ...r, completedAt: Date.now() - 86_400_001 }),
  (r: any) => ({ ...r, executorId: "wrong" }),
  (r: any) => ({ ...r, status: "test_failed", exitCode: 1 }),
 ];
 for (const change of changes) {
  const f = await fixture(), ssh = runner(change);
  const result = await runTestBackend(createSshTestBackend(f.selection, { runner: ssh.run }), f.request, noLocal);
  expect(result.result.code).not.toBe(0); expect(ssh.operations).toEqual(["submit"]);
  if (result.evidence) expect(result.evidence.receipt.status).toBe("test_failed");
 }
});
test("unsupported platform and unapproved profiles fail before SSH", async () => {
 for (const kind of ["platform", "profile"] as const) {
  const f = await fixture(), ssh = runner();
  if (kind === "platform") {
   const config = JSON.parse(await readFile(f.configFile, "utf8")); config.profiles[0].platform = "darwin-arm64";
   await writeFile(f.configFile, JSON.stringify(config));
  } else f.selection.profileId = "unapproved";
  expect((await runTestBackend(createSshTestBackend(f.selection, { runner: ssh.run }), f.request, noLocal)).result.code).not.toBe(0);
  expect(ssh.operations).toEqual([]);
 }
});
test("revoked and busy peer replies refuse success without local fallback", async () => {
 for (const state of ["revoked", "busy"] as const) {
  const f = await fixture();
  const ssh: SshRunner = async invocation => {
   const chunks: Buffer[] = []; for await (const b of invocation.input) chunks.push(Buffer.from(b));
   const header = JSON.parse(Buffer.concat(chunks).toString().split("\n")[0]!);
   const receipt = { version: 1, identity: header.job, executorId: "fixture", status: "passed", completedAt: Date.now(), exitCode: 0 };
   return { code: 0, stdout: JSON.stringify({ version: 2, state, receipt: state === "revoked" ? receipt : null }) };
  };
  const r = await runTestBackend(createSshTestBackend(f.selection, { runner: ssh }), f.request, noLocal);
  expect(r.result.code).not.toBe(0); expect(r.evidence).toBeUndefined();
 }
});
test("persisted receipt tampering and expiry refuse the pre-push validation", async () => {
 const f = await fixture(), ssh = runner(), r = await runTestBackend(createSshTestBackend(f.selection, { runner: ssh.run }), f.request, noLocal);
 expect(r.result.code).toBe(0);
 await expect(assertTestEvidence({ ...r.evidence!, validUntil: Date.now() - 1 }, f.request)).rejects.toThrow();
 await writeFile(r.evidence!.path, JSON.stringify({ ...r.evidence!.receipt, status: "test_failed", exitCode: 1 }));
 await expect(assertTestEvidence(r.evidence!, f.request)).rejects.toThrow();
});
test("per-map backend schema keeps local default and rejects incomplete unsafe or unknown selectors", async () => {
 const f = await fixture(), path = join(f.root, "ranger.yaml");
 const config = (selection?: unknown) => JSON.stringify({ version: 1, maps: [{ repo: "acme/widgets", root: 1, ...(selection ? { testBackend: selection } : {}) }] });
 await writeFile(path, config()); expect(loadConfig(path).config.maps[0]!.testBackend).toBeUndefined();
 await writeFile(path, config(f.selection)); expect(loadConfig(path).config.maps[0]!.testBackend).toEqual(f.selection);
 for (const selection of [{ kind: "ssh" }, { ...f.selection, lockFile: "../bun.lock" }, { ...f.selection, configFile: "relative" }, { ...f.selection, kind: "local" }, { ...f.selection, platform: "darwin-arm64" }]) {
  await writeFile(path, config(selection)); expect(() => loadConfig(path)).toThrow(ConfigError);
 }
});
test("post-test source mutation refuses even a passed remote receipt", async () => {
 const f = await fixture(), ssh = runner(r => r, async () => { await writeFile(join(f.worktree, "untracked"), "x"); });
 expect((await runTestBackend(createSshTestBackend(f.selection, { runner: ssh.run }), f.request, noLocal)).result.code).not.toBe(0);
});
test("interrupted transport is not resubmitted on resume and never falls back locally", async () => {
 const f = await fixture(); let calls = 0; const operations: string[] = [];
 const ssh: SshRunner = async invocation => { const chunks: Buffer[] = []; for await (const b of invocation.input) chunks.push(Buffer.from(b)); operations.push(JSON.parse(Buffer.concat(chunks).toString().split("\n")[0]!).operation); calls++; return { code: 255, stdout: "credential secret" }; };
 const backend = createSshTestBackend(f.selection, { runner: ssh });
 for (let i = 0; i < 2; i++) { const r = await runTestBackend(backend, f.request, noLocal); expect(r.result.code).not.toBe(0); expect(r.result.stderr).not.toContain("secret"); }
 expect(calls).toBe(2); expect(operations).toEqual(["submit", "status"]);
});
