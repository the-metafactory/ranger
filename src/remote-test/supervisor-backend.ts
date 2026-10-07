import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunResult } from "../exec.ts";
import { safeGit } from "../git-ops.ts";
import type { RangerMapConfig } from "../config.ts";
import { privateOperatorPath } from "./baseline.ts";
import { validateRemoteTestReceipt, type RemoteTestJob, type RemoteTestReceipt } from "./contract.ts";
import { readPrivateJson, runSshCommand, statusSshCommand } from "./ssh-cli.ts";
import { selectSshJob, validateSshConfig, type SshOptions } from "./ssh-client.ts";

export interface TestRequest {
 worktree: string;
 head: string;
 repositoryId: string;
 generation: number;
 correlationId: string;
}
export interface TestResult {
 result: RunResult;
 /** Kept in memory for validation. The journal receives only path and status. */
 evidence?: { job: RemoteTestJob; receipt: RemoteTestReceipt; path: string; validUntil: number };
}
export interface TestBackend {
 kind: "local" | "ssh";
 run(request: TestRequest, local: () => Promise<RunResult>): Promise<TestResult>;
}
export const localTestBackend: TestBackend = {
 kind: "local",
 run: async (_request, local) => ({ result: await local() }),
};
const failed = (reason: string): TestResult => ({ result: { code: 1, stdout: "", stderr: `Remote supervisor tests refused (${reason}); no local fallback.` } });

/** HEAD, tree and index must still denote the committed source. Git's status
 * alone misses assume-unchanged / skip-worktree flags and replacement refs. */
export async function assertTestSource(request: TestRequest): Promise<void> {
 const git = async (args: string[]) => {
  const r = await safeGit(["--no-replace-objects", `--work-tree=${request.worktree}`, "-c", "core.fsmonitor=false", ...args], { cwd: request.worktree, timeoutMs: 30_000 });
  if (r.code !== 0) throw Error("Cannot validate supervisor source");
  return r.stdout;
 };
 if ((await git(["rev-parse", "HEAD"])).trim() !== request.head ||
     (await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])).trim() !== "" ||
     (await git(["ls-files", "-v", "-z"])).split("\0").some(entry => entry && !entry.startsWith("H "))) {
  throw Error("Supervisor source changed or is dirty");
 }
}

/** Revalidate the persisted pointer as well as the in-memory receipt. */
export async function assertTestEvidence(evidence: NonNullable<TestResult["evidence"]>, request: TestRequest): Promise<void> {
 const { job, receipt } = evidence;
 validateRemoteTestReceipt(receipt, job);
 const stored = validateRemoteTestReceipt(await readPrivateJson(evidence.path), job);
 if (stored.status !== receipt.status || stored.executorId !== receipt.executorId || stored.completedAt !== receipt.completedAt || stored.exitCode !== receipt.exitCode || stored.coverage?.requiredSkippedTests !== receipt.coverage?.requiredSkippedTests ||
     !Number.isSafeInteger(evidence.validUntil) || Date.now() > evidence.validUntil || receipt.completedAt > Date.now() ||
     job.commitDigest !== request.head || job.repositoryId !== request.repositoryId || job.generation !== request.generation || job.correlationId !== request.correlationId) throw Error("Wrong or stale test admission");
 const tree = await safeGit(["--no-replace-objects", "rev-parse", `${request.head}^{tree}`], { cwd: request.worktree, timeoutMs: 10_000 });
 if (tree.code !== 0 || tree.stdout.trim() !== job.treeDigest) throw Error("Wrong test tree");
}

/** Local execution retains its existing behavior. All remote backends, including
 * injected ones, must return attributable evidence and leave source intact. */
export async function runTestBackend(backend: TestBackend, request: TestRequest, local: () => Promise<RunResult>): Promise<TestResult> {
 if (backend.kind === "local") return backend.run(request, local);
 try {
  await assertTestSource(request);
  const outcome = await backend.run(request, local);
  await assertTestSource(request);
  if (outcome.evidence) {
   await assertTestEvidence(outcome.evidence, request);
   const { receipt } = outcome.evidence;
   if ((outcome.result.code === 0) !== (receipt.status === "passed")) throw Error("Inconsistent test status");
  } else if (outcome.result.code === 0) throw Error("Missing test receipt");
  return outcome;
 } catch { return failed("source_or_receipt_validation"); }
}

