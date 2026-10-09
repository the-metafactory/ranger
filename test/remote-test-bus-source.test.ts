import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { loadStagedSource, PENDING_MS, STORE_LOCK, StagedSourceRefusal, type StageFaultStep, type StageRefusalCode } from "../src/remote-test/bus-source.ts";
import { ReceiverDiagnosticSchema } from "../src/remote-test/receiver-diagnostics.ts";
import { openJobLedger } from "../src/remote-test/job-ledger.ts";
import { stageCommittedSource, stageSshSource, statusSshRemoteTest, type SshRunner } from "../src/remote-test/ssh-client.ts";
import { SshRequestSchema } from "../src/remote-test/ssh-protocol.ts";
import { serveSshRequest, serveSshResponse, type SshServerOptions } from "../src/remote-test/ssh-server.ts";
import { stageSource } from "../src/remote-test/source.ts";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const sha = (s: string | Uint8Array) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const jobId = "6c7e8091-1234-4234-8234-123456789abc";
const now = 1_800_000_000_000, DAY = 86_400_000;
async function git(cwd: string, ...args: string[]) {
 const r = await runCmd("git", args, { cwd }); if (r.code) throw Error(r.stderr); return r.stdout.trim();
}
async function fixture(artifacts: Record<string, number> = {}) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-bus-source-"))); roots.push(root);
 const repo = join(root, "repo"), staging = join(root, "staging"), jobsRoot = join(root, "jobs"), diagnosticsRoot = join(root, "diagnostics");
 await mkdir(repo); for (const d of [staging, jobsRoot, diagnosticsRoot]) await mkdir(d, { mode: 0o700 });
 await git(repo, "init", "--initial-branch=main"); await git(repo, "config", "user.name", "Stage Test"); await git(repo, "config", "user.email", "stage@example.invalid");
 await writeFile(join(repo, "bun.lock"), "lock\n"); await git(repo, "add", "."); await git(repo, "commit", "-m", "ancestor");
 const ancestorTree = await git(repo, "rev-parse", "HEAD^{tree}");
 await writeFile(join(repo, "hello.txt"), "unpushed\n"); await git(repo, "add", "."); await git(repo, "commit", "-m", "unpushed");
 const profile = { version: 1 as const, profileId: "unit-v1", profileDigest: sha("profile"), lockDigest: sha("lock\n"), imageDigest: sha("image"), platform: "linux-arm64" as const, commands: [["bun", "test"]] as [string, ...string[]][] };
 const config = { executorId: "fixture", jobsRoot, artifacts, profiles: [{ profile, lockFile: "bun.lock", imageReference: `localhost/runtime@${profile.imageDigest}` }] };
 const sshConfig = { target: "disposable-alias", remoteCli: "/reviewed/ranger", remoteConfig: "/private/executor.json", executorId: "fixture", profiles: [profile] };
 const request = { version: 1 as const, jobId, correlationId: jobId, repositoryId: "github:github.com/the-metafactory/ranger", profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest, imageDigest: profile.imageDigest, platform: profile.platform, deadline: now + 30 * DAY, generation: 1 };
 const stage = async (id = jobId) => {
  const staged = await stageSource({ worktree: repo, stagingRoot: staging, jobId: id });
  const bytes = await readFile(staged.bundlePath); await rm(join(staging, id), { recursive: true });
  return { bytes, job: { ...request, jobId: id, ...staged.manifest } };
 };
 const first = await stage();
 let calls = 0;
 const execute: NonNullable<SshServerOptions["execute"]> = async () => { calls++; throw Error("executor must not run"); };
 const frame = (job: unknown, body: Uint8Array, fields: Record<string, unknown> = {}) => (async function* () {
  yield Buffer.from(JSON.stringify({ version: 3, operation: "stage", job, bundleBytes: body.length, ...fields }) + "\n"); yield Buffer.from(body);
 })();
 const store = join(jobsRoot, ".source-store"), object = (digest: string) => join(store, digest.slice(7));
 const entries = async () => (await readdir(store).catch(() => [])).filter(n => !n.startsWith(STORE_LOCK)).sort();
 const leftovers = async () => (await entries()).filter(n => n.startsWith("."));
 return { root, repo, staging, jobsRoot, diagnosticsRoot, ancestorTree, profile, config, sshConfig, request, stage, ...first, execute, frame, store, object, entries, leftovers, calls: () => calls };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function refusal(promise: Promise<unknown>): Promise<StageRefusalCode> {
 try { await promise; } catch (e) { if (e instanceof StagedSourceRefusal) return e.code; throw e; }
 throw Error("Expected a stage refusal");
}
const serve = (f: Fixture, body = f.bytes, job: unknown = f.job, options: SshServerOptions = {}) => serveSshRequest(f.frame(job, body), f.config, { execute: f.execute, now: () => now, ...options });

