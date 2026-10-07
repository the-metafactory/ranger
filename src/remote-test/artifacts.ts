import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { privateOperatorPath } from "./baseline.ts";
import { validateRemoteTestReceipt, type RemoteTestReceipt, type ResourceObservation } from "./contract.ts";

export const ARTIFACT_DEFAULTS = { retentionMs: 7 * 24 * 60 * 60 * 1000, maxArtifactBytes: 10 * 1024 ** 3, maxLogBytes: 1024 ** 2 } as const;
export const ArtifactPolicySchema = z.object({
 retentionMs: z.number().int().positive().safe().default(ARTIFACT_DEFAULTS.retentionMs),
 maxArtifactBytes: z.number().int().positive().safe().default(ARTIFACT_DEFAULTS.maxArtifactBytes),
 maxLogBytes: z.number().int().positive().max(64 * 1024 ** 2).default(ARTIFACT_DEFAULTS.maxLogBytes),
}).strict();
type FaultStep = "log-write" | "receipt-write" | "file-sync" | "publish" | "root-sync";
export interface ExecutionObservation {
 startedAt: number; log: Uint8Array; truncated: boolean;
 outputState: "captured" | "unavailable" | "skipped";
 resources: ResourceObservation;
}
export interface ArtifactOptions {
 retentionMs?: number; maxArtifactBytes?: number; maxLogBytes?: number;
 now?: () => number;
 /** Test seam for interrupted writes and unsupported durability operations. */
 fault?: (step: FaultStep) => void | Promise<void>;
}
const jobName = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** CLI export uses a complete synced temporary file and an exclusive atomic
 * link. The destination is never an empty reservation or partial JSON file. */
export async function publishReceiptFile(path: string, input: RemoteTestReceipt, fault?: ArtifactOptions["fault"]): Promise<void> {
 const receipt = validateRemoteTestReceipt(input, input.identity);
 const destination = await privateOperatorPath(path);
 const temporary = join(dirname(destination), `.pending-receipt-${randomUUID()}`);
 let published = false;
 try {
  const file = await open(temporary, "wx", 0o600);
  try { await fault?.("receipt-write"); await file.writeFile(JSON.stringify(receipt) + "\n"); await fault?.("file-sync"); await file.sync(); }
  finally { await file.close(); }
  await fault?.("publish"); await link(temporary, destination); published = true;
  await fault?.("root-sync"); await syncDirectory(dirname(destination));
 } catch (e) {
  if (published) { await rm(destination); await syncDirectory(dirname(destination)); }
  throw e;
 } finally { await rm(temporary, { force: true }); }
}
async function syncDirectory(path: string) {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try { await file.sync(); } finally { await file.close(); }
}
async function privateDirectory(path: string) {
 const info = await lstat(path);
 if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error("Artifact directory must be private and operator-owned");
}
async function size(path: string): Promise<number> {
 const info = await lstat(path);
 if (info.isFile()) return info.size;
 if (!info.isDirectory()) throw Error("Unsupported artifact entry");
 let bytes = 0;
 for (const name of await readdir(path)) bytes += await size(join(path, name));
 if (!Number.isSafeInteger(bytes)) throw Error("Artifact accounting overflow");
 return bytes;
}
async function readReceipt(path: string): Promise<RemoteTestReceipt> {
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const info = await file.stat();
  if (!info.isFile() || info.size > 65_536) throw Error("Invalid stored receipt");
  const value = JSON.parse(await file.readFile("utf8"));
  return validateRemoteTestReceipt(value, value.identity);
 } finally { await file.close(); }
}

/** One private store, serialized publication/GC, immutable UUID directories.
 * Only validated terminal directories are evictable. Unknown/pending state is
 * counted but never reclaimed automatically. No live workspace is traversed.
 * File fsync + directory rename + parent fsync is the durability boundary.
 * A storage failure throws; it cannot be converted into a passed execution. */
