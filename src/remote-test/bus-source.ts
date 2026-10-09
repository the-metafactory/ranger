import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { privateOperatorPath } from "./baseline.ts";
import { ArtifactPolicySchema } from "./artifacts.ts";
import { Sha256Schema, validateRemoteTestJob, type RemoteTestJob } from "./contract.ts";
import { validateExecutorConfig } from "./executor.ts";
import { TaggedReceiverFailure } from "./receiver-diagnostics.ts";
import { restoreSource, SourceError, stageSource } from "./source.ts";
import { selectSshJob, stageSshSource, validateSshConfig, type SshOptions, type SshStageOutcome } from "./ssh-client.ts";
import { SSH_LIMITS } from "./ssh-protocol.ts";

/** Content reference shared with the bus request: a digest and size, never a path or URL. */
export interface StagedSourceReference { bundleDigest: string; bundleBytes: number }
export type StageRefusalCode = "expired" | "interrupted" | "upload_size" | "upload_digest" | "upload_no_progress" | "unsafe_path" |
 "source_invalid" | "stage_conflict" | "stage_capacity" | "stage_missing";
/** Fixed refusal: no executable staged reference exists for this request. */
export class StagedSourceRefusal extends TaggedReceiverFailure {
 constructor(override readonly code: StageRefusalCode, message: string) { super(code, message); }
}
export type StageFaultStep = "bundle-write" | "file-sync" | "meta-write" | "dir-sync" | "publish" | "root-sync";
export interface StageStoreOptions {
 now?: () => number; signal?: AbortSignal;
 /** Test seam for interrupted writes and unsupported durability operations. */
 fault?: (step: StageFaultStep) => void | Promise<void>;
 /** Diagnostic stage tracking for the receiver. */
 progress?: (stage: "upload" | "source_store") => void;
}

/** Store sibling of `.artifacts`, `.execution` and `.ssh-incoming`. Restore and
 * recovery own `<jobsRoot>/<jobId>` and the inbox; this store is never either. */
const STORE = ".source-store";
const objectName = /^[a-f0-9]{64}$/;
const ReferenceFileSchema = z.object({
 version: z.literal(1), bundleDigest: Sha256Schema,
 bundleBytes: z.number().int().min(1).max(SSH_LIMITS.bundleBytes),
 storedAt: z.number().int().positive().safe(),
}).strict();
type ReferenceFile = z.infer<typeof ReferenceFileSchema>;

async function syncDirectory(path: string) {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try { await file.sync(); } finally { await file.close(); }
}
async function privateDirectory(path: string) {
 const info = await lstat(path);
 if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new StagedSourceRefusal("unsafe_path", "Source store must be private and operator-owned");
}
async function size(path: string): Promise<number> {
 const info = await lstat(path);
 if (info.isFile()) return info.size;
 if (!info.isDirectory()) throw new StagedSourceRefusal("unsafe_path", "Unsupported source store entry");
 let bytes = 0;
 for (const name of await readdir(path)) bytes += await size(join(path, name));
 if (!Number.isSafeInteger(bytes)) throw Error("Source store accounting overflow");
 return bytes;
}
async function openPrivateFile(path: string, limit: number) {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 const info = await file.stat().catch(async e => { await file.close(); throw e; });
 if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > limit) {
  await file.close(); throw new StagedSourceRefusal("unsafe_path", "Unsafe staged source file");
 }
 return { file, size: info.size };
}
async function readReference(directory: string): Promise<ReferenceFile> {
 const { file } = await openPrivateFile(join(directory, "reference.json"), 4096);
 try {
  const parsed = ReferenceFileSchema.safeParse(JSON.parse(await file.readFile("utf8")));
  if (!parsed.success) throw Error("Invalid staged reference");
  return parsed.data;
 } finally { await file.close(); }
}
/** Recompute size and digest of the stored bytes; the store name, reference and
 * bytes must all name the same content. Any disagreement is a mismatch. */