test("stage stores exact validated bytes under their content address and returns the bound reference without execution", async () => {
 const f = await fixture();
 const response = await serveSshResponse(f.frame(f.job, f.bytes), f.config, { execute: f.execute, now: () => now });
 expect(response).toEqual({ version: 3, staged: { job: f.job, executorId: "fixture", bundleDigest: f.job.bundleDigest, bundleBytes: f.bytes.length } });
 expect("receipt" in response).toBe(false);
 const object = f.object(f.job.bundleDigest);
 expect(await readFile(join(object, "source.bundle"))).toEqual(f.bytes);
 expect(JSON.parse(await readFile(join(object, "reference.json"), "utf8"))).toEqual({ version: 1, bundleDigest: f.job.bundleDigest, bundleBytes: f.bytes.length, storedAt: now });
 expect((await lstat(object)).mode & 0o777).toBe(0o700); expect((await lstat(join(object, "source.bundle"))).mode & 0o777).toBe(0o600);
 expect((await readdir(object)).sort()).toEqual(["reference.json", "source.bundle"]);
 // No executor, no ledger, no inbox and no execution workspace for this job.
 expect(f.calls()).toBe(0);
 expect((await readdir(f.jobsRoot)).sort()).toEqual([".source-store"]);
 expect(await f.leftovers()).toEqual([]);
});

test("restaging the same exact object returns the same reference without replacement", async () => {
 const f = await fixture();
 const first = await serve(f), object = f.object(f.job.bundleDigest);
 const before = await Promise.all(["reference.json", "source.bundle"].map(n => stat(join(object, n))));
 const again = await serve(f, f.bytes, { ...f.job, jobId: "7c7e8091-1234-4234-8234-123456789abc" }, { now: () => now + 1000 });
 if (!("staged" in first) || !("staged" in again)) throw Error("expected staged");
 expect({ ...again.staged, job: undefined }).toEqual({ ...first.staged, job: undefined });
 const after = await Promise.all(["reference.json", "source.bundle"].map(n => stat(join(object, n))));
 expect(after.map(s => [s.ino, s.mtimeMs])).toEqual(before.map(s => [s.ino, s.mtimeMs]));
 expect(JSON.parse(await readFile(join(object, "reference.json"), "utf8")).storedAt).toBe(now);
 expect(await f.leftovers()).toEqual([]); expect(f.calls()).toBe(0);
});

test("staging leaves admitted ledger generation state untouched", async () => {
 const f = await fixture(), ledger = await openJobLedger(f.jobsRoot, f.config.executorId, () => now);
 try {
  const admitted = ledger.admit(f.job); if (admitted.kind !== "admitted") throw Error("expected admission");
  const before = ledger.status(f.job);
  expect("staged" in await serve(f)).toBe(true);
  expect(ledger.status(f.job)).toEqual(before); expect(ledger.allowed(f.job, admitted.token)).toBe(true);
 } finally { ledger.close(); }
 expect(f.calls()).toBe(0);
});

