import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCmd } from "../src/exec.ts";
import { executeRemoteTest } from "../src/remote-test/executor.ts";
import { stageSource } from "../src/remote-test/source.ts";

// Explicit operator opt-in; never contacts/provisions a host or pulls an image.
const image = process.env.RANGER_EXECUTOR_INTEGRATION_IMAGE;
test.skipIf(!image)("disposable rootless container enforces policy, reports test outcomes, and tears down", async () => {
 if (!image || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("A preprovisioned image at its manifest digest is required");
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-container-fixture-")));
 const jobsRoot = join(root, "jobs"), repo = join(root, "repo"), stagingRoot = join(root, "staging");
 try {
  for (const path of [jobsRoot, repo, stagingRoot]) await mkdir(path);
  const git = async (args: string[]) => { const r = await runCmd("git", args, { cwd: repo }); if (r.code) throw new Error("Fixture Git failed"); };
  await git(["init", "--template="]); await writeFile(join(repo, "bun.lock"), "fixture\n"); await git(["add", "."]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
  const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
  for (const code of [0, 7]) {
   const jobId = randomUUID(); const source = await stageSource({ worktree: repo, stagingRoot, jobId });
   const profile = { version: 1 as const, profileId: "integration-v1", profileDigest: sha(`fixture-${code}`), lockDigest: sha("fixture\n"), imageDigest: image.split("@")[1]!, platform: "linux-arm64" as const, commands: [["bun", "-e", `process.exit(${code})`]] as [string, ...string[]][] };
   const job = { ...source.manifest, jobId, correlationId: jobId, repositoryId: "github:github.com/the-metafactory/ranger", profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest, imageDigest: profile.imageDigest, platform: profile.platform, deadline: Date.now() + 60_000, generation: 1 };
   const receipt = await executeRemoteTest({ job, bundlePath: source.bundlePath, config: { executorId: "integration-fixture", jobsRoot, profiles: [{ profile, lockFile: "bun.lock", imageReference: image }] } });
   expect(receipt.status).toBe(code ? "test_failed" : "passed"); expect(receipt.exitCode).toBe(code); expect(await readdir(jobsRoot)).toEqual([]);
  }
 } finally {
  // A retained lane means cleanup failed: keep private evidence for inspection.
  if (!(await readdir(jobsRoot)).includes(".executor-lane")) await rm(root, { recursive: true, force: true });
 }
}, 120_000);
