import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ArtifactPolicySchema } from "./artifacts.ts";
import { Sha256Schema, validateRemoteTestJob, type RemoteTestJob } from "./contract.ts";
import { validateExecutorConfig } from "./executor.ts";
import { TaggedReceiverFailure } from "./receiver-diagnostics.ts";
import { restoreSource, SourceError } from "./source.ts";
import { SSH_LIMITS } from "./ssh-protocol.ts";

/** Content reference shared with the bus request: a digest and size, never a path or URL. */
export interface StagedSourceReference { bundleDigest: string; bundleBytes: number }
export type StageRefusalCode = "expired" | "interrupted" | "upload_size" | "upload_digest" | "upload_no_progress" | "unsafe_path" |
 "source_invalid" | "stage_conflict" | "stage_capacity" | "stage_missing" | "stage_busy";
/** Fixed refusal: this request obtained no executable staged reference. */
export class StagedSourceRefusal extends TaggedReceiverFailure {
 constructor(override readonly code: StageRefusalCode, message: string) { super(code, message); }
}
export type StageFaultStep = "bundle-write" | "file-sync" | "meta-write" | "meta-sync" | "dir-sync" | "publish" | "root-sync";
export interface StageStoreOptions {
 now?: () => number; signal?: AbortSignal;
 /** Test seam for interrupted writes and unsupported durability operations. */
 fault?: (step: StageFaultStep) => void | Promise<void>;
 /** Diagnostic stage tracking for the receiver. */
 progress?: (stage: "upload" | "source_store") => void;
 /** Bounded wait for a store lock held by a live stager; then `stage_busy`. */
 lockWaitMs?: number;
}

/** Store sibling of `.artifacts`, `.execution` and `.ssh-incoming`. Restore and
 * recovery own `<jobsRoot>/<jobId>` and the inbox; this store is never either. */
const STORE = ".source-store";
/** SQLite exclusive lock: the kernel releases it when its holder dies, so a
 * crashed stager never leaves the store locked. */
export const STORE_LOCK = ".store-lock.sqlite";
const lockFiles = new Set([STORE_LOCK, `${STORE_LOCK}-journal`, `${STORE_LOCK}-wal`, `${STORE_LOCK}-shm`]);
const LOCK_WAIT_MS = 10_000;
/** Each upload directory names its server-clock expiry. It never publishes
 * past it, so GC reclaims a crashed stager's directory once it has passed.
 * Twice the 900 s client SSH ceiling: within that ceiling a live upload is
 * never reclaimed; one that outlives its expiry refuses rather than publishing. */