test("truncated, oversized, mismatched, expired and Git-invalid uploads refuse without a staged reference", async () => {
 const f = await fixture();
 const flipped = Buffer.from(f.bytes); flipped[flipped.length - 1]! ^= 1;
 const garbage = Buffer.from("not a git bundle\n");
 const cases: [string, () => AsyncIterable<Uint8Array>, StageRefusalCode][] = [
  ["truncated", () => (async function* () { yield Buffer.from(JSON.stringify({ version: 3, operation: "stage", job: f.job, bundleBytes: f.bytes.length }) + "\n"); yield f.bytes.subarray(1); })(), "upload_size"],
  ["oversized", () => (async function* () { yield Buffer.from(JSON.stringify({ version: 3, operation: "stage", job: f.job, bundleBytes: f.bytes.length }) + "\n"); yield f.bytes; yield Buffer.from("x"); })(), "upload_size"],
  ["digest", () => f.frame(f.job, flipped), "upload_digest"],
  ["expired", () => f.frame({ ...f.job, deadline: now }, f.bytes), "expired"],
  ["tree", () => f.frame({ ...f.job, treeDigest: f.ancestorTree }, f.bytes), "source_invalid"],
  ["garbage", () => f.frame({ ...f.job, bundleDigest: sha(garbage) }, garbage), "source_invalid"],
 ];
 for (const [, input, code] of cases) {
  expect(await refusal(serveSshRequest(input(), f.config, { execute: f.execute, now: () => now }))).toBe(code);
  expect(await serveSshResponse(input(), f.config, { execute: f.execute, now: () => now })).toEqual({ version: 3, error: "receiver_failed" });
 }
 expect((await readdir(f.store).catch(() => [])).filter(n => !n.startsWith("."))).toEqual([]);
 expect(await f.leftovers()).toEqual([]);
 expect(await readdir(f.jobsRoot)).toEqual([".source-store"]); expect(f.calls()).toBe(0);
});

test("a colliding stored object, unsafe store or busy lock refuses and is never replaced", async () => {
 const f = await fixture(), object = f.object(f.job.bundleDigest);
 await mkdir(f.store, { mode: 0o700 }); await mkdir(object, { mode: 0o700 });
 const forged = Buffer.alloc(f.bytes.length, 7);
 await writeFile(join(object, "source.bundle"), forged, { mode: 0o600 });
 await writeFile(join(object, "reference.json"), JSON.stringify({ version: 1, bundleDigest: f.job.bundleDigest, bundleBytes: forged.length, storedAt: now }), { mode: 0o600 });
 expect(await refusal(serve(f))).toBe("stage_conflict");
 expect(await readFile(join(object, "source.bundle"))).toEqual(forged);
 // An empty directory would be silently replaced by rename; it must refuse instead.
 await rm(object, { recursive: true }); await mkdir(object, { mode: 0o700 });
 expect(await refusal(serve(f))).toBe("stage_conflict");
 await rm(object, { recursive: true });
 // A lock file another user could open or swap is unsafe, never used.
 await chmod(join(f.store, STORE_LOCK), 0o644);
 expect(await refusal(serve(f))).toBe("unsafe_path");
 await chmod(join(f.store, STORE_LOCK), 0o600); await chmod(f.store, 0o755);
 expect(await refusal(serve(f))).toBe("unsafe_path");
 await rm(f.store, { recursive: true }); await mkdir(join(f.root, "elsewhere"), { mode: 0o700 }); await symlink(join(f.root, "elsewhere"), f.store);
 expect(await refusal(serve(f))).toBe("unsafe_path");
 expect(await readdir(join(f.root, "elsewhere"))).toEqual([]); expect(f.calls()).toBe(0);
});

test("each durability failure refuses, withdraws publication and leaves no pending state", async () => {
 for (const step of ["bundle-write", "file-sync", "meta-write", "meta-sync", "dir-sync", "publish", "root-sync"] as StageFaultStep[]) {
  const f = await fixture(), seen: StageFaultStep[] = [];
  await expect(serve(f, f.bytes, f.job, { sourceStore: { fault: s => { seen.push(s); if (s === step) throw Error(`fault ${s}`); } } })).rejects.toThrow(`fault ${step}`);
  expect(seen.at(-1)).toBe(step);
  expect(await f.entries()).toEqual([]);
  expect(await serveSshResponse(f.frame(f.job, f.bytes), f.config, { execute: f.execute, now: () => now, sourceStore: { fault: s => { if (s === step) throw Error("fault"); } } })).toEqual({ version: 3, error: "receiver_failed" });
  expect(await f.entries()).toEqual([]);
 }
}, 30_000);

