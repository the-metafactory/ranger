import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { privateOperatorPath } from "./baseline.ts";
import { publishReceiptFile } from "./artifacts.ts";
import { stageSource } from "./source.ts";
import { selectSshJob, submitSshRemoteTest, statusSshRemoteTest, validateSshConfig, type SshOptions, type SshOutcome } from "./ssh-client.ts";

async function readPrivateJson(path: string) {
 const file = await open(await privateOperatorPath(path, true), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const info = await file.stat(); if (!info.isFile() || info.size > 65_536) throw Error("Invalid private JSON input");
  return JSON.parse(await file.readFile("utf8"));
 } finally { await file.close(); }
}
async function reserve(path: string) {
 const destination = await privateOperatorPath(path), reservation = `${destination}.reservation`;
 await mkdir(reservation, { mode: 0o700 });
 try {
  try { await lstat(destination); throw Error("SSH output already exists"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
 } catch (e) { await rm(reservation, { recursive: true }); throw e; }
 return { destination, release: () => rm(reservation, { recursive: true }) };
}
async function saveJob(path: string, job: unknown) {
 const temporary = join(dirname(path), `.pending-job-${randomUUID()}`);
 let published = false;
 try {
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(job) + "\n"); await file.sync(); } finally { await file.close(); }
  await link(temporary, path); published = true;
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
 } catch (e) { if (published) await rm(path); throw e; }
 finally { await rm(temporary, { force: true }); }
}
export interface RunSshCommand { config: string; request: string; worktree: string; stagingRoot: string; jobOutput: string; output: string }

/** Partial V1 request contains every non-source identity field. Source bindings
 * are derived from one clean committed HEAD, not caller-claimed digests. Exact
 * job publication is synced before the first SSH invocation for later lookup. */
export async function runSshCommand(options: RunSshCommand, injected: SshOptions = {}): Promise<SshOutcome> {
 const config = validateSshConfig(await readPrivateJson(options.config));
 const request = await readPrivateJson(options.request);
 for (const field of ["commitDigest", "treeDigest", "bundleDigest"]) if (Object.hasOwn(request, field)) throw Error("Source bindings must be derived from staging");
 // Reject all other unknown fields and malformed identities before source work.
 selectSshJob(config, { ...request, commitDigest: "0".repeat(40), treeDigest: "0".repeat(40), bundleDigest: `sha256:${"0".repeat(64)}` });
 const stagingRoot = await privateOperatorPath(join(resolve(options.stagingRoot), "ssh-staging-check"));
 const stagingInfo = await lstat(dirname(stagingRoot));
 if (!stagingInfo.isDirectory() || stagingInfo.uid !== process.getuid?.() || (stagingInfo.mode & 0o077) !== 0) throw Error("SSH staging root must be private and operator-owned");
 const receiptOutput = await reserve(options.output);
 let jobOutput: Awaited<ReturnType<typeof reserve>> | undefined;
 let source: Awaited<ReturnType<typeof stageSource>> | undefined;
 try {
  jobOutput = await reserve(options.jobOutput);
  source = await stageSource({ worktree: resolve(options.worktree), stagingRoot: dirname(stagingRoot), jobId: request.jobId });
  const job = selectSshJob(config, { ...request, ...source.manifest });
  await saveJob(jobOutput.destination, job);
  return await submitSshRemoteTest({ config, job, bundlePath: source.bundlePath }, { ...injected, receiptStore: r => publishReceiptFile(receiptOutput.destination, r) });
 } finally {
  try { if (source) await rm(dirname(source.bundlePath), { recursive: true }); }
  finally { try { await jobOutput?.release(); } finally { await receiptOutput.release(); } }
 }
}
export async function statusSshCommand(options: { config: string; job: string; output: string }, injected: SshOptions = {}): Promise<SshOutcome> {
 const config = validateSshConfig(await readPrivateJson(options.config)), job = selectSshJob(config, await readPrivateJson(options.job));
 const output = await reserve(options.output);
 try { return await statusSshRemoteTest({ config, job }, { ...injected, receiptStore: r => publishReceiptFile(output.destination, r) }); }
 finally { await output.release(); }
}
export function sshOutcomeExitCode(result: SshOutcome): number { return result.status === "terminal" && result.receipt.status === "passed" ? 0 : 1; }
export function sshOutcomeMessage(result: SshOutcome): string {
 if (result.status === "revoked") return `Remote-test observed ${result.receipt.status} outcome is revoked; no accepted success.\n`;
 if (result.status !== "terminal" && result.reason === "active_job") return "Remote-test active; query status without resubmitting.\n";
 if (result.status !== "terminal" && result.reason === "interrupted_job") return "Remote-test interrupted; inspect executor recovery before any explicit retry. No accepted terminal receipt.\n";
 if (result.status !== "terminal" && result.reason === "expired_job") return "Remote-test infra_failed (expired_job); this call made no submission. Inspect the request deadline and admission before a new attempt.\n";
 if (result.status !== "terminal" && result.reason === "invalid_receipt") return "Remote-test infra_failed (invalid_receipt); inspect private endpoint, identity and freshness. Do not use the refused receipt or automatically resubmit.\n";
 if (result.status !== "terminal" && result.reason === "receiver_failed") return "Remote-test infra_failed (receiver_failed); inspect private admission, execution and storage state before any retry. Do not automatically resubmit.\n";
 return result.status === "terminal" ? `Remote-test ${result.receipt.status}; private receipt saved.\n` : `Remote-test ${result.status} (${result.reason}); retrieve status with the saved exact job, do not resubmit or run local fallback.\n`;
}
