import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { killProcessGroup } from "../exec.ts";
import { privateOperatorPath, shellQuote } from "./baseline.ts";
import { validateProfileManifest, validateRemoteTestJob, validateRemoteTestReceipt, type RemoteTestJob, type RemoteTestReceipt } from "./contract.ts";
import { stageSource } from "./source.ts";
import { SSH_LIMITS, SshResponseSchema, SshStageResponseSchema } from "./ssh-protocol.ts";

const operatorPath = z.string().max(4096).refine(p => isAbsolute(p) && !p.includes("\0") && !/[\r\n]/.test(p));
const ConfigSchema = z.object({
 target: z.string().max(255).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/),
 remoteCli: operatorPath, remoteConfig: operatorPath,
 executorId: z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
 profiles: z.array(z.unknown().transform(validateProfileManifest)).min(1).max(32),
 timeoutSeconds: z.number().int().min(1).max(900).default(660),
 receiptMaxAgeMs: z.number().int().positive().safe().default(86_400_000),
}).strict().refine(c => new Set(c.profiles.map(p => p.profileId)).size === c.profiles.length);
export type SshConfig = z.infer<typeof ConfigSchema>;
export function validateSshConfig(input: unknown): SshConfig { return ConfigSchema.parse(input); }
export function selectSshJob(config: SshConfig, input: unknown): RemoteTestJob {
 const id = (input as { profileId?: unknown } | null)?.profileId;
 const profile = config.profiles.find(p => p.profileId === id);
 if (!profile) throw Error("Job profile is not operator-approved");
 return validateRemoteTestJob(input, profile);
}
export interface SshInvocation { args: string[]; input: AsyncIterable<Uint8Array>; timeoutMs: number; signal?: AbortSignal }
export type SshRunner = (invocation: SshInvocation) => Promise<{ code: number; stdout: string }>;
export type SshOutcome = { status: "terminal"; receipt: RemoteTestReceipt } |
 { status: "revoked"; receipt: RemoteTestReceipt } |
 { status: "pending" | "infra_failed"; reason: "no_terminal_receipt" | "absent_receipt" | "active_job" | "interrupted_job" | "executor_busy" | "expired_job" | "invalid_receipt" | "receiver_failed" | "receipt_store_failed" };
export interface SshOptions {
 runner?: SshRunner; now?: () => number; signal?: AbortSignal;
 /** Persistence failure must not expose passed to a caller. */
 receiptStore?: (receipt: RemoteTestReceipt) => Promise<void>;
}

/** Bounded stdout, discarded diagnostics, bounded input supplied by the client.
 * SSH reads credentials/config locally. No Ranger, bus or forge secrets are
 * inherited, forwarded or encoded in the request. Abort kills the local group;
 * it does not assert cancellation of work on the peer. */
export const sshRunner: SshRunner = async ({ args, input, timeoutMs, signal }) => {
 if (signal?.aborted) throw Error("SSH interrupted");
 const child = spawn("ssh", args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env: {
  PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
  SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
 } });
 const chunks: Buffer[] = []; let count = 0, failure = false;
 const stop = () => { failure = true; if (child.pid) killProcessGroup(child.pid); };
 // Attach completion before feeding stdin, including spawn and EPIPE failures.
 const completion = new Promise<number>((resolve, reject) => {
  child.once("error", reject); child.once("close", code => resolve(code ?? -1));
 });
 child.stdin.on("error", () => { failure = true; stop(); });
 child.stdout.on("data", (chunk: Buffer) => { count += chunk.length; if (count > SSH_LIMITS.responseBytes) { failure = true; stop(); } else chunks.push(chunk); });
 child.stderr.resume();
 signal?.addEventListener("abort", stop, { once: true });
 const timer = setTimeout(stop, timeoutMs);
 if (signal?.aborted) stop();
 const writer = pipeline(Readable.from(input), child.stdin).catch(() => { stop(); });
 try { const code = await completion; await writer; return { code: failure || signal?.aborted ? -1 : code, stdout: Buffer.concat(chunks).toString("utf8") }; }
 finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); child.stdin.destroy(); }
};