async function verifyObject(directory: string, digest: string): Promise<ReferenceFile> {
 let reference: ReferenceFile;
 try { reference = await readReference(directory); }
 catch (e) { if (e instanceof StagedSourceRefusal) throw e; throw new StagedSourceRefusal("stage_conflict", "Stored source reference is invalid"); }
 if (reference.bundleDigest !== digest) throw new StagedSourceRefusal("stage_conflict", "Stored source does not match its content address");
 const { file, size: bytes } = await openPrivateFile(join(directory, "source.bundle"), SSH_LIMITS.bundleBytes);
 try {
  if (bytes !== reference.bundleBytes) throw new StagedSourceRefusal("stage_conflict", "Stored source size mismatch");
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let total = 0;
  for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; total += bytesRead; hash.update(buffer.subarray(0, bytesRead)); }
  if (total !== reference.bundleBytes || `sha256:${hash.digest("hex")}` !== digest) throw new StagedSourceRefusal("stage_conflict", "Stored source bytes mismatch");
 } finally { await file.close(); }
 return reference;
}
const expired = (reference: ReferenceFile, now: number, retentionMs: number) => now - reference.storedAt >= retentionMs;
function sourceManifest(job: RemoteTestJob) {
 return { version: 1 as const, commitDigest: job.commitDigest, treeDigest: job.treeDigest, bundleDigest: job.bundleDigest };
}

/** Receive one declared upload for an already validated job and store it under
 * its verified content address. Never consults the job ledger or executor.
 * Exact size, digest and immutable Git object/tree validation precede the
 * exclusive pending write's publication by rename; file, pending directory and
 * store root are fsynced. The same exact object is returned without replacement. */
