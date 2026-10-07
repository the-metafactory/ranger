import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { runCmd } from "../exec.ts";

export type SourceErrorCode = "invalid_input" | "dirty_source" | "unsupported_source" |
 "digest_mismatch" | "identity_mismatch" | "invalid_bundle" | "path_conflict" | "source_io";
export class SourceError extends Error {
 override readonly name = "SourceError";
 constructor(readonly code: SourceErrorCode, message: string) { super(message); }
}
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const job = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const path = z.string().min(1).refine(s => isAbsolute(s) && !s.includes("\0") && !s.split("/").includes(".."));
const manifestSchema = z.object({
 version: z.literal(1), commitDigest: objectId, treeDigest: objectId,
 bundleDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().refine(m => m.commitDigest.length === m.treeDigest.length);
export type SourceManifest = z.infer<typeof manifestSchema>;
const stageSchema = z.object({ worktree: path, stagingRoot: path, jobId: job, commitDigest: objectId.optional() }).strict();
const restoreSchema = z.object({ bundlePath: path, jobsRoot: path, jobId: job, manifest: manifestSchema }).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
 const result = schema.safeParse(input);
 if (!result.success) throw new SourceError("invalid_input", "Invalid source request");
 return result.data;
}
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
 try { return await fn(); }
 catch (e) {
  if (e instanceof SourceError) throw e;
  throw new SourceError("source_io", "Source filesystem or Git operation failed");
 }
}
// Inherit no GIT_* variables, global configuration, hooks, replacement objects,
// credentials or caller-supplied config injection. Source paths are absolute;
// all caller revisions are full hex IDs and every invocation is argv-based.
async function git(cwd: string, args: string[], error: SourceErrorCode = "source_io", allowed = [0]) {
 const r = await runCmd("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", ...args], {
  cwd, env: {
   PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
   GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
   GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
  }, timeoutMs: 120_000, processGroup: true,
 });
 if (!allowed.includes(r.code)) throw new SourceError(error, "Git source verification failed");
 return r.stdout;
}
async function clean(worktree: string) {
 const flags = (await git(worktree, ["ls-files", "-v", "-z"])).split("\0").filter(Boolean);
 if (flags.some(f => f[0] !== "H") ||
  await git(worktree, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])) {
  throw new SourceError("dirty_source", "Source must be clean, without untracked files or hidden index entries");
 }
}
async function supported(repo: string, commit: string) {
 const entries = (await git(repo, ["ls-tree", "-r", "-z", commit])).split("\0").filter(Boolean);
 if (entries.some(e => e.startsWith("160000 "))) throw new SourceError("unsupported_source", "Submodules are unsupported in V1 source");
 // Inspect committed attributes, including nested ones; never run a smudge
 // filter or assume that a checked-out LFS payload is part of the Git bundle.
 for (const entry of entries) {
  const tab = entry.indexOf("\t"), meta = entry.slice(0, tab), name = entry.slice(tab + 1);
  if (name === ".gitattributes" || name?.endsWith("/.gitattributes")) {
   const oid = meta.split(" ")[2]!;
   const attributes = await git(repo, ["cat-file", "blob", oid]);
   if (/(?:^|\s)filter\s*=\s*lfs(?:\s|$)/m.test(attributes)) throw new SourceError("unsupported_source", "LFS attributes are unsupported in V1 source");
  }
 }
 const pointers = await git(repo, ["grep", "-I", "-l", "-e", "^version https://git-lfs.github.com/spec/v1$", commit, "--"], "source_io", [0, 1]);
 if (pointers) throw new SourceError("unsupported_source", "LFS pointers are unsupported in V1 source");
}
async function allocate(root: string, id: string) {
 const canonical = await realpath(root);
 const directory = join(canonical, id); // id is one validated UUID component.
 try { await mkdir(directory, { mode: 0o700 }); }
 catch (e) {
  if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new SourceError("path_conflict", "Source job path already exists");
  throw e;
 }
 return directory;
}
// Digest the exact bytes read once from a regular, non-symlink file. On restore,
// those same bytes go to the exclusively owned snapshot Git will consume.
async function digest(file: string, snapshot?: string) {
 const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  if (!(await input.stat()).isFile()) throw new SourceError("invalid_input", "Bundle must be a regular file");
  const output = snapshot ? await open(snapshot, "wx", 0o600) : undefined;
  try {
   const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
   for (;;) {
    const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
    if (output) await output.writeFile(chunk);
   }
   return `sha256:${hash.digest("hex")}`;
  } finally { await output?.close(); }
 } finally { await input.close(); }
}

