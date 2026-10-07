import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateOperatorPath } from "./baseline.ts";
import { validateRemoteTestJob, validateRemoteTestReceipt, type RemoteTestJob, type RemoteTestReceipt } from "./contract.ts";
import { executeRemoteTest, validateExecutorConfig } from "./executor.ts";
import { ActiveRemoteTestJob, BusyRemoteTestExecutor, InterruptedRemoteTestJob, RemoteTestIdentityConflict, RevokedRemoteTestJob, openJobLedger } from "./job-ledger.ts";
import { InvalidStoredRemoteTestReceipt, readExecutionReceipt } from "./artifacts.ts";
import { SSH_LIMITS, SshRequestSchema, type SshResponse } from "./ssh-protocol.ts";

class InvalidSshReceipt extends Error {}
function producedReceipt(input: unknown, job: RemoteTestJob, executorId: string): RemoteTestReceipt {
 try {
  const receipt = validateRemoteTestReceipt(input, job);
  if (receipt.executorId !== executorId) throw Error("Receipt producer mismatch");
  return receipt;
 } catch { throw new InvalidSshReceipt("Invalid stored or produced receipt"); }
}
export interface SshServerOptions {
 signal?: AbortSignal;
 /** Unit-test seam. Production always uses the bounded durable executor. */
 execute?: typeof executeRemoteTest;
 /** Internal response negotiation seam; job and receipt identities remain V1. */
 onProtocolVersion?: (version: 1 | 2) => void;
}
async function privateDirectory(path: string) {
 const info = await lstat(path);
 if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error("SSH workspace must be private and operator-owned");
}
async function lookup(root: string, job: RemoteTestJob, executorId: string): Promise<RemoteTestReceipt | null> {
 const ledger = await openJobLedger(root, executorId);
 const state = (legacy?: RemoteTestReceipt | null) => {
  let state;
  try { state = legacy ? ledger.inspectLegacy(job, legacy) : ledger.status(job); } catch (e) { if (e instanceof RemoteTestIdentityConflict) throw new InvalidSshReceipt("Ledger identity conflict"); throw e; }
  if (state?.kind === "active") throw new ActiveRemoteTestJob(state);
  if (state?.kind === "interrupted") throw new InterruptedRemoteTestJob(state.attempt);
  if (state?.kind === "revoked") throw new RevokedRemoteTestJob(state.receipt);
  return state?.receipt ?? null;
 };
 // Legacy producers have no ledger entry. Still validate their private receipt;
 // never import a loose artifact into a new admitted attempt after a restart.
 try {
  state();
  const legacy = await readExecutionReceipt(root, job, executorId);
  // No await after this final fence check: cancellation during file I/O wins.
  return state(legacy);
 } finally { ledger.close(); }
}

/** Reviewed fixed command: one bounded JSON line followed by exact bundle
 * bytes and EOF, or a status request with no body. All paths and executable
 * policy come from private local configuration, never the request. */