/** Stable scope across supervisor restarts, distinct for each map/node. */
export function testCorrelationId(repo: string, root: number, nodeId: string): string {
 const hex = createHash("sha256").update(JSON.stringify([repo, root, nodeId])).digest("hex");
 return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type SshSelection = NonNullable<RangerMapConfig["testBackend"]>;
async function privateDirectory(path: string): Promise<void> {
 const info = await lstat(path);
 if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error("Invalid private supervisor directory");
}

/** The existing fixed SSH API owns staging, authentication, receipt validation
 * and publication. An exact job survives interruption before returning to the
 * supervisor. An existing attempt is lookup-only, never a second submission. */
export function createSshTestBackend(selection: SshSelection, options: SshOptions = {}): TestBackend {
 return { kind: "ssh", async run(request) {
  try {
   const config = validateSshConfig(await readPrivateJson(selection.configFile));
   const profile = config.profiles.find(p => p.profileId === selection.profileId);
   if (!profile) return failed("unapproved_profile");
   const lock = await open(join(request.worktree, selection.lockFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
   let lockDigest: string;
   try {
    const info = await lock.stat();
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw Error("Invalid lock file");
    const bytes = await lock.readFile();
    const entry = await safeGit(["--no-replace-objects", "ls-tree", request.head, "--", selection.lockFile], { cwd: request.worktree, timeoutMs: 10_000 });
    const oid = createHash(request.head.length === 40 ? "sha1" : "sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (entry.code !== 0 || !entry.stdout.startsWith(`100644 blob ${oid}\t`) && !entry.stdout.startsWith(`100755 blob ${oid}\t`)) throw Error("Lock file is not the committed blob");
    lockDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
   }
   finally { await lock.close(); }
   if (lockDigest !== profile.lockDigest) return failed("lock_mismatch");
   const stateRoot = resolve(selection.stateRoot);
   await privateDirectory(stateRoot);
   await privateOperatorPath(join(stateRoot, "supervisor-check"));
   const key = createHash("sha256").update(JSON.stringify([request.repositoryId, request.correlationId, request.generation, request.head, profile, config.executorId])).digest("hex");
   const directory = join(stateRoot, key), jobPath = join(directory, "job.json");
   let fresh = false;
   try {
    await mkdir(directory, { mode: 0o700 }); fresh = true;
    // The attempt's name must survive before any SSH submission: a missing
    // directory after power loss must not authorize repeating uncertain work.
    const parent = await open(stateRoot, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
   }
   catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
   await privateDirectory(directory);
   const path = join(directory, `receipt-${randomUUID()}.json`);
   let outcome;
   if (fresh) {
    const stagingRoot = join(directory, "staging"); await mkdir(stagingRoot, { mode: 0o700 });
    const requestPath = join(directory, "request.json"), jobId = randomUUID();
    await writeFile(requestPath, JSON.stringify({ version: 1, jobId, correlationId: request.correlationId, repositoryId: request.repositoryId, generation: request.generation, deadline: (options.now ?? Date.now)() + selection.deadlineSeconds * 1000,
     profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest, imageDigest: profile.imageDigest, platform: profile.platform }), { flag: "wx", mode: 0o600 });
    outcome = await runSshCommand({ config: selection.configFile, request: requestPath, worktree: request.worktree, expectedCommit: request.head, stagingRoot, jobOutput: jobPath, output: path }, options);
   } else {
    outcome = await statusSshCommand({ config: selection.configFile, job: jobPath, output: path }, options);
   }
   if (outcome.status !== "terminal") return failed(outcome.status === "revoked" ? "revoked" : outcome.reason);
   const job = selectSshJob(config, await readPrivateJson(jobPath));
   const receipt = validateRemoteTestReceipt(outcome.receipt, job);
   if (profile.reviewed && receipt.status === "passed" && receipt.coverage?.requiredSkippedTests !== 0) return failed("incomplete_required_coverage");
   // The submission deadline bounds execution, not retrieval. The contract
   // already refuses a passed receipt completed after that deadline.
   return { result: { code: receipt.status === "passed" ? 0 : 1, stdout: `Remote supervisor tests: ${receipt.status}.`, stderr: receipt.status === "passed" ? "" : `Remote supervisor tests: ${receipt.status}; no local fallback.` }, evidence: { job, receipt, path, validUntil: receipt.completedAt + config.receiptMaxAgeMs } };
  } catch { return failed("private_state_or_submission"); }
 } };
}