export async function receiveStagedSource(
 input: { jobsRoot: string; job: RemoteTestJob; declaredBytes: number; chunks: AsyncIterable<Uint8Array>; policy?: unknown },
 options: StageStoreOptions = {},
): Promise<StagedSourceReference> {
 const policy = ArtifactPolicySchema.parse(input.policy ?? {}), now = options.now ?? Date.now, job = input.job;
 if (!Number.isSafeInteger(input.declaredBytes) || input.declaredBytes < 1 || input.declaredBytes > SSH_LIMITS.bundleBytes) throw new StagedSourceRefusal("upload_size", "Declared source size out of bounds");
 if (job.deadline <= now()) throw new StagedSourceRefusal("expired", "Stage request deadline expired");
 options.progress?.("upload");
 const root = await realpath(input.jobsRoot); await privateDirectory(root);
 const store = join(root, STORE);
 try { await mkdir(store, { mode: 0o700 }); await syncDirectory(root); }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 await privateDirectory(store);
 const pending = join(store, `.pending-${randomUUID()}`);
 await mkdir(pending, { mode: 0o700 });
 let lock: string | undefined, published: string | undefined;
 try {
  const bundlePath = join(pending, "source.bundle");
  const file = await open(bundlePath, "wx", 0o600), hash = createHash("sha256"); let count = 0;
  try {
   await options.fault?.("bundle-write");
   for await (const bytes of input.chunks) {
    if (options.signal?.aborted) throw new StagedSourceRefusal("interrupted", "Stage upload interrupted");
    if (now() >= job.deadline) throw new StagedSourceRefusal("expired", "Stage upload expired");
    count += bytes.byteLength; if (count > input.declaredBytes) throw new StagedSourceRefusal("upload_size", "Stage upload exceeds declared size");
    hash.update(bytes);
    let offset = 0;
    while (offset < bytes.byteLength) { const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, null); if (!bytesWritten) throw new StagedSourceRefusal("upload_no_progress", "Stage upload made no progress"); offset += bytesWritten; }
   }
   if (count !== input.declaredBytes) throw new StagedSourceRefusal("upload_size", "Truncated stage upload");
   if (`sha256:${hash.digest("hex")}` !== job.bundleDigest) throw new StagedSourceRefusal("upload_digest", "Stage upload digest mismatch");
   await options.fault?.("file-sync"); await file.sync();
  } finally { await file.close(); }
  options.progress?.("source_store");
  // The address is the digest just computed from received bytes (equal to the job's).
  const name = job.bundleDigest.slice("sha256:".length);
  // Existing restore validation in a scratch root inside the pending object:
  // never `<jobsRoot>/<jobId>`, which the later execution allocates exclusively.
  const scratch = join(pending, "validate");
  await mkdir(scratch, { mode: 0o700 });
  try { await restoreSource({ bundlePath, manifest: sourceManifest(job), jobsRoot: scratch, jobId: job.jobId }); }
  catch (e) { if (e instanceof SourceError && e.code !== "source_io") throw new StagedSourceRefusal("source_invalid", "Staged source failed Git validation"); throw e; }
  finally { await rm(scratch, { recursive: true, force: true }); }
  const reference: ReferenceFile = { version: 1, bundleDigest: job.bundleDigest, bundleBytes: count, storedAt: now() };
  const json = Buffer.from(JSON.stringify(reference) + "\n");
  const meta = await open(join(pending, "reference.json"), "wx", 0o600);
  try { await options.fault?.("meta-write"); await meta.writeFile(json); await options.fault?.("file-sync"); await meta.sync(); }
  finally { await meta.close(); }
  await options.fault?.("dir-sync"); await syncDirectory(pending);
  // Serialized GC/publication. Busy or stale locks fail closed, never steal.
  const lockPath = join(store, ".store-lock");
  await mkdir(lockPath, { mode: 0o700 }); lock = lockPath;
  const pendingName = pending.slice(store.length + 1);
  let total = 0;
  for (const entry of await readdir(store)) {
   if (entry === ".store-lock" || entry === pendingName) continue;
   const path = join(store, entry), bytes = await size(path);
   // Only validated, expired objects are reclaimed; unknown or pending entries
   // are counted and kept. Unexpired evidence is never evicted for capacity.
   if (objectName.test(entry) && entry !== name) {
    await privateDirectory(path);
    const stored = await readReference(path).catch(() => null);
    if (stored && stored.bundleDigest === `sha256:${entry}` && expired(stored, now(), policy.retentionMs)) { await rm(path, { recursive: true }); continue; }
   }
   if (entry === name) {
    await privateDirectory(path);
    const stored = await verifyObject(path, job.bundleDigest);
    if (!expired(stored, now(), policy.retentionMs)) return { bundleDigest: stored.bundleDigest, bundleBytes: stored.bundleBytes };
    await rm(path, { recursive: true }); continue;
   }
   total += bytes;
  }
  if (!Number.isSafeInteger(total) || total + count + json.length > policy.maxArtifactBytes) throw new StagedSourceRefusal("stage_capacity", "Retained sources exhaust store capacity");
  if (job.deadline <= now()) throw new StagedSourceRefusal("expired", "Stage request deadline expired");
  const destination = join(store, name);
  // A directory rename silently replaces an empty directory: refuse any entry.
  try { await lstat(destination); throw new StagedSourceRefusal("stage_conflict", "Source store entry already exists"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  await options.fault?.("publish"); await rename(pending, destination); published = destination;
  await options.fault?.("root-sync"); await syncDirectory(store);
  published = undefined;
  return { bundleDigest: reference.bundleDigest, bundleBytes: reference.bundleBytes };
 } catch (error) {
  // A publication without durable directory state is withdrawn, never returned.
  if (published) { await rm(published, { recursive: true }); await syncDirectory(store); }
  throw error;
 } finally {
  await rm(pending, { recursive: true, force: true }).catch(() => {});
  if (lock) await rm(lock, { recursive: true });
 }
}

/** Consumer side: an admitted job names its source only by bundle digest. The
 * staged bytes are rechecked against the private reference, then the existing
 * restoreSource validation snapshots, re-hashes and detaches the exact commit.
 * Missing, expired, unsafe or corrupt objects never become execution source. */
export async function loadStagedSource(input: { config: unknown; job: unknown }, options: { now?: () => number } = {}) {
 const config = validateExecutorConfig(input.config);
 const selected = config.profiles.find(p => p.profile.profileId === (input.job as { profileId?: unknown } | null)?.profileId);
 if (!selected) throw Error("Job profile is not operator-approved");
 const job = validateRemoteTestJob(input.job, selected.profile);
 const root = await realpath(config.jobsRoot); await privateDirectory(root);
 const directory = join(root, STORE, job.bundleDigest.slice("sha256:".length));
 try { await privateDirectory(join(root, STORE)); await privateDirectory(directory); }
 catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new StagedSourceRefusal("stage_missing", "No staged source for this job"); throw e; }
 const reference = await verifyObject(directory, job.bundleDigest);
 if (expired(reference, (options.now ?? Date.now)(), config.artifacts.retentionMs)) throw new StagedSourceRefusal("expired", "Staged source expired");
 const restored = await restoreSource({ bundlePath: join(directory, "source.bundle"), manifest: sourceManifest(job), jobsRoot: root, jobId: job.jobId });
 return { ...restored, reference: { bundleDigest: reference.bundleDigest, bundleBytes: reference.bundleBytes } as StagedSourceReference };
}

/** Client side: stage the clean committed HEAD with stageSource, bind it to the
 * partial V1 request and transfer it with the V3 stage operation. Source
 * bindings are derived, never caller-claimed. Local staging is removed after. */
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