export async function serveSshRequest(input: AsyncIterable<Uint8Array>, operatorConfig: unknown, options: SshServerOptions = {}): Promise<SshResponse> {
 const config = validateExecutorConfig(operatorConfig);
 await privateOperatorPath(join(config.jobsRoot, "ssh-check"));
 const root = await realpath(config.jobsRoot);
 await privateDirectory(root);
 const iterator = input[Symbol.asyncIterator]();
 const parts: Buffer[] = []; let headerBytes = 0, rest = Buffer.alloc(0);
 for (;;) {
  if (options.signal?.aborted) throw Error("SSH request interrupted");
  const next = await iterator.next(); if (next.done) throw Error("Incomplete SSH header");
  const chunk = Buffer.from(next.value), newline = chunk.indexOf(10);
  const part = newline < 0 ? chunk : chunk.subarray(0, newline);
  headerBytes += part.length;
  if (headerBytes > SSH_LIMITS.headerBytes) throw Error("SSH header exceeds limit");
  parts.push(part);
  if (newline >= 0) { rest = chunk.subarray(newline + 1); break; }
 }
 const request = SshRequestSchema.parse(JSON.parse(Buffer.concat(parts, headerBytes).toString("utf8")));
 options.onProtocolVersion?.(request.version);
 const profileId = (request.job as { profileId?: unknown } | null)?.profileId;
 const selected = config.profiles.find(p => p.profile.profileId === profileId);
 if (!selected) throw Error("Job profile is not operator-approved");
 const job = validateRemoteTestJob(request.job, selected.profile);
 if (request.operation === "status") {
  if (rest.length) throw Error("Unexpected SSH status payload");
  for (;;) { const next = await iterator.next(); if (next.done) break; if (next.value.byteLength) throw Error("Unexpected SSH status payload"); }
  return { version: request.version, receipt: await lookup(root, job, config.executorId) };
 }
 if (job.deadline <= Date.now()) throw Error("SSH submission deadline expired");
 let existing: RemoteTestReceipt | null = null, active = false;
 try { existing = await lookup(root, job, config.executorId); }
 catch (e) { if (e instanceof ActiveRemoteTestJob || e instanceof RevokedRemoteTestJob) active = true; else if (!(e instanceof InterruptedRemoteTestJob)) throw e; }
 if (existing || active) {
  // Drain the bounded declared upload so SSH can finish normally. A duplicate
  // never allocates another upload workspace or starts another execution.
  let bytes = rest.length; if (bytes > request.bundleBytes) throw Error("Oversize duplicate upload");
  for (;;) { const next = await iterator.next(); if (next.done) break; bytes += next.value.byteLength; if (bytes > request.bundleBytes) throw Error("Oversize duplicate upload"); }
  if (bytes !== request.bundleBytes) throw Error("Incomplete duplicate upload");
  // Upload drainage may have outlived the generation too.
  return { version: request.version, receipt: await lookup(root, job, config.executorId) };
 }
 const inbox = join(root, ".ssh-incoming");
 try { await mkdir(inbox, { mode: 0o700 }); }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 await privateDirectory(inbox);
 const directory = join(inbox, job.jobId);
 await mkdir(directory, { mode: 0o700 }); // Exclusive; a busy or stale upload refuses.
 const bundlePath = join(directory, "source.bundle");
 try {
  const file = await open(bundlePath, "wx", 0o600), hash = createHash("sha256"); let count = 0;
  try {
   const write = async (bytes: Uint8Array) => {
    if (options.signal?.aborted || Date.now() >= job.deadline) throw Error("SSH upload interrupted or expired");
    count += bytes.byteLength; if (count > request.bundleBytes) throw Error("SSH bundle exceeds declared size");
    hash.update(bytes);
    let offset = 0;
    while (offset < bytes.byteLength) { const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, null); if (!bytesWritten) throw Error("SSH upload made no progress"); offset += bytesWritten; }
   };
   await write(rest);
   for (;;) { const next = await iterator.next(); if (next.done) break; await write(next.value); }
   if (count !== request.bundleBytes || `sha256:${hash.digest("hex")}` !== job.bundleDigest) throw Error("SSH bundle identity mismatch");
   await file.sync();
  } finally { await file.close(); }
  const receipt = producedReceipt(await (options.execute ?? executeRemoteTest)({ job, bundlePath, config }, { signal: options.signal }), job, config.executorId);
  return { version: request.version, receipt };
 } finally { await rm(directory, { recursive: true }); }
}

/** A completed, authenticated SSH command may report a typed failure without
 * implying a terminal test result. Transport interruption remains uncertain.
 * No private error details enter the response. */
export async function serveSshResponse(input: AsyncIterable<Uint8Array>, config: unknown, options: SshServerOptions = {}): Promise<SshResponse> {
 let version: 1 | 2 = 1;
 try { return await serveSshRequest(input, config, { ...options, onProtocolVersion: value => { version = value; options.onProtocolVersion?.(value); } }); }
 catch (e) {
  if (e instanceof ActiveRemoteTestJob || e instanceof InterruptedRemoteTestJob || e instanceof RevokedRemoteTestJob || e instanceof BusyRemoteTestExecutor) {
   if (version === 1) return { version: 1, receipt: null };
   if (e instanceof RevokedRemoteTestJob) return { version: 2, receipt: e.receipt, state: "revoked" };
   if (e instanceof BusyRemoteTestExecutor) return { version: 2, receipt: null, state: "busy" };
   return { version: 2, receipt: null, state: e instanceof ActiveRemoteTestJob ? "active" : "interrupted" };
  }
  return { version, error: e instanceof InvalidSshReceipt || e instanceof InvalidStoredRemoteTestReceipt ? "invalid_receipt" : "receiver_failed" };
 }
}
