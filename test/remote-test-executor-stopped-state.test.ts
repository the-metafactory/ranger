import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { executeRemoteTest, type ExecutorLauncher } from "../src/remote-test/executor.ts";
import { createReviewedProfile, MYELIN_REPOSITORY } from "../src/remote-test/profiles.ts";
import { stageSource } from "../src/remote-test/source.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const testId = "a".repeat(64), sidecarId = "b".repeat(64);

async function execute(state: { Status?: string; ExitCode: number; OOMKilled?: boolean }, options: {
 timeout?: boolean;
 attachCode?: number;
 terminalCode?: number;
 sidecar?: "stopped" | "oom" | "metrics";
} = {}) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-stopped-state-"))); roots.push(root);
 const repo = join(root, "repo"), stagingRoot = join(root, "staging"), jobsRoot = join(root, "jobs");
 for (const directory of [repo, stagingRoot, jobsRoot]) await mkdir(directory);
 const git = async (args: string[]) => {
  const result = await runCmd("git", args, { cwd: repo });
  if (result.code !== 0) throw Error(result.stderr);
 };
 await git(["init", "--template="]);
 await writeFile(join(repo, "bun.lock"), "reviewed-lock\n");
 await writeFile(join(repo, "package.json"), JSON.stringify({ name: "@the-metafactory/myelin", scripts: { test: "bun test", typecheck: "bunx tsc --noEmit", lint: "eslint ." } }));
 await git(["add", "."]);
 await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
 const jobId = randomUUID(), source = await stageSource({ worktree: repo, stagingRoot, jobId });
 const profile = createReviewedProfile({ profileId: "myelin-v1", lockDigest: digest("reviewed-lock\n"), imageDigest: digest("runtime"), reviewed: {
  recipe: "myelin-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["unit", "integration", "typecheck", "lint"],
  sidecars: [{ kind: "nats", imageReference: `localhost/nats@${digest("nats")}` }],
 } });
 let now = Date.now(), attached = false, sidecarChecks = 0, metricsReads = 0;
 const job = { ...source.manifest, jobId, correlationId: jobId, repositoryId: MYELIN_REPOSITORY,
  profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest,
  imageDigest: profile.imageDigest, platform: profile.platform, deadline: now + 60_000, generation: 1 };
 const launcher: ExecutorLauncher = async argv => {
  const command = argv[1], target = argv.at(-1);
  if (command === "info") return { code: 0, stdout: JSON.stringify({ host: { os: "linux", arch: "arm64", cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"], security: { rootless: true } } }) };
  if (command === "image") return { code: 0, stdout: JSON.stringify([{ Digest: target!.split("@")[1], Os: "linux", Architecture: "arm64" }]) };
  if (command === "create") return { code: 0, stdout: argv.includes("--entrypoint=/bin/sh") ? sidecarId : testId };
  if (command === "start" && argv.includes("--attach")) {
   attached = true;
   const exitCode = options.terminalCode ?? 0;
   return { code: options.attachCode ?? exitCode, stdout: options.timeout ? "" : JSON.stringify({ status: exitCode === 0 ? "passed" : "test_failed", exitCode,
    coverage: { requiredSkippedTests: 0 }, resources: { state: "observed", cpuTimeMicros: 123, peakMemoryBytes: 456 } }) };
  }
  if (command === "inspect" && target === testId) {
   if (attached && options.timeout) now += 10_000;
   return { code: 0, stdout: JSON.stringify([{ Mounts: [{ Type: "bind", Source: join(jobsRoot, jobId, "checkout"), Destination: "/work" }], State: attached ? state : { Status: "created" } }]) };
  }
  if (command === "inspect" && target === sidecarId) {
   if (attached) sidecarChecks++;
   return { code: 0, stdout: JSON.stringify([{ Mounts: [{ Type: "tmpfs", Destination: "/data" }], State: {
    Status: attached && options.sidecar === "stopped" ? "stopped" : "running", OOMKilled: attached && options.sidecar === "oom",
   } }]) };
  }
  if (command === "exec") { metricsReads++; return { code: 0, stdout: options.sidecar === "metrics" ? "invalid" : "usage_usec 10\nranger_peak 512\noom_kill 0\n" }; }
  if (command === "start" || command === "rm") return { code: 0, stdout: "" };
  throw Error(`Unexpected fixture command: ${command}`);
 };
 const receipt = await executeRemoteTest({ job, bundlePath: source.bundlePath, config: { executorId: "fixture", jobsRoot,
  profiles: [{ profile, lockFile: "bun.lock", imageReference: `localhost/runtime@${profile.imageDigest}` }] } },
 { launcher, uid: 1000, gid: 1000, now: () => now, timeoutMs: 10_000 });
 return { receipt, sidecarChecks, metricsReads };
}

for (const Status of ["exited", "stopped"]) {
 test(`${Status} preserves reviewed passed receipt and sidecar checks`, async () => {
  const { receipt, sidecarChecks, metricsReads } = await execute({ Status, ExitCode: 0, OOMKilled: false });
  expect(receipt.status).toBe("passed");
  expect(receipt.exitCode).toBe(0);
  expect(receipt.coverage).toEqual({ requiredSkippedTests: 0 });
  expect(receipt.evidence!.resources).toEqual({ state: "observed", cpuTimeMicros: 133, peakMemoryBytes: 968 });
  expect(sidecarChecks).toBe(1); expect(metricsReads).toBe(1);
 });
 test(`${Status} with empty output and exit 137 at runtime deadline is timed_out`, async () => {
  expect((await execute({ Status, ExitCode: 137 }, { timeout: true, attachCode: 137 })).receipt.status).toBe("timed_out");
 });
 for (const [ExitCode, terminalCode, attachCode] of [[7, 0, 0], [0, 0, 7], [7, 7, 0]]) {
  test(`${Status} rejects exit disagreement inspect=${ExitCode} terminal=${terminalCode} attach=${attachCode}`, async () => {
   expect((await execute({ Status, ExitCode }, { terminalCode, attachCode })).receipt.status).toBe("infra_failed");
  });
 }
}

for (const Status of ["running", "paused", "created", "configured", "stopping", "removing", undefined]) {
 for (const timeout of [false, true]) test(`${Status ?? "missing status"} fails closed with ${timeout ? "deadline exit 137" : "passed output"}`, async () => {
  expect((await execute({ Status, ExitCode: timeout ? 137 : 0 }, { timeout, attachCode: timeout ? 137 : 0 })).receipt.status).toBe("infra_failed");
 });
}

for (const sidecar of ["stopped", "oom", "metrics"] as const) test(`stopped test container still rejects sidecar ${sidecar}`, async () => {
 expect((await execute({ Status: "stopped", ExitCode: 0, OOMKilled: false }, { sidecar })).receipt.status).toBe("infra_failed");
});

test("stopped OOM remains infra_failed", async () => {
 expect((await execute({ Status: "stopped", ExitCode: 137, OOMKilled: true }, { terminalCode: 137, attachCode: 137 })).receipt.status).toBe("infra_failed");
});
