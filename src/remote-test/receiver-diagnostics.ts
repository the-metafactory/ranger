import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

export const DIAGNOSTIC_LIMITS = { recordBytes: 1024, fileBytes: 4 * 1024 ** 2, entries: 4096, retentionMs: 7 * 86400_000 } as const;
// Persisted record-version-1 stages are append-only too. Tightening pairs needs a new version.
const stages = ["config", "root", "header", "request", "lookup", "upload", "executor_boundary", "receipt", "cleanup", "source_store"] as const;
// Persisted record-version-1 vocabulary: append only; never remove or rename codes.
const codes = ["invalid_config", "unsafe_path", "incomplete_header", "header_limit", "malformed_request", "profile_not_approved", "job_invalid", "expired", "unexpected_payload", "upload_size", "upload_digest", "upload_no_progress", "interrupted", "invalid_receipt", "unknown", "EACCES", "EPERM", "ENOENT", "EEXIST", "ENOSPC", "EDQUOT", "EIO", "EROFS", "EMFILE", "ENFILE", "source_invalid", "stage_conflict", "stage_capacity", "stage_missing", "stage_busy"] as const;
export type DiagnosticStage = typeof stages[number];
export type DiagnosticCode = typeof codes[number];
const failureSchema = z.object({ stage: z.enum(stages), code: z.enum(codes) }).strict();
export type DiagnosticFailure = z.infer<typeof failureSchema>;
// `operation` is the request's wire operation ("stage" = V3 source storage);
// `stage` in a failure is the receiver phase that failed (e.g. "upload").
export const ReceiverDiagnosticSchema = z.object({
 version: z.literal(1), id: z.string().uuid(), time: z.number().int().positive().safe(),
 operation: z.enum(["submit", "status", "stage"]).nullable(),
 job: z.object({ jobId: z.string().uuid(), generation: z.number().int().positive().safe() }).strict().nullable(),
 primary: failureSchema, cleanup: failureSchema.optional(),
}).strict();
export type ReceiverDiagnostic = z.infer<typeof ReceiverDiagnosticSchema>;
export type RefusalDiagnostic = Omit<ReceiverDiagnostic, "version" | "id" | "time">;

/** Only operator configuration supplies this exclusion. A partially invalid
 * config can still name a syntactically valid jobs root; do not skip separation
 * just because a different config field failed validation. */
export function diagnosticJobsRoot(config: unknown): string | undefined {
 if (!config || typeof config !== "object") return;
 let path: unknown;
 try { path = Object.getOwnPropertyDescriptor(config, "jobsRoot")?.value; } catch { return; }
 if (typeof path === "string" && isAbsolute(path) && !/[\0,:\n]/.test(path) && !path.split(sep).includes("..")) return path;
}

/** Only explicit local tags and exact errno data properties are diagnostic
 * input. Never examine messages, stacks, causes or arbitrary string values. */
export class TaggedReceiverFailure extends Error {
 constructor(readonly code: DiagnosticCode, message: string) { super(message); }
}
const errno = new Set<string>(codes.filter(c => c.startsWith("E")));
export function classifyReceiverFailure(error: unknown, stage: DiagnosticStage): DiagnosticFailure {
 if (error instanceof TaggedReceiverFailure) return { stage, code: error.code };
 // Avoid custom getters as well as secret-bearing custom errno strings.
 let code: unknown;
 try { code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined; } catch { /* Opaque errors stay unknown. */ }
 return { stage, code: typeof code === "string" && errno.has(code) ? code as DiagnosticCode : "unknown" };
}

export interface DiagnosticStoreOptions {
 /** Narrow deterministic filesystem seam; production uses node fs only. */
 fs?: Partial<Pick<typeof fs, "lstat" | "realpath" | "open" | "opendir" | "mkdir" | "link" | "unlink" | "rmdir">>;
 now?: () => number;
 id?: () => string;
}
export interface ReceiverDiagnostics {
 root: string;
 store?: DiagnosticStoreOptions;
 /** Fixed warning only; no diagnostic or exception data. */
 unavailable?: () => void;
}
const unavailable = () => { process.stderr.write("ranger remote-test: private diagnostic unavailable.\n"); };
export async function saveRefusalDiagnostic(options: ReceiverDiagnostics | undefined, input: RefusalDiagnostic, jobsRoot?: string): Promise<void> {
 if (!options) return;
 try { await persistReceiverDiagnostic(options.root, input, jobsRoot ? [jobsRoot] : [], options.store); }
 catch { try { (options.unavailable ?? unavailable)(); } catch { /* Warning failure cannot replace the original refusal. */ } }
}

/** Existing root only, no symlink components, no other-identity writable
 * ancestors (except sticky tmp), no git ancestor, no overlap with job state. */