/** A real separate process holds the store lock until it is killed. */
async function holdStoreLock(store: string) {
 const script = `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(join(store, STORE_LOCK))}, { strict: true }); db.exec("PRAGMA busy_timeout=0"); db.exec("BEGIN EXCLUSIVE"); console.log("held"); setInterval(() => {}, 1000);`;
 const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore" });
 const reader = child.stdout.getReader(), { value } = await reader.read(); reader.releaseLock();
 if (!new TextDecoder().decode(value).includes("held")) { child.kill("SIGKILL"); throw Error("Lock holder failed"); }
 return child;
}

test("a live lock holder yields stage_busy; a killed holder's lock and expired uploads never block later stages", async () => {
 const f = await fixture();
 await mkdir(f.store, { mode: 0o700 }); await writeFile(join(f.store, STORE_LOCK), "", { mode: 0o600 });
 const holder = await holdStoreLock(f.store);
 try {
  expect(await refusal(serve(f, f.bytes, f.job, { sourceStore: { lockWaitMs: 0 } }))).toBe("stage_busy");
  expect(await f.entries()).toEqual([]);
  // A waiting stager proceeds once the holder dies mid-critical-section (SIGKILL, no cleanup).
  const waiting = serve(f);
  await Bun.sleep(200); holder.kill("SIGKILL"); await holder.exited;
  expect("staged" in await waiting).toBe(true);
 } finally { holder.kill("SIGKILL"); }
 expect(await f.entries()).toEqual([f.job.bundleDigest.slice(7)]);
 expect(f.calls()).toBe(0);
});

test("seven-day retention reclaims only expired objects; capacity pressure never evicts unexpired ones", async () => {
 const f = await fixture();
 expect("staged" in await serve(f)).toBe(true);
 await writeFile(join(f.repo, "hello.txt"), "second\n"); await git(f.repo, "commit", "-am", "second");
 const second = await f.stage("8c7e8091-1234-4234-8234-123456789abc");
 const capacity = f.bytes.length + second.bytes.length, tight = { ...f.config, artifacts: { maxArtifactBytes: capacity } };
 const at = (job: unknown, bytes: Buffer, time: number) => serveSshRequest(f.frame(job, bytes), tight, { execute: f.execute, now: () => time });
 // Unexpired first object stays; insufficient capacity refuses the second.
 expect(await refusal(at(second.job, second.bytes, now + DAY))).toBe("stage_capacity");
 expect(await f.entries()).toEqual([f.job.bundleDigest.slice(7)]);
 // After the retention window the first object is reclaimed and the second fits.
 expect("staged" in await at(second.job, second.bytes, now + 7 * DAY)).toBe(true);
 expect(await f.entries()).toEqual([second.job.bundleDigest.slice(7)]);
 // Exact room for both objects with their references, and nothing more.
 const referenceBytes = (await stat(join(f.object(second.job.bundleDigest), "reference.json"))).size;
 const roomy = { ...f.config, artifacts: { maxArtifactBytes: capacity + 2 * referenceBytes } };
 const fits = (time: number) => serveSshRequest(f.frame(f.job, f.bytes), roomy, { execute: f.execute, now: () => time });
 // Unknown store entries are counted and kept, never reclaimed.
 await writeFile(join(f.store, ".pending-stale"), Buffer.alloc(f.bytes.length));
 expect(await refusal(fits(now + 8 * DAY))).toBe("stage_capacity");
 expect(await f.entries()).toEqual([".pending-stale", second.job.bundleDigest.slice(7)].sort());
 await rm(join(f.store, ".pending-stale"));
 // A crashed stager's upload is counted until its named expiry, then reclaimed.
 const crashed = join(f.store, `.pending-${now + 9 * DAY}-0b7e8091-1234-4234-8234-123456789abc`);
 await mkdir(crashed, { mode: 0o700 }); await writeFile(join(crashed, "source.bundle"), Buffer.alloc(f.bytes.length), { mode: 0o600 });
 expect(await refusal(fits(now + 9 * DAY - 1))).toBe("stage_capacity");
 expect(await f.entries()).toEqual([crashed.slice(f.store.length + 1), second.job.bundleDigest.slice(7)].sort());
 expect("staged" in await fits(now + 9 * DAY)).toBe(true);
 expect(await f.entries()).toEqual([f.job.bundleDigest.slice(7), second.job.bundleDigest.slice(7)].sort());
 expect(PENDING_MS).toBeGreaterThanOrEqual(2 * 900_000);
 expect(f.calls()).toBe(0);
});

