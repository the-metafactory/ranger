import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../../src/exec.ts";
import type { RemoteTestJob, RemoteTestReceipt } from "../../src/remote-test/contract.ts";
import type { TestRequest, TestResult } from "../../src/remote-test/supervisor-backend.ts";

const d = `sha256:${"a".repeat(64)}`;
export async function createShadowFixture(cleanup: (root: string) => void) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-shadow-"))); cleanup(root); await chmod(root, 0o700);
 const repo = join(root, "repo"); await mkdir(repo);
 const git = async (...args: string[]) => {
  const r = await runCmd("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
  if (r.code) throw Error(r.stderr); return r.stdout.trim();
 };
 await git("init", "-q"); await writeFile(join(repo, "test.txt"), "fixture"); await git("add", "."); await git("commit", "-qm", "fixture");
 const request: TestRequest = { head: await git("rev-parse", "HEAD"), worktree: repo, repositoryId: "github:github.com/acme/widgets", generation: 1, correlationId: randomUUID() };
 const job: RemoteTestJob = { version: 1, jobId: randomUUID(), correlationId: request.correlationId, repositoryId: request.repositoryId, commitDigest: request.head, treeDigest: await git("rev-parse", "HEAD^{tree}"), bundleDigest: d, profileId: "unit-v1", profileDigest: d, lockDigest: d, imageDigest: d, platform: "linux-arm64", deadline: Date.now()+60_000, generation: 1 };
 const receipt: RemoteTestReceipt = { version: 1, identity: job, executorId: "fixture", status: "passed", exitCode: 0, completedAt: Date.now(), coverage: { requiredSkippedTests: 0 } };
 const path = join(root, "receipt.json"); await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
 const remote: TestResult = { result: { code: 0, stdout: "", stderr: "" }, evidence: { job, receipt, path, validUntil: Date.now()+60_000 } };
 const selection = { kind: "shadow" as const, reportRoot: root, stateRoot: root, configFile: path, profileId: "unit-v1", lockFile: "bun.lock", deadlineSeconds: 60 };
 return { root, repo, request, job, remote, selection, path };
}