// Every remote-shell word is operator-owned and quoted. Job fields never
// parameterize the command or SSH options, even if structurally valid.
async function invoke(config: SshConfig, header: Buffer, bundle: Buffer | undefined, options: SshOptions): Promise<Awaited<ReturnType<SshRunner>> | null> {
 if (header.length > SSH_LIMITS.headerBytes) throw Error("SSH request exceeds header limit");
 const input = (async function* () { yield header; if (bundle) yield bundle; })();
 const command = [config.remoteCli, "remote-test", "serve-stdio", "--config", config.remoteConfig].map(shellQuote).join(" ");
 try {
  return await (options.runner ?? sshRunner)({ args: ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=10", "--", config.target, command], input, timeoutMs: config.timeoutSeconds * 1000, signal: options.signal });
 } catch { return null; }
}
async function exchange(config: SshConfig, job: RemoteTestJob, operation: "submit" | "status", bundle: Buffer | undefined, options: SshOptions): Promise<SshOutcome> {
 const clock = options.now ?? Date.now;
 const missing = (reason: "no_terminal_receipt" | "absent_receipt"): SshOutcome => ({ status: clock() >= job.deadline ? "infra_failed" : "pending", reason });
 const header = Buffer.from(JSON.stringify({ version: 2, operation, job, ...(bundle ? { bundleBytes: bundle.length } : {}) }) + "\n");
 const result = await invoke(config, header, bundle, options);
 if (!result) return missing("no_terminal_receipt");
 // Nonzero transport cannot authenticate its partial output as a receipt.
 // A nonzero exit may be a peer command refusal as well as a lost connection;
 // neither establishes a terminal test result or permission to resubmit.
 if (result.code !== 0) return missing("no_terminal_receipt");
 let receipt: RemoteTestReceipt;
 try {
  if (Buffer.byteLength(result.stdout) > SSH_LIMITS.responseBytes) throw Error("Oversize SSH response");
  const response = SshResponseSchema.parse(JSON.parse(result.stdout));
  if ("error" in response) return { status: "infra_failed", reason: response.error };
  if ("state" in response && response.state && response.state !== "revoked") return { status: "pending", reason: response.state === "busy" ? "executor_busy" : response.state === "active" ? "active_job" : "interrupted_job" };
  if (response.receipt === null) return missing("absent_receipt");
  receipt = validateRemoteTestReceipt(response.receipt, job);
  if (config.profiles.find(p => p.profileId === job.profileId)?.reviewed && receipt.status === "passed" && receipt.coverage?.requiredSkippedTests !== 0) throw Error("Reviewed profile requires complete coverage evidence");
  const age = clock() - receipt.completedAt;
  if (receipt.executorId !== config.executorId || age < 0 || age > config.receiptMaxAgeMs) throw Error("Untrusted or stale receipt");
  if ("state" in response && response.state === "revoked") return { status: "revoked", receipt };
 } catch { return { status: "infra_failed", reason: "invalid_receipt" }; }
 try { await options.receiptStore?.(receipt); }
 catch { return { status: "infra_failed", reason: "receipt_store_failed" }; }
 return { status: "terminal", receipt };
}

/** Submit exactly once. Caller saves the immutable job before any transport;
 * loss of SSH is uncertainty, never permission to resubmit or run locally. */
export async function submitSshRemoteTest(input: { config: unknown; job: unknown; bundlePath: string }, options: SshOptions = {}): Promise<SshOutcome> {
 const config = validateSshConfig(input.config), job = selectSshJob(config, input.job);
 if ((options.now ?? Date.now)() >= job.deadline) return { status: "infra_failed", reason: "expired_job" };
 const bundle = await readBundleSnapshot(input.bundlePath, job.bundleDigest);
 return exchange(config, job, "submit", bundle, options);
}
// Read a bounded snapshot; concurrently enlarged files never cause unbounded
// allocation, and only these hashed bytes are later sent to the peer.
async function readBundleSnapshot(path: string, digest: string): Promise<Buffer> {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const info = await file.stat();
  if (!info.isFile() || info.size <= 0 || info.size > SSH_LIMITS.bundleBytes) throw Error("Bundle exceeds SSH upload limit");
  const bundle = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < bundle.length) { const r = await file.read(bundle, offset, bundle.length - offset, null); if (!r.bytesRead) throw Error("Bundle changed during upload"); offset += r.bytesRead; }
  const extra = Buffer.alloc(1); if ((await file.read(extra, 0, 1, null)).bytesRead) throw Error("Bundle changed during upload");
  if (`sha256:${createHash("sha256").update(bundle).digest("hex")}` !== digest) throw Error("Bundle digest does not match job");
  return bundle;
 } finally { await file.close(); }
}
/** Read-only remote lookup: never stages source, launches tests or retries. */
export async function statusSshRemoteTest(input: { config: unknown; job: unknown }, options: SshOptions = {}): Promise<SshOutcome> {
 const config = validateSshConfig(input.config), job = selectSshJob(config, input.job);
 return exchange(config, job, "status", undefined, options);
}