export async function persistReceiverDiagnostic(rootPath: string, input: RefusalDiagnostic, excluded: string[] = [], options: DiagnosticStoreOptions = {}): Promise<void> {
 const io = { ...fs, ...options.fs }, uid = process.getuid?.();
 if (uid === undefined || !isAbsolute(rootPath) || rootPath.includes("\0") || rootPath.split(sep).includes("..")) throw Error("Unsafe diagnostic root");
 let root = resolve(rootPath);
 let childUid: number | undefined;
 for (let path = root;; path = dirname(path)) {
  const s = await io.lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink()) throw Error("Unsafe diagnostic path");
  const stickyTmp = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"].includes(path) && (s.mode & 0o1000) !== 0 && childUid === uid;
  if (path === root ? s.uid !== uid || (s.mode & 0o7777) !== 0o700 : (s.mode & 0o022) !== 0 && !stickyTmp) throw Error("Unsafe diagnostic permissions");
  childUid = s.uid;
  const exists = async (name: string) => {
   try { await io.lstat(join(path, name)); return true; }
   catch (error) { if (classifyReceiverFailure(error, "root").code !== "ENOENT") throw error; return false; }
  };
  // Linked worktrees use a .git file; bare repositories have no .git entry.
  if (await exists(".git") || await exists("HEAD") && await exists("objects") && await exists("refs")) throw Error("Diagnostic root inside git");
  if (dirname(path) === path) break;
 }
 // Compare canonical spellings after rejecting every symlink component.
 root = await io.realpath(root);
 for (const path of excluded) {
  let other = resolve(path);
  try { other = await io.realpath(other); }
  catch (error) { if (classifyReceiverFailure(error, "root").code !== "ENOENT") throw error; }
  if (root === other || root.startsWith(other + sep) || other.startsWith(root + sep)) throw Error("Overlapping diagnostic root");
 }
 const record = ReceiverDiagnosticSchema.parse({ ...input, version: 1, id: (options.id ?? randomUUID)(), time: (options.now ?? Date.now)() });
 const content = Buffer.from(JSON.stringify(record) + "\n");
 if (content.length > DIAGNOSTIC_LIMITS.recordBytes) throw Error("Diagnostic record limit");
 const lock = join(root, ".diagnostic-lock");
 await io.mkdir(lock, { mode: 0o700 }); // One attempt. Never wait, repair or steal.
 let pending: string | undefined, owned = false, published = false;
 const syncRoot = async () => { const f = await io.open(root, constants.O_RDONLY | constants.O_NOFOLLOW); try { await f.sync(); } finally { await f.close(); } };
 const safeFile = async (path: string) => {
  const s = await io.lstat(path);
  if (!s.isFile() || s.uid !== uid || (s.mode & 0o7777) !== 0o600 || s.nlink !== 1) throw Error("Unsafe diagnostic entry");
  const f = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
   const current = await f.stat();
   if (!current.isFile() || current.uid !== uid || (current.mode & 0o7777) !== 0o600 || current.nlink !== 1 || current.ino !== s.ino || current.dev !== s.dev || current.size !== s.size) throw Error("Changed diagnostic entry");
   return { size: current.size, text: current.size <= DIAGNOSTIC_LIMITS.recordBytes ? await f.readFile("utf8") : null };
  } finally { await f.close(); }
 };
 try {
  const directory = await io.opendir(root);
  let count = 0, bytes = 0;
  const expired: { path: string; bytes: number }[] = [];
  // Streaming enumeration bounds both work and retained memory. Unknown files
  // and pending files count, but only strict published records can expire.
  try {
   for (;;) {
    const entry = await directory.read(); if (!entry) break;
    if (entry.name === ".diagnostic-lock") continue;
    if (++count > DIAGNOSTIC_LIMITS.entries) throw Error("Diagnostic entry limit");
    const path = join(root, entry.name), file = await safeFile(path); bytes += file.size;
    if (!Number.isSafeInteger(bytes)) throw Error("Diagnostic accounting overflow");
    if (file.text !== null) {
     let old: ReceiverDiagnostic | undefined;
     try { old = ReceiverDiagnosticSchema.parse(JSON.parse(file.text)); } catch { /* Retain malformed evidence. */ }
     if (old && entry.name === `${old.id}.json` && record.time - old.time > DIAGNOSTIC_LIMITS.retentionMs) expired.push({ path, bytes: file.size });
    }
   }
  } finally { await directory.close(); }
  for (const old of expired) { await io.unlink(old.path); bytes -= old.bytes; count--; }
  if (expired.length) await syncRoot();
  // Reserve both temporary and proposed publication during exclusive linking.
  if (count + 2 > DIAGNOSTIC_LIMITS.entries || bytes + content.length * 2 > DIAGNOSTIC_LIMITS.fileBytes) throw Error("Diagnostic capacity limit");
  pending = join(root, `.pending-${record.id}`);
  const f = await io.open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); owned = true;
  try {
   const s = await f.stat(); if (!s.isFile() || s.uid !== uid || (s.mode & 0o7777) !== 0o600 || s.nlink !== 1) throw Error("Unsafe pending diagnostic");
   await f.writeFile(content); await f.sync();
  } finally { await f.close(); }
  await io.link(pending, join(root, `${record.id}.json`)); published = true;
  await io.unlink(pending); owned = false;
  await syncRoot();
 } finally {
  // Once publication is uncertain keep evidence. Never delete a published
  // record, and never clean a pre-existing file we did not create.
  try { if (pending && owned && !published) await io.unlink(pending); }
  finally { await io.rmdir(lock); }
 }
}
