import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveSshRequest, serveSshResponse } from "../src/remote-test/ssh-server.ts";
import { runSshCommand, statusSshCommand, sshOutcomeExitCode, sshOutcomeMessage } from "../src/remote-test/ssh-cli.ts";
import { validateRemoteTestReceipt } from "../src/remote-test/contract.ts";
import { submitSshRemoteTest, statusSshRemoteTest, type SshRunner } from "../src/remote-test/ssh-client.ts";
import { executeRemoteTest, reconcileRemoteTests } from "../src/remote-test/executor.ts";
import { runCmd } from "../src/exec.ts";
import { openJobLedger } from "../src/remote-test/job-ledger.ts";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const id = "6c7e8091-1234-4234-8234-123456789abc";
async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-ssh-server-"))); roots.push(root);
 const jobsRoot = join(root, "jobs"); await mkdir(jobsRoot, { mode: 0o700 });
 const profile = { version: 1 as const, profileId: "unit-v1", profileDigest: sha("profile"), lockDigest: sha("lock"), imageDigest: sha("image"), platform: "linux-arm64" as const, commands: [["bun", "test"]] as [string, ...string[]][] };
 const job = { version: 1 as const, jobId: id, correlationId: id, repositoryId: "github:github.com/the-metafactory/ranger", commitDigest: "a".repeat(40), treeDigest: "b".repeat(40), bundleDigest: sha("bundle"), profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest, imageDigest: profile.imageDigest, platform: profile.platform, deadline: Date.now() + 60_000, generation: 1 };
 const config = { executorId: "fixture", jobsRoot, profiles: [{ profile, lockFile: "bun.lock", imageReference: `localhost/runtime@${profile.imageDigest}` }] };
 const receipt = validateRemoteTestReceipt({ version: 1, identity: job, executorId: "fixture", status: "passed", completedAt: Date.now(), exitCode: 0 }, job);
 const frame = (operation = "submit", body = "bundle", fields = {}) => (async function* () { yield Buffer.from(JSON.stringify({ version: 2, operation, job, ...(operation === "submit" ? { bundleBytes: 6 } : {}), ...fields }) + "\n" + body); })();
 let calls = 0;
 const execute = async (input: { job: unknown; bundlePath: string; config: unknown }) => { calls++; expect(await readFile(input.bundlePath, "utf8")).toBe("bundle"); expect(input.job).toEqual(job); return receipt; };
 return { root, jobsRoot, profile, job, config, receipt, frame, execute, calls: () => calls };
}
test("receiver accepts chunked framed input, validates exact bytes and removes only its inbox", async () => {
 const f = await fixture(), chunks: Buffer[] = [];
 for await (const chunk of f.frame()) for (const byte of chunk) chunks.push(Buffer.from([byte]));
 const stream = (async function* () { yield* chunks; })();
 expect(await serveSshRequest(stream, f.config, { execute: f.execute })).toEqual({ version: 2, receipt: f.receipt }); expect(f.calls()).toBe(1);
 expect(await stat(join(f.jobsRoot, ".ssh-incoming", id)).catch(() => null)).toBeNull();
});
test("truncated, oversized, mismatched and unexpected request fields never launch the executor", async () => {
 const f = await fixture();
 for (const frame of [f.frame("submit", "bundl"), f.frame("submit", "bundle!"), f.frame("submit", "Bundle"), f.frame("submit", "bundle", { target: "injected" }), f.frame("submit", "bundle", { bundleBytes: 67_108_865 }), f.frame("status", "bundle")]) await expect(serveSshRequest(frame, f.config, { execute: f.execute })).rejects.toThrow();
 await expect(serveSshRequest((async function* () { yield Buffer.alloc(65_537, 65); })(), f.config, { execute: f.execute })).rejects.toThrow("header");
 expect(f.calls()).toBe(0);
});
test("status returns only matching private durable evidence, never executes, and refuses symlinked stores", async () => {
 const f = await fixture(); expect(await serveSshRequest(f.frame("status", ""), f.config, { execute: f.execute })).toEqual({ version: 2, receipt: null });
 const store = join(f.jobsRoot, ".artifacts"), dir = join(store, id); await mkdir(store, { mode: 0o700 }); await mkdir(dir, { mode: 0o700 });
 const path = join(dir, "receipt.json"); await writeFile(path, JSON.stringify(f.receipt), { mode: 0o600 });
 expect(await serveSshRequest(f.frame("status", ""), f.config, { execute: f.execute })).toEqual({ version: 2, receipt: f.receipt });
 await writeFile(path, JSON.stringify({ ...f.receipt, identity: { ...f.job, generation: 2 } }));
 await expect(serveSshRequest(f.frame("status", ""), f.config, { execute: f.execute })).rejects.toThrow();
 await rm(store, { recursive: true }); await symlink(f.root, store);
 await expect(serveSshRequest(f.frame("status", ""), f.config, { execute: f.execute })).rejects.toThrow("private"); expect(f.calls()).toBe(0);
});
test("expired requests and occupied upload paths refuse execution; failed uploads clean their own paths", async () => {
 const f = await fixture(); f.job.deadline = Date.now() - 1;
 await expect(serveSshRequest(f.frame(), f.config, { execute: f.execute })).rejects.toThrow("expired"); expect(f.calls()).toBe(0);
 f.job.deadline = Date.now() + 60_000;
 await mkdir(join(f.jobsRoot, ".ssh-incoming"), { mode: 0o700 }); const occupied = join(f.jobsRoot, ".ssh-incoming", id); await mkdir(occupied, { mode: 0o700 });
 await writeFile(join(occupied, "keep"), "in flight");
 await expect(serveSshRequest(f.frame(), f.config, { execute: f.execute })).rejects.toThrow(); expect(await readFile(join(occupied, "keep"), "utf8")).toBe("in flight");
});
test("SSH duplicates report active and retrieval applies durable cancellation even to a passed artifact", async () => {
 const f = await fixture(), ledger = await openJobLedger(f.jobsRoot, f.config.executorId);
 try {
  const admitted = ledger.admit(f.job); if (admitted.kind !== "admitted") throw Error();
  expect(await serveSshResponse(f.frame("status", ""), f.config, { execute: f.execute })).toEqual({ version: 2, receipt: null, state: "active" });
  expect(await serveSshResponse(f.frame(), f.config, { execute: f.execute })).toEqual({ version: 2, receipt: null, state: "active" });
  ledger.launch(f.job, admitted.token); ledger.complete(f.job, admitted.token, f.receipt); ledger.cancel(f.job);
  const store = join(f.jobsRoot, ".artifacts"), dir = join(store, id); await mkdir(store, { mode: 0o700 }); await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, "receipt.json"), JSON.stringify(f.receipt), { mode: 0o600 });
  const response = await serveSshResponse(f.frame("status", ""), f.config, { execute: f.execute });
  if (!("receipt" in response)) throw Error(); expect(response).toEqual({ version: 2, state: "revoked", receipt: f.receipt }); expect(f.calls()).toBe(0);
 } finally { ledger.close(); }
});
test("V1 requests receive strict V1 responses, with no unnegotiated state fields", async () => {
 const f = await fixture(), ledger = await openJobLedger(f.jobsRoot, f.config.executorId);
 try {
  ledger.admit(f.job);
  expect(await serveSshResponse(f.frame("status", "", { version: 1 }), f.config)).toEqual({ version: 1, receipt: null });
  await ledger.reconcile({ list: async () => [], remove: async () => {}, cleanup: async () => {} });
  expect(await serveSshResponse(f.frame("status", "", { version: 1 }), f.config)).toEqual({ version: 1, receipt: null });
 } finally { ledger.close(); }
});
test("legacy passed artifacts cannot bypass a newer generation's durable fence", async () => {
 const f = await fixture(), ledger = await openJobLedger(f.jobsRoot, f.config.executorId);
 try {
  ledger.admit({ ...f.job, jobId: "7c7e8091-1234-4234-8234-123456789abc", generation: 2 });
  const store = join(f.jobsRoot, ".artifacts"), dir = join(store, id); await mkdir(store, { mode: 0o700 }); await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, "receipt.json"), JSON.stringify(f.receipt), { mode: 0o600 });
  const response = await serveSshResponse(f.frame("status", ""), f.config);
  expect(response).toEqual({ version: 2, state: "revoked", receipt: f.receipt });
  const failed = { ...f.receipt, status: "test_failed" as const, exitCode: 1 };
  await writeFile(join(dir, "receipt.json"), JSON.stringify(failed), { mode: 0o600 });
  expect(await serveSshResponse(f.frame("status", ""), f.config)).toEqual({ version: 2, receipt: failed });
 } finally { ledger.close(); }
});
test("restart recovery clears only known stale SSH uploads and lets an interrupted job retry through SSH", async () => {
 const f = await fixture(), ledger = await openJobLedger(f.jobsRoot, f.config.executorId);
 try {
  const admitted = ledger.admit(f.job); if (admitted.kind !== "admitted") throw Error();
  const inbox = join(f.jobsRoot, ".ssh-incoming"), stale = join(inbox, id), unknown = join(inbox, "unknown-upload");
  await mkdir(inbox, { mode: 0o700 }); await mkdir(stale, { mode: 0o700 }); await mkdir(unknown, { mode: 0o700 });
  await writeFile(join(stale, "source.bundle"), "partial", { mode: 0o600 });
  await reconcileRemoteTests(f.config, { launcher: async () => ({ code: 0, stdout: "" }) });
  expect(await stat(stale).catch(() => null)).toBeNull(); expect(await stat(unknown)).toBeDefined();
  expect(await serveSshResponse(f.frame("status", ""), f.config)).toEqual({ version: 2, receipt: null, state: "interrupted" });
  let calls = 0;
  const response = await serveSshResponse(f.frame(), f.config, { execute: async (input, options) => {
   calls++; return executeRemoteTest(input, { ...options, uid: 1000, gid: 1000, launcher: async () => ({ code: 0, stdout: JSON.stringify({ host: { os: "linux", arch: "unsupported" } }) }) });
  } });
  if (!("receipt" in response)) throw Error(); expect(response.receipt!.status).toBe("rejected"); expect(calls).toBe(1);
  expect(await serveSshResponse(f.frame(), f.config, { execute: f.execute })).toEqual(response); expect(f.calls()).toBe(0);
 } finally { ledger.close(); }
});
test("run command stages unpushed clean HEAD and saves private job before transport; status only retrieves", async () => {
 const f = await fixture(), repo = join(f.root, "repo"), staging = join(f.root, "staging");
 await mkdir(repo); await mkdir(staging, { mode: 0o700 });
 const git = async (args: string[]) => { const r = await runCmd("git", args, { cwd: repo }); if (r.code) throw Error(r.stderr); return r.stdout.trim(); };
 await git(["init", "--template="]); await writeFile(join(repo, "bun.lock"), "lock"); await git(["add", "."]); await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
 const configPath = join(f.root, "ssh.json"), requestPath = join(f.root, "request.json"), jobOutput = join(f.root, "job.json"), output = join(f.root, "receipt.json");
 const { commitDigest, treeDigest, bundleDigest, ...request } = f.job;
 await writeFile(configPath, JSON.stringify({ target: "fixture", remoteCli: "/reviewed/ranger", remoteConfig: "/private/config.json", executorId: "fixture", profiles: [f.profile] }), { mode: 0o600 });
 await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
 let calls = 0, stagedJob: unknown;
 const runner: SshRunner = async invocation => {
  calls++; const bytes: Buffer[] = []; for await (const c of invocation.input) bytes.push(Buffer.from(c)); const stream = Buffer.concat(bytes), newline = stream.indexOf(10), wire = JSON.parse(stream.subarray(0, newline).toString());
  stagedJob = JSON.parse(await readFile(jobOutput, "utf8")); expect(wire.job).toEqual(stagedJob); expect((await stat(jobOutput)).mode & 0o777).toBe(0o600);
  if (wire.operation === "submit") { expect(`sha256:${createHash("sha256").update(stream.subarray(newline + 1)).digest("hex")}`).toBe(wire.job.bundleDigest); }
  else expect(stream.length).toBe(newline + 1);
  return { code: 0, stdout: JSON.stringify({ version: 1, receipt: { ...f.receipt, identity: wire.job, completedAt: Date.now() } }) };
 };
 const options = { config: configPath, request: requestPath, worktree: repo, stagingRoot: staging, jobOutput, output };
 expect(sshOutcomeExitCode(await runSshCommand(options, { runner }))).toBe(0); expect(calls).toBe(1); expect((await stat(output)).mode & 0o777).toBe(0o600);
 expect((stagedJob as { commitDigest: string }).commitDigest).toBe(await git(["rev-parse", "HEAD"]));
 await expect(runSshCommand(options, { runner })).rejects.toThrow("exists"); expect(calls).toBe(1);
 expect(sshOutcomeExitCode(await statusSshCommand({ config: configPath, job: jobOutput, output: join(f.root, "retrieved.json") }, { runner }))).toBe(0); expect(calls).toBe(2);
 await writeFile(join(repo, "bun.lock"), "dirty"); await expect(runSshCommand({ ...options, output: join(f.root, "new-receipt"), jobOutput: join(f.root, "new-job") }, { runner })).rejects.toThrow("clean"); expect(calls).toBe(2);
});
test("CLI run and status expose truthful nonzero exit codes without leaking private input errors", async () => {
 for (const [command, extra] of [["status", ["--job", "/absent/private/job"]], ["run", ["--request", "/absent/private/request", "--worktree", "/absent/private/worktree", "--staging-root", "/absent/private/staging", "--job-output", "/absent/private/job"]]] as const) {
  const result = await runCmd("bun", ["src/cli.ts", "remote-test", command, "--config", "/absent/private/config", ...extra, "--output", "/absent/private/receipt"]);
  expect(result.code).toBe(1); expect(result.stderr).toContain("private input"); expect(result.stderr).not.toContain("/absent/private");
 }
 expect(sshOutcomeExitCode({ status: "pending", reason: "no_terminal_receipt" })).toBe(1);
 expect(sshOutcomeMessage({ status: "infra_failed", reason: "expired_job" })).toContain("no submission");
 expect(sshOutcomeMessage({ status: "infra_failed", reason: "invalid_receipt" })).toContain("Do not use the refused receipt");
 expect(sshOutcomeMessage({ status: "infra_failed", reason: "invalid_receipt" })).not.toContain("retrieve status");
});
test("client wire roundtrip through receiver and real durable executor storage is retrievable without reexecution", async () => {
 const f = await fixture(), bundlePath = join(f.root, "source.bundle"); await writeFile(bundlePath, "bundle");
 const clientConfig = { target: "fixture", remoteCli: "/reviewed/ranger", remoteConfig: "/private/config.json", executorId: "fixture", profiles: [f.profile] };
 let executions = 0;
 const runner: SshRunner = async invocation => {
  const response = await serveSshResponse(invocation.input, f.config, { execute: async (input, options) => {
   executions++;
   // A real executor operational refusal still persists a terminal receipt.
   // No container or host provisioning is needed to couple the storage seam.
   return executeRemoteTest(input, { ...options, uid: 1000, gid: 1000, launcher: async () => ({ code: 0, stdout: JSON.stringify({ host: { os: "linux", arch: "x86_64" } }) }) });
  } });
  return { code: 0, stdout: JSON.stringify(response) };
 };
 const submitted = await submitSshRemoteTest({ config: clientConfig, job: f.job, bundlePath }, { runner });
 expect(submitted.status).toBe("terminal"); expect(sshOutcomeExitCode(submitted)).toBe(1);
 const retrieved = await statusSshRemoteTest({ config: clientConfig, job: f.job }, { runner });
 expect(retrieved).toEqual(submitted); expect(executions).toBe(1);
 if (retrieved.status === "terminal") { expect(retrieved.receipt.status).toBe("rejected"); expect(retrieved.receipt.evidence).toBeDefined(); }
 // The fixed receiver reports permanently corrupt evidence, rather than
 // hiding it behind a nonzero SSH exit and a pending outcome.
 await writeFile(join(f.jobsRoot, ".artifacts", id, "receipt.json"), JSON.stringify({ ...f.receipt, identity: { ...f.job, generation: 2 } }));
 expect(await statusSshRemoteTest({ config: clientConfig, job: f.job }, { runner })).toEqual({ status: "infra_failed", reason: "invalid_receipt" });
 await writeFile(join(f.jobsRoot, ".artifacts", id, "receipt.json"), "partial JSON");
 expect(await statusSshRemoteTest({ config: clientConfig, job: f.job }, { runner })).toEqual({ status: "infra_failed", reason: "invalid_receipt" });
 await writeFile(join(f.jobsRoot, ".artifacts", id, "receipt.json"), JSON.stringify({ ...f.receipt, executorId: "other" }));
 expect(await statusSshRemoteTest({ config: clientConfig, job: f.job }, { runner })).toEqual({ status: "infra_failed", reason: "invalid_receipt" });
 expect(executions).toBe(1);
 const failedReceiver: SshRunner = async invocation => ({ code: 0, stdout: JSON.stringify(await serveSshResponse(invocation.input, { ...f.config, executorId: "invalid executor" })) });
 expect(await statusSshRemoteTest({ config: clientConfig, job: f.job }, { runner: failedReceiver })).toEqual({ status: "infra_failed", reason: "receiver_failed" });
 const configPath = join(f.root, "executor.json"); await writeFile(configPath, JSON.stringify(f.config), { mode: 0o600 });
 const cliReceiver: SshRunner = async invocation => {
  const child = Bun.spawn(["bun", "src/cli.ts", "remote-test", "serve-stdio", "--config", configPath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  for await (const bytes of invocation.input) child.stdin.write(bytes); child.stdin.end();
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout };
 };
 expect(await statusSshRemoteTest({ config: clientConfig, job: f.job }, { runner: cliReceiver })).toEqual({ status: "infra_failed", reason: "invalid_receipt" });
});