/** `refused`: this request obtained no reference (never sent, or the receiver
 * answered with a refusal). `uncertain`: no authenticated answer, so the peer
 * may or may not hold the object; that is neither a reference nor a refusal. */
export type SshStageOutcome = { status: "staged"; job: RemoteTestJob; executorId: string; source: { bundleDigest: string; bundleBytes: number } } |
 { status: "refused"; reason: "expired_job" | "receiver_failed" } |
 { status: "uncertain"; reason: "no_response" | "invalid_response" };
/** Stage-only V3 transfer: the peer stores the exact bytes and returns their
 * content reference. Never a receipt, test outcome or admission. Staging is
 * content-addressed, so an uncertain transport may be repeated safely. */
export async function stageSshSource(input: { config: unknown; job: unknown; bundlePath: string }, options: Omit<SshOptions, "receiptStore"> = {}): Promise<SshStageOutcome> {
 const config = validateSshConfig(input.config), job = selectSshJob(config, input.job);
 if ((options.now ?? Date.now)() >= job.deadline) return { status: "refused", reason: "expired_job" };
 const bundle = await readBundleSnapshot(input.bundlePath, job.bundleDigest);
 const result = await invoke(config, Buffer.from(JSON.stringify({ version: 3, operation: "stage", job, bundleBytes: bundle.length }) + "\n"), bundle, options);
 // A lost connection or nonzero exit cannot authenticate the peer's outcome.
 if (!result || result.code !== 0) return { status: "uncertain", reason: "no_response" };
 try {
  if (Buffer.byteLength(result.stdout) > SSH_LIMITS.responseBytes) throw Error("Oversize SSH response");
  const response = SshStageResponseSchema.parse(JSON.parse(result.stdout));
  if ("error" in response) return { status: "refused", reason: "receiver_failed" };
  const { staged } = response, echoed = validateRemoteTestJob(staged.job, config.profiles.find(p => p.profileId === job.profileId)!);
  if (JSON.stringify(echoed) !== JSON.stringify(job) || staged.executorId !== config.executorId ||
   staged.bundleDigest !== job.bundleDigest || staged.bundleBytes !== bundle.length) throw Error("Staged reference does not bind this job");
  return { status: "staged", job, executorId: staged.executorId, source: { bundleDigest: staged.bundleDigest, bundleBytes: staged.bundleBytes } };
 } catch { return { status: "uncertain", reason: "invalid_response" }; }
}

/** Stage the clean committed HEAD with stageSource, bind it to the partial V1
 * request and transfer it with the V3 stage operation. Source bindings are
 * derived, never caller-claimed. Local staging is removed after. */
export async function stageCommittedSource(
 input: { config: unknown; request: Record<string, unknown>; worktree: string; stagingRoot: string; expectedCommit?: string },
 injected: Omit<SshOptions, "receiptStore"> = {},
): Promise<SshStageOutcome> {
 const config = validateSshConfig(input.config), request = input.request;
 for (const field of ["commitDigest", "treeDigest", "bundleDigest"]) if (Object.hasOwn(request, field)) throw Error("Source bindings must be derived from staging");
 selectSshJob(config, { ...request, commitDigest: "0".repeat(40), treeDigest: "0".repeat(40), bundleDigest: `sha256:${"0".repeat(64)}` });
 const stagingRoot = dirname(await privateOperatorPath(join(resolve(input.stagingRoot), "stage-check")));
 const info = await lstat(stagingRoot);
 if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error("Staging root must be private and operator-owned");
 const source = await stageSource({ worktree: resolve(input.worktree), stagingRoot, jobId: String(request.jobId), ...(input.expectedCommit ? { commitDigest: input.expectedCommit } : {}) });
 try {
  const job = selectSshJob(config, { ...request, ...source.manifest });
  return await stageSshSource({ config, job, bundlePath: source.bundlePath }, injected);
 } finally { await rm(dirname(source.bundlePath), { recursive: true }); }
}