export async function persistExecution(rootPath: string, input: RemoteTestReceipt, observation: ExecutionObservation, options: ArtifactOptions = {}): Promise<RemoteTestReceipt> {
 const policy = ArtifactPolicySchema.parse({ retentionMs: options.retentionMs, maxArtifactBytes: options.maxArtifactBytes, maxLogBytes: options.maxLogBytes });
 const now = (options.now ?? Date.now)();
 if (!Number.isSafeInteger(now) || now <= 0) throw Error("Invalid artifact clock");
 const original = validateRemoteTestReceipt(input, input.identity);
 const bytes = Buffer.from(observation.log.subarray(0, policy.maxLogBytes));
 const receipt = validateRemoteTestReceipt({ ...original, evidence: {
  startedAt: observation.startedAt, durationMs: original.completedAt - observation.startedAt,
  resources: observation.resources,
  output: { state: observation.outputState, truncated: observation.truncated || observation.log.byteLength > bytes.length,
   artifact: observation.outputState === "captured" ? { path: "test.log", bytes: bytes.length, checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}` } : null },
 } }, original.identity);
 const json = Buffer.from(JSON.stringify(receipt) + "\n");
 const required = json.length + (observation.outputState === "captured" ? bytes.length : 0);
 if (required > policy.maxArtifactBytes) throw Error("Execution artifacts exceed aggregate cap");
 const root = await privateOperatorPath(rootPath);
 try { await mkdir(root, { mode: 0o700 }); await syncDirectory(dirname(root)); }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 await privateDirectory(root);
 const lock = join(root, ".store-lock");
 await mkdir(lock, { mode: 0o700 }); // Busy or stale locks fail closed, never steal.
 const destination = join(root, receipt.identity.jobId);
 let pending: string | undefined, published = false;
 try {
  try { await lstat(destination); throw Error("Execution receipt already exists"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  let total = 0;
  const completed: { path: string; bytes: number; time: number }[] = [];
  for (const name of await readdir(root)) {
   if (name === ".store-lock") continue;
   const path = join(root, name), bytes = await size(path);
   total += bytes;
   if (jobName.test(name)) {
    await privateDirectory(path);
    const r = await readReceipt(join(path, "receipt.json"));
    if (r.identity.jobId !== name || !r.evidence) throw Error("Invalid terminal artifact identity");
    completed.push({ path, bytes, time: r.completedAt });
   }
  }
  if (!Number.isSafeInteger(total)) throw Error("Artifact accounting overflow");
  // Age cleanup is independent of incoming publication. Capacity pressure must
  // not destroy still-retained evidence to make room for a write that may fail.
  for (const old of completed) {
   if (now - old.time >= policy.retentionMs) {
    await rm(old.path, { recursive: true }); total -= old.bytes;
   }
  }
  if (total + required > policy.maxArtifactBytes) throw Error("Retained or active artifacts exhaust store capacity");
  pending = join(root, `.pending-${receipt.identity.jobId}-${randomUUID()}`);
  await mkdir(pending, { mode: 0o700 });
  const write = async (name: string, content: Uint8Array, step: FaultStep) => {
   const file = await open(join(pending!, name), "wx", 0o600);
   try { await options.fault?.(step); await file.writeFile(content); await options.fault?.("file-sync"); await file.sync(); }
   finally { await file.close(); }
  };
  if (observation.outputState === "captured") await write("test.log", bytes, "log-write");
  await write("receipt.json", json, "receipt-write");
  await syncDirectory(pending);
  await options.fault?.("publish");
  await rename(pending, destination); published = true;
  await options.fault?.("root-sync"); await syncDirectory(root);
  return receipt;
 } catch (error) {
  if (published) { await rm(destination, { recursive: true }); await syncDirectory(root); }
  throw error;
 } finally {
  if (pending && !published) await rm(pending, { recursive: true, force: true });
  await rm(lock, { recursive: true });
 }
}
