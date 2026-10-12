import { classifyReceiverFailure, diagnosticJobsRoot, saveRefusalDiagnostic, TaggedReceiverFailure, type DiagnosticStage, type RefusalDiagnostic, type ReceiverDiagnostics } from "./receiver-diagnostics.ts";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateOperatorPath } from "./baseline.ts";
import { validateRemoteTestJob, validateRemoteTestReceipt, type RemoteTestJob, type RemoteTestReceipt } from "./contract.ts";
import { executeRemoteTest, validateExecutorConfig } from "./executor.ts";
import { ActiveRemoteTestJob, BusyRemoteTestExecutor, InterruptedRemoteTestJob, RemoteTestIdentityConflict, RevokedRemoteTestJob, openJobLedger } from "./job-ledger.ts";
import { InvalidStoredRemoteTestReceipt, readExecutionReceipt } from "./artifacts.ts";
import { SSH_LIMITS, SshRequestSchema, type SshResponse, type SshStageResponse } from "./ssh-protocol.ts";
import { receiveStagedSource, type StageStoreOptions } from "./bus-source.ts";

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
 onProtocolVersion?: (version: 1 | 2 | 3) => void;
 /** Fixed operator configuration only, never taken from JSON/job/environment. */
 diagnostics?: ReceiverDiagnostics;
 /** Narrow upload/cleanup fault seam. */
 fs?: Partial<{ open: typeof open; rm: typeof rm }>;
 /** Deterministic expiry fixture; production uses the server clock. */
 now?: () => number;
 /** Source-store durability fault and lock-wait seams for stage-only requests. */
 sourceStore?: Pick<StageStoreOptions, "fault" | "lockWaitMs">;
}
interface RefusalContext {
 stage: DiagnosticStage;
 operation: "submit" | "status" | "stage" | null;
 job: RefusalDiagnostic["job"];
 jobsRoot?: string;
 primary?: RefusalDiagnostic["primary"];
 cleanup?: RefusalDiagnostic["cleanup"];
}
async function privateDirectory(path: string) {
 const info = await lstat(path);
 if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new TaggedReceiverFailure("unsafe_path", "SSH workspace must be private and operator-owned");
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
export async function serveSshRequest(input: AsyncIterable<Uint8Array>, operatorConfig: unknown, options: SshServerOptions = {}): Promise<SshResponse | SshStageResponse> {
 return receive(input, operatorConfig, options, { stage: "config", operation: null, job: null });
}
function failureTag(error: unknown, stage: DiagnosticStage) {
 if (error instanceof InvalidSshReceipt || error instanceof InvalidStoredRemoteTestReceipt) return { stage, code: "invalid_receipt" as const };
 return classifyReceiverFailure(error, stage);
}
function isStateOutcome(error: unknown): error is ActiveRemoteTestJob | InterruptedRemoteTestJob | RevokedRemoteTestJob | BusyRemoteTestExecutor {
 return error instanceof ActiveRemoteTestJob || error instanceof InterruptedRemoteTestJob || error instanceof RevokedRemoteTestJob || error instanceof BusyRemoteTestExecutor;
}
async function receive(input: AsyncIterable<Uint8Array>, operatorConfig: unknown, options: SshServerOptions, context: RefusalContext): Promise<SshResponse | SshStageResponse> {
 const now = options.now ?? Date.now;
 context.stage = "config";
 context.jobsRoot = diagnosticJobsRoot(operatorConfig);
 let config;
 try { config = validateExecutorConfig(operatorConfig); }
 catch { throw new TaggedReceiverFailure("invalid_config", "Invalid executor configuration"); }
 context.jobsRoot = config.jobsRoot;
 context.stage = "root";
 try { await privateOperatorPath(join(config.jobsRoot, "ssh-check")); }
 catch (error) {
  if (classifyReceiverFailure(error, "root").code === "unknown") throw new TaggedReceiverFailure("unsafe_path", "Unsafe SSH workspace");
  throw error;
 }
 const root = await realpath(config.jobsRoot);
 await privateDirectory(root);
 context.jobsRoot = root;
 context.stage = "header";
 const iterator = input[Symbol.asyncIterator]();
 const parts: Buffer[] = []; let headerBytes = 0, rest = Buffer.alloc(0);
 for (;;) {
  if (options.signal?.aborted) throw new TaggedReceiverFailure("interrupted", "SSH request interrupted");
  const next = await iterator.next(); if (next.done) throw new TaggedReceiverFailure("incomplete_header", "Incomplete SSH header");
  const chunk = Buffer.from(next.value), newline = chunk.indexOf(10);
  const part = newline < 0 ? chunk : chunk.subarray(0, newline);
  headerBytes += part.length;
  if (headerBytes > SSH_LIMITS.headerBytes) throw new TaggedReceiverFailure("header_limit", "SSH header exceeds limit");
  parts.push(part);
  if (newline >= 0) { rest = chunk.subarray(newline + 1); break; }
 }
 context.stage = "request";
 let request;
 try { request = SshRequestSchema.parse(JSON.parse(Buffer.concat(parts, headerBytes).toString("utf8"))); }
 catch { throw new TaggedReceiverFailure("malformed_request", "Malformed SSH request"); }
 context.operation = request.operation;
 options.onProtocolVersion?.(request.version);
 const profileId = (request.job as { profileId?: unknown } | null)?.profileId;
 const selected = config.profiles.find(p => p.profile.profileId === profileId);
 if (!selected) throw new TaggedReceiverFailure("profile_not_approved", "Job profile is not operator-approved");
 let job;
 try { job = validateRemoteTestJob(request.job, selected.profile); }
 catch { throw new TaggedReceiverFailure("job_invalid", "Invalid SSH job"); }
 context.job = { jobId: job.jobId, generation: job.generation };
 if (request.operation === "stage") {
  // Stage-only: content-addressed source storage. No ledger lookup or
  // admission, no inbox, no executor; the reference is not a test outcome.
  const chunks = (async function* () { if (rest.length) yield rest; for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value; } })();
  const source = await receiveStagedSource({ jobsRoot: root, job, declaredBytes: request.bundleBytes, chunks, policy: config.artifacts },
   { now, signal: options.signal, fault: options.sourceStore?.fault, lockWaitMs: options.sourceStore?.lockWaitMs, progress: stage => { context.stage = stage; } });
  return { version: 3, staged: { job, executorId: config.executorId, ...source } };
 }
 if (request.operation === "status") {
  if (rest.length) throw new TaggedReceiverFailure("unexpected_payload", "Unexpected SSH status payload");
  for (;;) { const next = await iterator.next(); if (next.done) break; if (next.value.byteLength) throw new TaggedReceiverFailure("unexpected_payload", "Unexpected SSH status payload"); }
  context.stage = "lookup";
  return { version: request.version, receipt: await lookup(root, job, config.executorId) };
 }
 if (job.deadline <= now()) throw new TaggedReceiverFailure("expired", "SSH submission deadline expired");
 context.stage = "lookup";
 let existing: RemoteTestReceipt | null = null, active = false;
 try { existing = await lookup(root, job, config.executorId); }
 catch (e) { if (e instanceof ActiveRemoteTestJob || e instanceof RevokedRemoteTestJob) active = true; else if (!(e instanceof InterruptedRemoteTestJob)) throw e; }
 if (existing || active) {
  context.stage = "upload";
  // Drain the bounded declared upload so SSH can finish normally. A duplicate
  // never allocates another upload workspace or starts another execution.
  let bytes = rest.length; if (bytes > request.bundleBytes) throw new TaggedReceiverFailure("upload_size", "Oversize duplicate upload");
  for (;;) { const next = await iterator.next(); if (next.done) break; bytes += next.value.byteLength; if (bytes > request.bundleBytes) throw new TaggedReceiverFailure("upload_size", "Oversize duplicate upload"); }
  if (bytes !== request.bundleBytes) throw new TaggedReceiverFailure("upload_size", "Incomplete duplicate upload");
  // Upload drainage may have outlived the generation too.
  context.stage = "lookup";
  return { version: request.version, receipt: await lookup(root, job, config.executorId) };
 }
 context.stage = "upload";
 const inbox = join(root, ".ssh-incoming");
 try { await mkdir(inbox, { mode: 0o700 }); }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 await privateDirectory(inbox);
 const directory = join(inbox, job.jobId);
 await mkdir(directory, { mode: 0o700 }); // Exclusive; a busy or stale upload refuses.
 const bundlePath = join(directory, "source.bundle");
 try {
  const file = await (options.fs?.open ?? open)(bundlePath, "wx", 0o600), hash = createHash("sha256"); let count = 0;
  try {
   const write = async (bytes: Uint8Array) => {
    if (options.signal?.aborted) throw new TaggedReceiverFailure("interrupted", "SSH upload interrupted or expired");
    if (now() >= job.deadline) throw new TaggedReceiverFailure("expired", "SSH upload interrupted or expired");
    count += bytes.byteLength; if (count > request.bundleBytes) throw new TaggedReceiverFailure("upload_size", "SSH bundle exceeds declared size");
    hash.update(bytes);
    let offset = 0;
    while (offset < bytes.byteLength) { const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, null); if (!bytesWritten) throw new TaggedReceiverFailure("upload_no_progress", "SSH upload made no progress"); offset += bytesWritten; }
   };
   await write(rest);
   for (;;) { const next = await iterator.next(); if (next.done) break; await write(next.value); }
   if (count !== request.bundleBytes) throw new TaggedReceiverFailure("upload_size", "SSH bundle identity mismatch");
   if (`sha256:${hash.digest("hex")}` !== job.bundleDigest) throw new TaggedReceiverFailure("upload_digest", "SSH bundle identity mismatch");
   await file.sync();
  } finally { await file.close(); }
  context.stage = "executor_boundary";
  const produced = await (options.execute ?? executeRemoteTest)({ job, bundlePath, config }, { signal: options.signal });
  context.stage = "receipt";
  const receipt = producedReceipt(produced, job, config.executorId);
  return { version: request.version, receipt };
 } catch (error) {
  if (!isStateOutcome(error)) context.primary = failureTag(error, context.stage);
  throw error;
 } finally {
  context.stage = "cleanup";
  try { await (options.fs?.rm ?? rm)(directory, { recursive: true }); }
  catch (error) { context.cleanup = failureTag(error, "cleanup"); throw error; }
 }
}

