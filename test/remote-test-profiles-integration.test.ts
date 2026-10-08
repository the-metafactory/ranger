import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createReviewedProfile, MYELIN_REPOSITORY } from "../src/remote-test/profiles.ts";
import { executeRemoteTest } from "../src/remote-test/executor.ts";
import { stageSource } from "../src/remote-test/source.ts";

// Operator-prepared Linux ARM64 only. Never provisions, pulls or contacts a bus.
const image = process.env.RANGER_MYELIN_INTEGRATION_IMAGE;
const nats = process.env.RANGER_NATS_INTEGRATION_IMAGE;
const worktree = process.env.RANGER_MYELIN_INTEGRATION_WORKTREE;
test.skipIf(!image || !nats || !worktree)("reviewed Myelin checks use a disposable private NATS and remove both containers", async () => {
 if (!image || !nats || !worktree || !isAbsolute(worktree)) throw Error("Operator images and absolute clean Myelin worktree required");
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-myelin-fixture-")));
 const jobsRoot = join(root, "jobs"), stagingRoot = join(root, "staging");
 await mkdir(jobsRoot); await mkdir(stagingRoot);
 try {
  const jobId = randomUUID(), source = await stageSource({ worktree, stagingRoot, jobId });
  const lockDigest = `sha256:${createHash("sha256").update(await readFile(join(worktree, "bun.lock"))).digest("hex")}`;
  const profile = createReviewedProfile({ profileId: "myelin-integration-v1", lockDigest, imageDigest: image.split("@")[1]!, reviewed: { recipe: "myelin-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["unit", "integration", "typecheck", "lint"], sidecars: [{ kind: "nats", imageReference: nats }] } });
  const job = { ...source.manifest, jobId, correlationId: jobId, repositoryId: MYELIN_REPOSITORY, profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest, imageDigest: profile.imageDigest, platform: profile.platform, deadline: Date.now() + 600_000, generation: 1 };
  const receipt = await executeRemoteTest({ job, bundlePath: source.bundlePath, config: { executorId: "myelin-fixture", jobsRoot, profiles: [{ profile, lockFile: "bun.lock", imageReference: image }] } });
  expect(receipt.status).toBe("passed"); expect(receipt.coverage?.requiredSkippedTests).toBe(0);
  expect(receipt.evidence!.resources.state).toBe("observed");
  expect(await readdir(jobsRoot)).toEqual([".artifacts"]);
 } finally {
  if (!(await readdir(jobsRoot)).includes(".executor-lane")) await rm(root, { recursive: true, force: true });
 }
}, 620_000);