export const PENDING_MS = 30 * 60_000;
const pendingName = /^\.pending-(\d{1,16})-[0-9a-f-]{36}$/;
const objectName = /^[a-f0-9]{64}$/;
const ReferenceFileSchema = z.object({
 version: z.literal(1), bundleDigest: Sha256Schema,
 bundleBytes: z.number().int().min(1).max(SSH_LIMITS.bundleBytes),
 storedAt: z.number().int().positive().safe(),
}).strict();
type ReferenceFile = z.infer<typeof ReferenceFileSchema>;

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
async function syncDirectory(path: string) {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try { await file.sync(); } finally { await file.close(); }
}
async function privateDirectory(path: string) {
 const info = await lstat(path);
 if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new StagedSourceRefusal("unsafe_path", "Source store must be private and operator-owned");
}
/** Entries removed concurrently (another stager's GC or failed upload) count as zero. */
async function size(path: string): Promise<number> {
 let info; try { info = await lstat(path); } catch (e) { if (missing(e)) return 0; throw e; }
 if (info.isFile()) return info.size;
 if (!info.isDirectory()) throw new StagedSourceRefusal("unsafe_path", "Unsupported source store entry");
 let names: string[]; try { names = await readdir(path); } catch (e) { if (missing(e)) return 0; throw e; }
 let bytes = 0;
 for (const name of names) bytes += await size(join(path, name));
 if (!Number.isSafeInteger(bytes)) throw Error("Source store accounting overflow");
 return bytes;
}
async function openPrivateFile(path: string, limit: number) {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 const info = await file.stat().catch(async e => { await file.close(); throw e; });
 if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.nlink !== 1 || info.size > limit) {
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

/** Take the store's exclusive lock, retrying asynchronously (never blocking the
 * event loop) for a bounded time. A lock file that is not private refuses. */
async function lockStore(store: string, waitMs: number, signal?: AbortSignal): Promise<() => void> {
 const path = join(store, STORE_LOCK);
 try { const file = await open(path, "wx", 0o600); try { await file.sync(); } finally { await file.close(); } await syncDirectory(store); }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 await (await openPrivateFile(path, 1024 ** 2)).file.close();
 const db = new Database(path, { strict: true }), until = Date.now() + waitMs;
 try {
  db.exec("PRAGMA busy_timeout=0");
  for (;;) {
   try { db.exec("BEGIN EXCLUSIVE"); break; }
   catch (e) { if ((e as { code?: string }).code !== "SQLITE_BUSY") throw e; }
   if (signal?.aborted) throw new StagedSourceRefusal("interrupted", "Stage interrupted while waiting for the store lock");
   if (Date.now() >= until) throw new StagedSourceRefusal("stage_busy", "Source store is locked by another stager");
   await Bun.sleep(25);
  }
 } catch (e) { try { db.close(); } catch {} throw e; }
 return () => { try { db.exec("ROLLBACK"); } catch {} try { db.close(); } catch {} };
}

/** Write the declared upload exclusively into the pending object, checking
 * deadline, declared size and digest before fsync. Returns the byte count. */
async function writePendingBundle(bundlePath: string, input: { job: RemoteTestJob; declaredBytes: number; chunks: AsyncIterable<Uint8Array> }, now: () => number, options: StageStoreOptions) {
 const file = await open(bundlePath, "wx", 0o600), hash = createHash("sha256"); let count = 0;
 try {
  await options.fault?.("bundle-write");
  for await (const bytes of input.chunks) {
   if (options.signal?.aborted) throw new StagedSourceRefusal("interrupted", "Stage upload interrupted");
   if (now() >= input.job.deadline) throw new StagedSourceRefusal("expired", "Stage upload expired");
   count += bytes.byteLength; if (count > input.declaredBytes) throw new StagedSourceRefusal("upload_size", "Stage upload exceeds declared size");
   hash.update(bytes);
   let offset = 0;
   while (offset < bytes.byteLength) { const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, null); if (!bytesWritten) throw new StagedSourceRefusal("upload_no_progress", "Stage upload made no progress"); offset += bytesWritten; }
  }
  if (count !== input.declaredBytes) throw new StagedSourceRefusal("upload_size", "Truncated stage upload");
  if (`sha256:${hash.digest("hex")}` !== input.job.bundleDigest) throw new StagedSourceRefusal("upload_digest", "Stage upload digest mismatch");
  await options.fault?.("file-sync"); await file.sync();
 } finally { await file.close(); }
 return count;
}
async function writeReference(pending: string, reference: ReferenceFile, options: StageStoreOptions) {
 const json = Buffer.from(JSON.stringify(reference) + "\n");
 const meta = await open(join(pending, "reference.json"), "wx", 0o600);
 try { await options.fault?.("meta-write"); await meta.writeFile(json); await options.fault?.("meta-sync"); await meta.sync(); }
 finally { await meta.close(); }
 await options.fault?.("dir-sync"); await syncDirectory(pending);
 return json.length;
}
/** Under the store lock: reclaim expired pending uploads and expired validated
 * objects, then return either the same unexpired object or the retained total.
 * Unknown entries are counted and kept; unexpired objects are never evicted. */