/** A completed, authenticated SSH command may report a typed failure without
 * implying a terminal test result. Transport interruption remains uncertain.
 * No private error details enter the response. */
export async function serveSshResponse(input: AsyncIterable<Uint8Array>, config: unknown, options: SshServerOptions = {}): Promise<SshResponse | SshStageResponse> {
 // Numbers legacy submit/status replies only; a stage reply is always V3.
 let version = 1 as 1 | 2;
 const context: RefusalContext = { stage: "config", operation: null, job: null };
 try { return await receive(input, config, { ...options, onProtocolVersion: value => { if (value !== 3) version = value; options.onProtocolVersion?.(value); } }, context); }
 catch (e) {
  // A stage reply is never a receipt or test state, whatever its protocol version.
  const staging = context.operation === "stage";
  if (isStateOutcome(e) && !staging) {
   if (version === 1) return { version: 1, receipt: null };
   if (e instanceof RevokedRemoteTestJob) return { version: 2, receipt: e.receipt, state: "revoked" };
   if (e instanceof BusyRemoteTestExecutor) return { version: 2, receipt: null, state: "busy" };
   return { version: 2, receipt: null, state: e instanceof ActiveRemoteTestJob ? "active" : "interrupted" };
  }
  await saveRefusalDiagnostic(options.diagnostics, {
   operation: context.operation, job: context.job,
   primary: context.primary ?? failureTag(e, context.stage),
   ...(context.primary && context.cleanup ? { cleanup: context.cleanup } : {}),
  }, context.jobsRoot);
  if (staging) return { version: 3, error: "receiver_failed" };
  return { version, error: e instanceof InvalidSshReceipt || e instanceof InvalidStoredRemoteTestReceipt ? "invalid_receipt" : "receiver_failed" };
 }
}
