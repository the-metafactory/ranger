import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitSshRemoteTest, statusSshRemoteTest, validateSshConfig, type SshRunner } from "../src/remote-test/ssh-client.ts";
import { sshOutcomeMessage, sshOutcomeExitCode } from "../src/remote-test/ssh-cli.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const id = "6c7e8091-1234-4234-8234-123456789abc";
const now = 1_800_000_000_000;
const profile = { version: 1, profileId: "unit-v1", profileDigest: sha("profile"), lockDigest: sha("lock"), imageDigest: sha("image"), platform: "linux-arm64", commands: [["bun", "test"]] };
const config = { target: "disposable-alias", remoteCli: "/reviewed/ranger", remoteConfig: "/private/executor.json", executorId: "fixture", profiles: [profile] };
const job = { version: 1 as const, jobId: id, correlationId: id, repositoryId: "github:github.com/the-metafactory/ranger", commitDigest: "a".repeat(40), treeDigest: "b".repeat(40), bundleDigest: sha("bundle"), profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest, imageDigest: profile.imageDigest, platform: "linux-arm64" as const, deadline: now + 60_000, generation: 1 };
const receipt = { version: 1 as const, identity: job, executorId: "fixture", status: "passed" as const, completedAt: now - 1000, exitCode: 0 };
async function bundle() { const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-ssh-"))); roots.push(root); const path = join(root, "source.bundle"); await writeFile(path, "bundle"); return path; }
function fake(stdout = JSON.stringify({ version: 1, receipt }), code = 0) {
 const calls: { args: string[]; bytes: Buffer }[] = [];
 const runner: SshRunner = async invocation => { const chunks: Buffer[] = []; for await (const b of invocation.input) chunks.push(Buffer.from(b)); calls.push({ args: invocation.args, bytes: Buffer.concat(chunks) }); return { code, stdout }; };
 return { calls, runner };
}
test("uploads bound bytes over stdin and invokes only reviewed fixed argv with strict host verification", async () => {
 const f = fake(), saved: unknown[] = [];
 const result = await submitSshRemoteTest({ config, job, bundlePath: await bundle() }, { runner: f.runner, now: () => now, receiptStore: async r => { saved.push(r); } });
 expect(result.status).toBe("terminal"); expect(saved).toEqual([receipt]);
 expect(f.calls).toHaveLength(1); const call = f.calls[0]!;
 expect(call.args).toContain("StrictHostKeyChecking=yes"); expect(call.args).toContain("BatchMode=yes"); expect(call.args).toContain("ForwardAgent=no"); expect(call.args).toContain("-T");
 expect(call.args.at(-1)).toBe("'/reviewed/ranger' 'remote-test' 'serve-stdio' '--config' '/private/executor.json'");
 const newline = call.bytes.indexOf(10), request = JSON.parse(call.bytes.subarray(0, newline).toString());
 expect(request).toEqual({ version: 2, operation: "submit", job, bundleBytes: 6 }); expect(call.bytes.subarray(newline + 1).toString()).toBe("bundle");
 expect(call.bytes.toString()).not.toMatch(/remoteConfig|target|SSH_AUTH_SOCK|GH_TOKEN/);
});
test("status never uploads source or submits again, and handles absent and expired receipts truthfully", async () => {
 const f = fake(JSON.stringify({ version: 1, receipt: null }));
 expect((await statusSshRemoteTest({ config, job }, { runner: f.runner, now: () => now })).status).toBe("pending");
 expect(JSON.parse(f.calls[0]!.bytes.toString())).toEqual({ version: 2, operation: "status", job });
 expect((await statusSshRemoteTest({ config, job }, { runner: f.runner, now: () => job.deadline + 1 })).status).toBe("infra_failed");
});
test("SSH consumers distinguish active ownership from interrupted work without retrying", async () => {
 for (const state of ["active", "interrupted"] as const) {
  const f = fake(JSON.stringify({ version: 2, receipt: null, state }));
  const result = await statusSshRemoteTest({ config, job }, { runner: f.runner, now: () => now });
  expect(result).toEqual({ status: "pending", reason: state === "active" ? "active_job" : "interrupted_job" });
  expect(sshOutcomeMessage(result)).toContain(state); expect(f.calls).toHaveLength(1);
 }
});
test("a revoked historical passed receipt is retained as observed evidence but cannot succeed or be exported", async () => {
 const f = fake(JSON.stringify({ version: 2, receipt, state: "revoked" })); let stored = false;
 const result = await statusSshRemoteTest({ config, job }, { runner: f.runner, now: () => now, receiptStore: async () => { stored = true; } });
 expect(result).toEqual({ status: "revoked", receipt }); expect(sshOutcomeExitCode(result)).toBe(1); expect(stored).toBe(false);
 expect(sshOutcomeMessage(result)).toContain("revoked");
});
test("transport failure never trusts partial stdout or locally reruns tests", async () => {
 const f = fake(undefined, 255);
 expect((await submitSshRemoteTest({ config, job, bundlePath: await bundle() }, { runner: f.runner, now: () => now })).status).toBe("pending"); expect(f.calls).toHaveLength(1);
 const runner: SshRunner = async () => { throw Error("connection secret"); };
 expect(await statusSshRemoteTest({ config, job }, { runner, now: () => job.deadline + 1 })).toEqual({ status: "infra_failed", reason: "no_terminal_receipt" });
});
test("malformed, mismatched, stale, wrong-producer and future receipts refuse success and storage", async () => {
 const responses: unknown[] = ["partial JSON", { version: 1, receipt, extra: true }, { version: 1, receipt: { ...receipt, identity: { ...job, generation: 2 } } }, { version: 1, receipt: { ...receipt, executorId: "other" } }, { version: 1, receipt: { ...receipt, completedAt: now - 86_400_001 } }, { version: 1, receipt: { ...receipt, completedAt: now + 1 } }];
 for (const response of responses) { const f = fake(typeof response === "string" ? response : JSON.stringify(response)); let saved = false;
  expect((await statusSshRemoteTest({ config, job }, { runner: f.runner, now: () => now, receiptStore: async () => { saved = true; } })).status).toBe("infra_failed"); expect(saved).toBe(false);
 }
});
test("nonpassed terminal statuses retain their outcome; local receipt storage failure cannot expose success", async () => {
 const failed = { ...receipt, status: "test_failed" as const, exitCode: 1 }, f = fake(JSON.stringify({ version: 1, receipt: failed }));
 expect(await statusSshRemoteTest({ config, job }, { runner: f.runner, now: () => now })).toEqual({ status: "terminal", receipt: failed });
 const g = fake(); expect(await statusSshRemoteTest({ config, job }, { runner: g.runner, now: () => now, receiptStore: async () => { throw Error("full store"); } })).toEqual({ status: "infra_failed", reason: "receipt_store_failed" });
});
test("refuses option injection, unknown profile fields, expired submission and wrong bundle before SSH", async () => {
 for (const target of ["-oProxyCommand=sh", "host;touch /tmp/escape", "user@host\n-oX", "host$(id)"]) expect(() => validateSshConfig({ ...config, target })).toThrow();
 expect(() => validateSshConfig({ ...config, sshOptions: ["-oStrictHostKeyChecking=no"] })).toThrow();
 const f = fake(), path = await bundle();
 await expect(submitSshRemoteTest({ config, job: { ...job, commands: [["sh", "-c", "injected"]] }, bundlePath: path }, { runner: f.runner, now: () => now })).rejects.toThrow();
 await expect(submitSshRemoteTest({ config, job: { ...job, bundleDigest: sha("wrong") }, bundlePath: path }, { runner: f.runner, now: () => now })).rejects.toThrow();
 expect(await submitSshRemoteTest({ config, job, bundlePath: path }, { runner: f.runner, now: () => job.deadline })).toEqual({ status: "infra_failed", reason: "expired_job" });
 expect(f.calls).toHaveLength(0);
});