test("loading a staged reference rechecks bytes and restores the exact detached commit; missing, corrupt or expired never becomes source", async () => {
 const f = await fixture();
 expect(await refusal(loadStagedSource({ config: f.config, job: f.job }, { now: () => now }))).toBe("stage_missing");
 await serve(f);
 const restored = await loadStagedSource({ config: f.config, job: f.job }, { now: () => now + 1 });
 expect(await git(restored.checkoutPath, "rev-parse", "HEAD")).toBe(f.job.commitDigest);
 expect(await git(restored.checkoutPath, "rev-parse", "HEAD^{tree}")).toBe(f.job.treeDigest);
 expect((await runCmd("git", ["symbolic-ref", "-q", "HEAD"], { cwd: restored.checkoutPath })).code).not.toBe(0);
 expect(restored.reference).toEqual({ bundleDigest: f.job.bundleDigest, bundleBytes: f.bytes.length });
 expect(await stat(join(f.jobsRoot, ".execution")).catch(() => null)).toBeNull();
 await rm(join(f.jobsRoot, jobId), { recursive: true });
 expect(await refusal(loadStagedSource({ config: f.config, job: f.job }, { now: () => now + 7 * DAY }))).toBe("expired");
 const bundle = join(f.object(f.job.bundleDigest), "source.bundle"), corrupt = Buffer.from(f.bytes); corrupt[corrupt.length - 1]! ^= 1;
 await writeFile(bundle, corrupt);
 expect(await refusal(loadStagedSource({ config: f.config, job: f.job }, { now: () => now + 1 }))).toBe("stage_conflict");
 await rm(bundle); await symlink(join(f.staging, "elsewhere"), bundle);
 await expect(loadStagedSource({ config: f.config, job: f.job }, { now: () => now + 1 })).rejects.toThrow();
 expect(await stat(join(f.jobsRoot, jobId)).catch(() => null)).toBeNull();
});

test("the stage client reuses stageSource, sends only the V3 stage operation over the fixed SSH argv and verifies the bound reply", async () => {
 const f = await fixture(), calls: { args: string[]; header: unknown; body: Buffer }[] = [];
 // Loopback: the real receiver answers over the injected SSH seam.
 const loopback: SshRunner = async invocation => {
  const chunks: Buffer[] = []; for await (const b of invocation.input) chunks.push(Buffer.from(b));
  const bytes = Buffer.concat(chunks), newline = bytes.indexOf(10);
  calls.push({ args: invocation.args, header: JSON.parse(bytes.subarray(0, newline).toString()), body: bytes.subarray(newline + 1) });
  return { code: 0, stdout: JSON.stringify(await serveSshResponse((async function* () { yield bytes; })(), f.config, { execute: f.execute, now: () => now })) };
 };
 const outcome = await stageCommittedSource({ config: f.sshConfig, request: f.request, worktree: f.repo, stagingRoot: f.staging }, { runner: loopback, now: () => now });
 expect(outcome).toEqual({ status: "staged", job: f.job, executorId: "fixture", source: { bundleDigest: f.job.bundleDigest, bundleBytes: f.bytes.length } });
 expect("receipt" in outcome).toBe(false);
 expect(calls).toHaveLength(1);
 expect(calls[0]!.header).toEqual({ version: 3, operation: "stage", job: f.job, bundleBytes: f.bytes.length });
 expect(calls[0]!.body).toEqual(f.bytes);
 expect(calls[0]!.args).toContain("StrictHostKeyChecking=yes"); expect(calls[0]!.args).toContain("BatchMode=yes");
 expect(calls[0]!.args.at(-1)).toBe("'/reviewed/ranger' 'remote-test' 'serve-stdio' '--config' '/private/executor.json'");
 expect(await readdir(f.staging)).toEqual([]); expect(f.calls()).toBe(0);
 await expect(stageCommittedSource({ config: f.sshConfig, request: { ...f.request, bundleDigest: f.job.bundleDigest }, worktree: f.repo, stagingRoot: f.staging }, { runner: loopback })).rejects.toThrow("derived");
});

