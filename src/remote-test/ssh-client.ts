import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { killProcessGroup } from "../exec.ts";
import { shellQuote } from "./baseline.ts";
import { validateProfileManifest, validateRemoteTestJob, validateRemoteTestReceipt, type RemoteTestJob, type RemoteTestReceipt } from "./contract.ts";

export const SSH_LIMITS = { bundleBytes: 64 * 1024 ** 2, responseBytes: 65_536, headerBytes: 65_536 } as const;
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
 { status: "pending" | "infra_failed"; reason: "no_terminal_receipt" | "absent_receipt" | "expired_job" | "invalid_receipt" | "receipt_store_failed" };
export interface SshOptions {
 runner?: SshRunner; now?: () => number; signal?: AbortSignal;
 /** Persistence failure must not expose passed to a caller. */
 receiptStore?: (receipt: RemoteTestReceipt) => Promise<void>;
}
const ResponseSchema = z.object({ version: z.literal(1), receipt: z.unknown().nullable() }).strict();

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

async function exchange(config: SshConfig, job: RemoteTestJob, operation: "submit" | "status", bundle: Buffer | undefined, options: SshOptions): Promise<SshOutcome> {
 const clock = options.now ?? Date.now;
 const missing = (reason: "no_terminal_receipt" | "absent_receipt"): SshOutcome => ({ status: clock() >= job.deadline ? "infra_failed" : "pending", reason });
 const header = Buffer.from(JSON.stringify({ version: 1, operation, job, ...(bundle ? { bundleBytes: bundle.length } : {}) }) + "\n");
 if (header.length > SSH_LIMITS.headerBytes) throw Error("SSH request exceeds header limit");
 const input = (async function* () { yield header; if (bundle) yield bundle; })();
 // Every remote-shell word is operator-owned and quoted. Job fields never
 // parameterize the command or SSH options, even if structurally valid.
 const command = [config.remoteCli, "remote-test", "serve-stdio", "--config", config.remoteConfig].map(shellQuote).join(" ");
 let result: Awaited<ReturnType<SshRunner>>;
 try {
  result = await (options.runner ?? sshRunner)({ args: ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=10", "--", config.target, command], input, timeoutMs: config.timeoutSeconds * 1000, signal: options.signal });
 } catch { return missing("no_terminal_receipt"); }
 // Nonzero transport cannot authenticate its partial output as a receipt.
 // A nonzero exit may be a peer command refusal as well as a lost connection;
 // neither establishes a terminal test result or permission to resubmit.
 if (result.code !== 0) return missing("no_terminal_receipt");
 let receipt: RemoteTestReceipt;
 try {
  if (Buffer.byteLength(result.stdout) > SSH_LIMITS.responseBytes) throw Error("Oversize SSH response");
  const response = ResponseSchema.parse(JSON.parse(result.stdout));
  if (response.receipt === null) return missing("absent_receipt");
  receipt = validateRemoteTestReceipt(response.receipt, job);
  const age = clock() - receipt.completedAt;
  if (receipt.executorId !== config.executorId || age < 0 || age > config.receiptMaxAgeMs) throw Error("Untrusted or stale receipt");
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
 const file = await open(input.bundlePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 let bundle: Buffer;
 try {
  const info = await file.stat();
  if (!info.isFile() || info.size <= 0 || info.size > SSH_LIMITS.bundleBytes) throw Error("Bundle exceeds SSH upload limit");
  // Read a bounded snapshot; concurrently enlarged files never cause unbounded
  // allocation, and only these hashed bytes are later sent to the peer.
  bundle = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < bundle.length) { const r = await file.read(bundle, offset, bundle.length - offset, null); if (!r.bytesRead) throw Error("Bundle changed during upload"); offset += r.bytesRead; }
  const extra = Buffer.alloc(1); if ((await file.read(extra, 0, 1, null)).bytesRead) throw Error("Bundle changed during upload");
  if (`sha256:${createHash("sha256").update(bundle).digest("hex")}` !== job.bundleDigest) throw Error("Bundle digest does not match job");
 } finally { await file.close(); }
 return exchange(config, job, "submit", bundle, options);
}
/** Read-only remote lookup: never stages source, launches tests or retries. */
export async function statusSshRemoteTest(input: { config: unknown; job: unknown }, options: SshOptions = {}): Promise<SshOutcome> {
 const config = validateSshConfig(input.config), job = selectSshJob(config, input.job);
 return exchange(config, job, "status", undefined, options);
}