/** Operator-owned roots must already exist and be exclusive to this service;
 * callers must not concurrently mutate the source worktree. Ignored files are
 * not source material. V1 stages only the current clean HEAD, with full ancestry,
 * never dirty snapshots, remote fetches or source repository ref mutations. */
export async function stageSource(input: { worktree: string; stagingRoot: string; jobId: string; commitDigest?: string }) {
 const request = parse(stageSchema, input);
 return guarded(async () => {
  const repo = await realpath(request.worktree);
  if ((await git(repo, ["rev-parse", "--is-shallow-repository"])).trim() !== "false") throw new SourceError("unsupported_source", "Source requires full commit ancestry");
  const commitDigest = (await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (request.commitDigest && request.commitDigest !== commitDigest) throw new SourceError("identity_mismatch", "Requested source must equal HEAD");
  const treeDigest = (await git(repo, ["rev-parse", "--verify", `${commitDigest}^{tree}`])).trim();
  await supported(repo, commitDigest);
  await clean(repo);
  const directory = await allocate(request.stagingRoot, request.jobId);
  try {
   const bundlePath = join(directory, "source.bundle"), manifestPath = join(directory, "manifest.json");
   await git(repo, ["bundle", "create", bundlePath, "HEAD"]);
   const heads = await git(repo, ["bundle", "list-heads", bundlePath]);
   if (heads.trim() !== `${commitDigest} HEAD` || (await git(repo, ["rev-parse", "HEAD"])).trim() !== commitDigest) {
    throw new SourceError("identity_mismatch", "Source HEAD changed during staging");
   }
   await clean(repo);
   const manifest = parse(manifestSchema, { version: 1, commitDigest, treeDigest, bundleDigest: await digest(bundlePath) });
   await writeFile(manifestPath, JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o600 });
   return { manifest, bundlePath, manifestPath };
  } catch (e) { await rm(directory, { recursive: true, force: true }); throw e; }
 });
}

/** Manifest identities must come from the authenticated admitted request, not
 * an untrusted accompanying file. Digest equality proves bytes, not admission.
 * Failure removes only the exclusive job directory this call created. */
export async function restoreSource(input: { bundlePath: string; manifest: unknown; jobsRoot: string; jobId: string }) {
 const request = parse(restoreSchema, input);
 return guarded(async () => {
  const directory = await allocate(request.jobsRoot, request.jobId);
  try {
   const snapshot = join(directory, "source.bundle"), checkoutPath = join(directory, "checkout");
   if (await digest(request.bundlePath, snapshot) !== request.manifest.bundleDigest) throw new SourceError("digest_mismatch", "Bundle digest does not match admitted source");
   await mkdir(checkoutPath, { mode: 0o700 });
   await git(checkoutPath, ["init", "--template=", `--object-format=${request.manifest.commitDigest.length === 64 ? "sha256" : "sha1"}`]);
   await git(checkoutPath, ["bundle", "verify", snapshot], "invalid_bundle");
   await git(checkoutPath, ["bundle", "unbundle", snapshot], "invalid_bundle");
   const commit = request.manifest.commitDigest;
   if ((await git(checkoutPath, ["cat-file", "-t", commit], "invalid_bundle")).trim() !== "commit") throw new SourceError("invalid_bundle", "Requested object is not a commit");
   const tree = (await git(checkoutPath, ["rev-parse", "--verify", `${commit}^{tree}`], "invalid_bundle")).trim();
   if (tree !== request.manifest.treeDigest) throw new SourceError("identity_mismatch", "Requested tree does not match commit");
   await git(checkoutPath, ["fsck", "--strict", "--no-reflogs", commit], "invalid_bundle");
   await supported(checkoutPath, commit);
   await git(checkoutPath, ["checkout", "--detach", commit, "--"], "invalid_bundle");
   await clean(checkoutPath);
   await rm(snapshot);
   return { checkoutPath, manifest: request.manifest };
  } catch (e) { await rm(directory, { recursive: true, force: true }); throw e; }
 });
}