test("stage replies that do not bind this job, executor and bundle never yield a reference", async () => {
 const f = await fixture(), path = join(f.staging, "source.bundle"); await writeFile(path, f.bytes);
 const staged = { job: f.job, executorId: "fixture", bundleDigest: f.job.bundleDigest, bundleBytes: f.bytes.length };
 const reply = (stdout: string, code = 0): SshRunner => async ({ input }) => { for await (const _ of input) { /* drain */ } return { code, stdout }; };
 const run = (runner: SshRunner, at = now) => stageSshSource({ config: f.sshConfig, job: f.job, bundlePath: path }, { runner, now: () => at });
 expect((await run(reply(JSON.stringify({ version: 3, staged })))).status).toBe("staged");
 for (const bad of [
  { version: 3, staged: { ...staged, executorId: "other" } },
  { version: 3, staged: { ...staged, bundleBytes: f.bytes.length + 1 } },
  { version: 3, staged: { ...staged, bundleDigest: sha("other") } },
  { version: 3, staged: { ...staged, job: { ...f.job, generation: 2 } } },
  { version: 3, staged: { ...staged, path: "/tmp/x" } },
  { version: 2, receipt: null },
 ]) expect(await run(reply(JSON.stringify(bad)))).toEqual({ status: "uncertain", reason: "invalid_response" });
 expect(await run(reply(JSON.stringify({ version: 3, error: "receiver_failed" })))).toEqual({ status: "refused", reason: "receiver_failed" });
 // Lost or nonzero transport is uncertain, never a refusal: the peer may hold the object.
 expect(await run(reply(JSON.stringify({ version: 3, staged }), 255))).toEqual({ status: "uncertain", reason: "no_response" });
 expect(await run(async () => { throw Error("lost"); })).toEqual({ status: "uncertain", reason: "no_response" });
 expect(await run(reply(JSON.stringify({ version: 3, staged })), f.job.deadline)).toEqual({ status: "refused", reason: "expired_job" });
 // A legacy status client never accepts a stage reply as a receipt.
 expect(await statusSshRemoteTest({ config: f.sshConfig, job: f.job }, { runner: reply(JSON.stringify({ version: 3, staged })), now: () => now })).toEqual({ status: "infra_failed", reason: "invalid_receipt" });
});

test("stage is V3-only and V3 carries only stage; refusals record a private stage diagnostic", async () => {
 const f = await fixture();
 for (const version of [1, 2]) expect(SshRequestSchema.safeParse({ version, operation: "stage", job: {}, bundleBytes: 1 }).success).toBe(false);
 expect(SshRequestSchema.safeParse({ version: 3, operation: "submit", job: {}, bundleBytes: 1 }).success).toBe(false);
 expect(SshRequestSchema.safeParse({ version: 3, operation: "status", job: {} }).success).toBe(false);
 expect(await serveSshResponse(f.frame(f.job, f.bytes, { version: 2 }), f.config, { execute: f.execute, now: () => now })).toEqual({ version: 1, error: "receiver_failed" });
 expect(await serveSshResponse(f.frame(f.job, f.bytes, { operation: "submit" }), f.config, { execute: f.execute, now: () => now })).toEqual({ version: 1, error: "receiver_failed" });
 const flipped = Buffer.from(f.bytes); flipped[0]! ^= 1;
 expect(await serveSshResponse(f.frame(f.job, flipped), f.config, { execute: f.execute, now: () => now, diagnostics: { root: f.diagnosticsRoot } })).toEqual({ version: 3, error: "receiver_failed" });
 const [name] = (await readdir(f.diagnosticsRoot)).filter(n => n.endsWith(".json"));
 const record = ReceiverDiagnosticSchema.parse(JSON.parse(await readFile(join(f.diagnosticsRoot, name!), "utf8")));
 expect(record).toMatchObject({ operation: "stage", job: { jobId, generation: 1 }, primary: { stage: "upload", code: "upload_digest" } });
 expect(f.calls()).toBe(0);
});