async function sweepStore(store: string, own: string, digest: string, now: number, retentionMs: number): Promise<{ existing: ReferenceFile } | { total: number }> {
 const name = digest.slice("sha256:".length);
 let total = 0;
 for (const entry of await readdir(store)) {
  if (lockFiles.has(entry) || entry === own) continue;
  const path = join(store, entry);
  try {
   const pending = pendingName.exec(entry);
   if (pending && Number(pending[1]) <= now) { await rm(path, { recursive: true, force: true }); continue; }
   if (objectName.test(entry)) {
    await privateDirectory(path);
    if (entry === name) {
     const stored = await verifyObject(path, digest);
     if (!expired(stored, now, retentionMs)) return { existing: stored };
     await rm(path, { recursive: true }); continue;
    }
    const stored = await readReference(path).catch(() => null);
    if (stored && stored.bundleDigest === `sha256:${entry}` && expired(stored, now, retentionMs)) { await rm(path, { recursive: true }); continue; }
   }
   total += await size(path);
  } catch (e) { if (!missing(e)) throw e; }
 }
 if (!Number.isSafeInteger(total)) throw Error("Source store accounting overflow");
 return { total };
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
 const pendingExpiry = Math.min(job.deadline, now() + PENDING_MS);
 const own = `.pending-${pendingExpiry}-${randomUUID()}`, pending = join(store, own);
 await mkdir(pending, { mode: 0o700 });
 let unlock: (() => void) | undefined, published: string | undefined;
 try {
  const bundlePath = join(pending, "source.bundle");
  const count = await writePendingBundle(bundlePath, input, now, options);
  options.progress?.("source_store");
  // Existing restore validation in a scratch root inside the pending object:
  // never `<jobsRoot>/<jobId>`, which the later execution allocates exclusively.
  const scratch = join(pending, "validate");
  await mkdir(scratch, { mode: 0o700 });
  try { await restoreSource({ bundlePath, manifest: sourceManifest(job), jobsRoot: scratch, jobId: job.jobId }); }
  catch (e) { if (e instanceof SourceError && e.code !== "source_io") throw new StagedSourceRefusal("source_invalid", "Staged source failed Git validation"); throw e; }
  finally { await rm(scratch, { recursive: true, force: true }); }
  const reference: ReferenceFile = { version: 1, bundleDigest: job.bundleDigest, bundleBytes: count, storedAt: now() };
  const metaBytes = await writeReference(pending, reference, options);
  // Serialized GC/publication across processes.
  unlock = await lockStore(store, options.lockWaitMs ?? LOCK_WAIT_MS, options.signal);
  // The address is the digest just computed from received bytes (equal to the job's).
  const swept = await sweepStore(store, own, job.bundleDigest, now(), policy.retentionMs);
  if ("existing" in swept) return { bundleDigest: swept.existing.bundleDigest, bundleBytes: swept.existing.bundleBytes };
  if (swept.total + count + metaBytes > policy.maxArtifactBytes) throw new StagedSourceRefusal("stage_capacity", "Retained sources exhaust store capacity");
  // Past its pending expiry another stager may already have reclaimed this upload.
  if (job.deadline <= now() || pendingExpiry <= now()) throw new StagedSourceRefusal("expired", "Stage request deadline expired");
  const destination = join(store, job.bundleDigest.slice("sha256:".length));
  // A directory rename silently replaces an empty directory: refuse any entry.
  try { await lstat(destination); throw new StagedSourceRefusal("stage_conflict", "Source store entry already exists"); }
  catch (e) { if (!missing(e)) throw e; }
  await options.fault?.("publish"); await rename(pending, destination); published = destination;
  await options.fault?.("root-sync"); await syncDirectory(store);
  published = undefined;
  return { bundleDigest: reference.bundleDigest, bundleBytes: reference.bundleBytes };
 } catch (error) {
  // A publication without durable directory state is withdrawn, never returned.
  // A failed withdrawal never masks the primary error.
  if (published) { try { await rm(published, { recursive: true }); await syncDirectory(store); } catch {} }
  throw error;
 } finally {
  await rm(pending, { recursive: true, force: true }).catch(() => {});
  unlock?.();
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
 catch (e) { if (missing(e)) throw new StagedSourceRefusal("stage_missing", "No staged source for this job"); throw e; }
 const reference = await verifyObject(directory, job.bundleDigest);
 if (expired(reference, (options.now ?? Date.now)(), config.artifacts.retentionMs)) throw new StagedSourceRefusal("expired", "Staged source expired");
 const restored = await restoreSource({ bundlePath: join(directory, "source.bundle"), manifest: sourceManifest(job), jobsRoot: root, jobId: job.jobId });
 return { ...restored, reference: { bundleDigest: reference.bundleDigest, bundleBytes: reference.bundleBytes } as StagedSourceReference };
}
