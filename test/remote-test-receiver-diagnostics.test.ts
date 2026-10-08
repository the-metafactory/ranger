import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIAGNOSTIC_LIMITS, ReceiverDiagnosticSchema, classifyReceiverFailure, persistReceiverDiagnostic, type DiagnosticCode, type DiagnosticStage, type DiagnosticFailure, type DiagnosticStoreOptions, type ReceiverDiagnostic, type RefusalDiagnostic } from "../src/remote-test/receiver-diagnostics.ts";
import { serveSshResponse, type SshServerOptions } from "../src/remote-test/ssh-server.ts";
import { validateRemoteTestReceipt } from "../src/remote-test/contract.ts";
import { BusyRemoteTestExecutor, openJobLedger } from "../src/remote-test/job-ledger.ts";

const secret = "SECRET_DIAGNOSTIC_CANARY_NEVER_RECORD";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const refusal: RefusalDiagnostic = { operation: null, job: null, primary: { stage: "header", code: "incomplete_header" } };
async function fixture() {
 const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "ranger-private-diagnostics-"))); roots.push(root);
 const diagnosticsRoot = join(root, "diagnostics"), jobsRoot = join(root, "jobs");
 await fs.mkdir(diagnosticsRoot, { mode: 0o700 }); await fs.mkdir(jobsRoot, { mode: 0o700 });
 const profile = { version: 1 as const, profileId: "unit-v1", profileDigest: sha("profile"), lockDigest: sha("lock"), imageDigest: sha("image"), platform: "linux-arm64" as const, commands: [["bun", "test"]] as [string, ...string[]][] };
 const job = { version: 1 as const, jobId: randomUUID(), correlationId: randomUUID(), repositoryId: "github:github.com/the-metafactory/ranger", commitDigest: "a".repeat(40), treeDigest: "b".repeat(40), bundleDigest: sha("bundle"), profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest, imageDigest: profile.imageDigest, platform: profile.platform, deadline: Date.now() + 60_000, generation: 1 };
 const config = { executorId: "fixture", jobsRoot, profiles: [{ profile, lockFile: "bun.lock", imageReference: `localhost/runtime@${profile.imageDigest}` }] };
 const receipt = validateRemoteTestReceipt({ version: 1, identity: job, executorId: "fixture", status: "passed", completedAt: Date.now(), exitCode: 0 }, job);
 const frame = (operation = "submit", body = "bundle", fields = {}) => raw(JSON.stringify({ version: 2, operation, job, ...(operation === "submit" ? { bundleBytes: 6 } : {}), ...fields }) + "\n" + body);
 let calls = 0, warnings = 0;
 const execute: NonNullable<SshServerOptions["execute"]> = async () => { calls++; return receipt; };
 const options: SshServerOptions = { execute, diagnostics: { root: diagnosticsRoot, unavailable: () => { warnings++; } } };
 const records = async () => Promise.all((await fs.readdir(diagnosticsRoot)).filter(n => n.endsWith(".json")).map(async name => {
  const path = join(diagnosticsRoot, name), text = await fs.readFile(path, "utf8"), info = await fs.lstat(path);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024); expect(text).not.toContain(secret);
  expect(info.mode & 0o7777).toBe(0o600); expect(info.uid).toBe(process.getuid!()); expect(info.nlink).toBe(1);
  const record = ReceiverDiagnosticSchema.parse(JSON.parse(text)); expect(name).toBe(`${record.id}.json`); return record;
 }));
 return { root, diagnosticsRoot, jobsRoot, job, config, receipt, frame, options, records, calls: () => calls, warnings: () => warnings };
}
function raw(s: string) { return (async function* () { yield Buffer.from(s); })(); }
const injectedError = (code = secret) => Object.assign(new Error(secret, { cause: { secret } }), { code, stack: secret, private: secret });
async function cli(f: Awaited<ReturnType<typeof fixture>>, input: string, args: string[] = [], config: unknown = f.config, env: Record<string, string> = {}) {
 const configPath = join(f.root, "executor.json"); await fs.writeFile(configPath, typeof config === "string" ? config : JSON.stringify(config), { mode: 0o600 });
 const child = Bun.spawn([process.execPath, "src/cli.ts", "remote-test", "serve-stdio", "--config", configPath, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
 child.stdin.write(input); child.stdin.end();
 const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 expect(stdout + stderr).not.toContain(secret); return { code, stdout, stderr };
}

test("real CLI config load failure stays generic/nonzero; optional independent root records it privately", async () => {
 const f = await fixture();
 const off = await cli(f, "", [], `{${secret}`); expect(off.code).toBe(1); expect(off.stdout).toBe(""); expect(off.stderr).toContain("inspect private operator state"); expect(await f.records()).toEqual([]);
 const on = await cli(f, "", ["--diagnostics-root", f.diagnosticsRoot], `{${secret}`); expect(on).toEqual(off);
 const [r] = await f.records(); expect(r).toMatchObject({ version: 1, operation: null, job: null, primary: { stage: "config", code: "invalid_config" } });
});
test("real CLI framed V1/V2 refusals retain wire/exit behavior; requests/config/env cannot enable or select diagnostics", async () => {
 const f = await fixture();
 for (const version of [1, 2] as const) {
  const request = JSON.stringify({ version, operation: "status", job: f.job }) + "\n" + secret;
  const off = await cli(f, request), on = await cli(f, request, ["--diagnostics-root", f.diagnosticsRoot]);
  expect(on).toEqual(off); expect(on).toEqual({ code: 0, stdout: JSON.stringify({ version, error: "receiver_failed" }) + "\n", stderr: "" });
 }
 expect((await f.records()).length).toBe(2);
 const extra = JSON.stringify({ version: 2, operation: "status", job: { ...f.job, diagnosticsRoot: secret }, diagnosticsRoot: f.diagnosticsRoot }) + "\n";
 await cli(f, extra, [], f.config, { RANGER_DIAGNOSTICS_ROOT: f.diagnosticsRoot });
 await cli(f, "", [], { ...f.config, diagnosticsRoot: f.diagnosticsRoot });
 expect((await f.records()).length).toBe(2);
 const missing = await cli(f, "", ["--diagnostics-root", join(f.root, "missing")]);
 expect(missing.stdout).toBe('{"version":1,"error":"receiver_failed"}\n'); expect(missing.code).toBe(0);
 expect(missing.stderr).toBe("ranger remote-test: private diagnostic unavailable.\n");
});
test("bounded pre-delegation faults carry typed tags and only fully validated job identity; no admission/retry", async () => {
 const cases: [DiagnosticStage, DiagnosticCode, (f: Awaited<ReturnType<typeof fixture>>) => AsyncIterable<Uint8Array>][] = [
  ["header", "incomplete_header", () => raw(secret)],
  ["header", "header_limit", () => raw("x".repeat(65_537))],
  ["request", "malformed_request", () => raw(secret + "\n")],
  ["request", "profile_not_approved", f => f.frame("submit", "bundle", { job: { ...f.job, profileId: secret } })],
  ["request", "job_invalid", f => f.frame("submit", "bundle", { job: { ...f.job, generation: secret } })],
  ["request", "expired", f => { f.job.deadline = Date.now() - 1; return f.frame(); }],
  ["request", "unexpected_payload", f => f.frame("status", secret)],
  ["upload", "upload_size", f => f.frame("submit", "bundl")],
  ["upload", "upload_size", f => f.frame("submit", "bundle!")],
  ["upload", "upload_digest", f => f.frame("submit", "secret")],
 ];
 for (const [stage, code, request] of cases) {
  const f = await fixture(); expect(await serveSshResponse(request(f), f.config, f.options)).toEqual({ version: stage === "header" || code === "malformed_request" ? 1 : 2, error: "receiver_failed" });
  const [r] = await f.records(); expect(r.primary).toEqual({ stage, code }); expect((await f.records()).length).toBe(1);
  expect(r.job).toEqual(stage === "header" || ["malformed_request", "profile_not_approved", "job_invalid"].includes(code) ? null : { jobId: f.job.jobId, generation: 1 });
  expect(f.calls()).toBe(0); expect(f.warnings()).toBe(0);
  const ledger = await openJobLedger(f.jobsRoot, f.config.executorId); try { expect(ledger.status(f.job)).toBeNull(); } finally { ledger.close(); }
  expect(await fs.lstat(join(f.jobsRoot, ".ssh-incoming", f.job.jobId)).catch(() => null)).toBeNull();
 }
});
test("config/root/occupied upload/readback refusals classify without traversing or removing unknown state", async () => {
 const f = await fixture();
 expect(await serveSshResponse(f.frame(), { ...f.config, executorId: secret + " " }, f.options)).toEqual({ version: 1, error: "receiver_failed" });
 await fs.chmod(f.jobsRoot, 0o755);
 expect(await serveSshResponse(f.frame(), f.config, f.options)).toEqual({ version: 1, error: "receiver_failed" });
 await fs.chmod(f.jobsRoot, 0o700);
 const inbox = join(f.jobsRoot, ".ssh-incoming"), occupied = join(inbox, f.job.jobId);
 await fs.mkdir(inbox, { mode: 0o700 }); await fs.mkdir(occupied, { mode: 0o700 }); await fs.writeFile(join(occupied, "unknown"), secret, { mode: 0o600 });
 expect(await serveSshResponse(f.frame(), f.config, f.options)).toEqual({ version: 2, error: "receiver_failed" }); expect(await fs.readFile(join(occupied, "unknown"), "utf8")).toBe(secret);
 const store = join(f.jobsRoot, ".artifacts"), dir = join(store, f.job.jobId);
 await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.writeFile(join(dir, "receipt.json"), secret, { mode: 0o600 });
 expect(await serveSshResponse(f.frame("status", ""), f.config, f.options)).toEqual({ version: 2, error: "invalid_receipt" });
 expect((await f.records()).map(r => r.primary).sort((a,b) => a.stage.localeCompare(b.stage))).toEqual(([{ stage: "config", code: "invalid_config" }, { stage: "root", code: "unsafe_path" }, { stage: "upload", code: "EEXIST" }, { stage: "lookup", code: "invalid_receipt" }] satisfies DiagnosticFailure[]).sort((a,b) => a.stage.localeCompare(b.stage)));
 expect(f.calls()).toBe(0);
});
test("upload no-progress, expiry and interruption clean owned upload and do not delegate", async () => {
 for (const fault of ["no-progress", "expired", "interrupted"] as const) {
  const f = await fixture(), abort = new AbortController();
  const input = (async function* () {
   yield Buffer.from(JSON.stringify({ version: 2, operation: "submit", job: f.job, bundleBytes: 6 }) + "\n");
   if (fault === "interrupted") abort.abort(); yield Buffer.from("bundle");
  })();
  let clockCalls = 0;
  const now = () => fault === "expired" && clockCalls++ > 0 ? f.job.deadline : f.job.deadline - 1;
  const open: typeof fs.open = async (...args) => {
   const file = await fs.open(...args); if (fault === "no-progress") file.write = (async (buffer: Uint8Array) => ({ bytesWritten: 0, buffer })) as typeof file.write; return file;
  };
  expect(await serveSshResponse(input, f.config, { ...f.options, signal: abort.signal, fs: { open }, now })).toEqual({ version: 2, error: "receiver_failed" });
  expect((await f.records())[0].primary).toEqual({ stage: "upload", code: fault === "no-progress" ? "upload_no_progress" : fault });
  expect(f.calls()).toBe(0); expect(await fs.lstat(join(f.jobsRoot, ".ssh-incoming", f.job.jobId)).catch(() => null)).toBeNull();
 }
});
test("executor/receipt plus cleanup preserve public precedence, primary reason and uncertainty without a retry", async () => {
 for (const failure of ["executor", "receipt", "cleanup", "both", "receipt-cleanup"] as const) {
  const f = await fixture(); let executions = 0;
  const options: SshServerOptions = { ...f.options, execute: async () => { executions++; if (failure === "executor" || failure === "both") throw injectedError(); if (failure === "receipt" || failure === "receipt-cleanup") return { ...f.receipt, executorId: secret }; return f.receipt; } };
  if (failure === "cleanup" || failure === "both" || failure === "receipt-cleanup") options.fs = { rm: async () => { throw injectedError("EACCES"); } };
  expect(await serveSshResponse(f.frame(), f.config, options)).toEqual({ version: 2, error: failure === "receipt" ? "invalid_receipt" : "receiver_failed" });
  const [r] = await f.records(); expect((await f.records()).length).toBe(1); expect(executions).toBe(1);
  expect(r.primary).toEqual({ stage: failure === "receipt" || failure === "receipt-cleanup" ? "receipt" : failure === "cleanup" ? "cleanup" : "executor_boundary", code: failure === "receipt" || failure === "receipt-cleanup" ? "invalid_receipt" : failure === "cleanup" ? "EACCES" : "unknown" });
  if (failure === "both" || failure === "receipt-cleanup") expect(r.cleanup).toEqual({ stage: "cleanup", code: "EACCES" });
  expect(Object.keys(r).sort()).toEqual(["version", "id", "time", "operation", "job", "primary", ...(failure === "both" || failure === "receipt-cleanup" ? ["cleanup"] : [])].sort());
 }
});
test("success/test failure/missing/active/interrupted/revoked/busy V1/V2 responses produce no diagnostics", async () => {
 const f = await fixture();
 for (const version of [1, 2] as const) {
  expect(await serveSshResponse(f.frame("status", "", { version }), f.config, f.options)).toEqual({ version, receipt: null });
  for (const failed of [false, true]) {
   const receipt = failed ? { ...f.receipt, status: "test_failed" as const, exitCode: 1 } : f.receipt;
   expect(await serveSshResponse(f.frame("submit", "bundle", { version }), f.config, { ...f.options, execute: async () => receipt })).toEqual({ version, receipt });
  }
  expect(await serveSshResponse(f.frame("submit", "bundle", { version }), f.config, { ...f.options, execute: async () => { throw new BusyRemoteTestExecutor(); } })).toEqual(version === 1 ? { version, receipt: null } : { version, receipt: null, state: "busy" });
 }
 const ledger = await openJobLedger(f.jobsRoot, "fixture");
 try {
  const admitted = ledger.admit(f.job); if (admitted.kind !== "admitted") throw Error();
  for (const version of [1, 2] as const) expect(await serveSshResponse(f.frame("status", "", { version }), f.config, f.options)).toEqual(version === 1 ? { version, receipt: null } : { version, receipt: null, state: "active" });
  await ledger.reconcile({ list: async () => [], remove: async () => {}, cleanup: async () => {} });
  for (const version of [1, 2] as const) expect(await serveSshResponse(f.frame("status", "", { version }), f.config, f.options)).toEqual(version === 1 ? { version, receipt: null } : { version, receipt: null, state: "interrupted" });
  const resumed = ledger.admit(f.job); if (resumed.kind !== "admitted") throw Error();
  ledger.launch(f.job, resumed.token); ledger.complete(f.job, resumed.token, f.receipt); ledger.cancel(f.job);
  const dir = join(f.jobsRoot, ".artifacts", f.job.jobId); await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.writeFile(join(dir, "receipt.json"), JSON.stringify(f.receipt), { mode: 0o600 });
  for (const version of [1, 2] as const) expect(await serveSshResponse(f.frame("status", "", { version }), f.config, f.options)).toEqual(version === 1 ? { version, receipt: null } : { version, receipt: f.receipt, state: "revoked" });
 } finally { ledger.close(); }
 expect(await f.records()).toEqual([]); expect(f.warnings()).toBe(0);
});
test("classification accepts exact errno only, ignores messages/stack/cause/getters and all unknown strings", () => {
 for (const code of ["EACCES", "EPERM", "ENOENT", "EEXIST", "ENOSPC", "EDQUOT", "EIO", "EROFS", "EMFILE", "ENFILE"] as const) expect(classifyReceiverFailure(injectedError(code), "upload")).toEqual({ stage: "upload", code });
 for (const value of [secret, injectedError(), { code: `EIO${secret}` }, Object.defineProperty({}, "code", { get: () => { throw Error(secret); } })]) expect(classifyReceiverFailure(value, "upload")).toEqual({ stage: "upload", code: "unknown" });
});

test("store caps bytes/count and rejects unsafe paths/entries without chmod, traversal, overwrite or fallback", async () => {
 const f = await fixture();
 for (const path of ["relative", join(f.diagnosticsRoot, "missing"), f.jobsRoot, f.root]) await expect(persistReceiverDiagnostic(path, refusal, [f.jobsRoot])).rejects.toThrow();
 await fs.symlink(f.diagnosticsRoot, join(f.root, "alias")); await expect(persistReceiverDiagnostic(join(f.root, "alias"), refusal)).rejects.toThrow();
 await fs.chmod(f.diagnosticsRoot, 0o755); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow(); expect((await fs.stat(f.diagnosticsRoot)).mode & 0o777).toBe(0o755); await fs.chmod(f.diagnosticsRoot, 0o700);
 const data = join(f.diagnosticsRoot, "unknown");
 await fs.writeFile(data, secret, { mode: 0o644 }); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow(); await fs.chmod(data, 0o600);
 await fs.link(data, join(f.root, "hardlink")); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow(); await fs.unlink(join(f.root, "hardlink"));
 await fs.symlink(data, join(f.diagnosticsRoot, "symlink")); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow(); await fs.unlink(join(f.diagnosticsRoot, "symlink"));
 await fs.mkdir(join(f.diagnosticsRoot, "unknown-directory")); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow(); await fs.rmdir(join(f.diagnosticsRoot, "unknown-directory"));
 await fs.writeFile(data, Buffer.alloc(DIAGNOSTIC_LIMITS.fileBytes), { mode: 0o600 }); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow("capacity"); expect((await fs.stat(data)).size).toBe(DIAGNOSTIC_LIMITS.fileBytes); await fs.unlink(data);
 for (let start = 0; start < DIAGNOSTIC_LIMITS.entries; start += 128) await Promise.all(Array.from({ length: 128 }, (_, i) => fs.writeFile(join(f.diagnosticsRoot, `unknown-${start + i}`), "", { mode: 0o600 })));
 await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow("capacity");
 await fs.writeFile(join(f.diagnosticsRoot, "overflow"), "", { mode: 0o600 }); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow("entry limit");
 expect((await fs.readdir(f.diagnosticsRoot)).length).toBe(4097); expect(await f.records()).toEqual([]);
});
test("store validates schema/record limit, git boundary, same uid and unwritable ancestors", async () => {
 const f = await fixture();
 await expect(persistReceiverDiagnostic(f.diagnosticsRoot, { ...refusal, raw: secret } as RefusalDiagnostic)).rejects.toThrow();
 await expect(persistReceiverDiagnostic(f.diagnosticsRoot, { ...refusal, primary: { stage: "header", code: secret } } as unknown as RefusalDiagnostic)).rejects.toThrow();
 await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal, [], { id: () => secret.repeat(100) })).rejects.toThrow();
 await fs.writeFile(join(f.root, ".git"), "gitdir: fixture"); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow("inside git"); await fs.unlink(join(f.root, ".git"));
 await fs.mkdir(join(f.root, "objects")); await fs.mkdir(join(f.root, "refs")); await fs.writeFile(join(f.root, "HEAD"), "ref: refs/heads/main");
 await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow("inside git");
 await fs.rmdir(join(f.root, "objects")); await fs.rmdir(join(f.root, "refs")); await fs.unlink(join(f.root, "HEAD"));
 await fs.chmod(f.root, 0o777); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow("permissions"); await fs.chmod(f.root, 0o700);
 const lstat = (async (path: string) => { const s = await fs.lstat(path); if (path === f.diagnosticsRoot) Object.defineProperty(s, "uid", { value: process.getuid!() + 1 }); return s; }) as typeof fs.lstat;
 await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal, [], { fs: { lstat } })).rejects.toThrow("permissions");
 expect(await fs.readdir(f.diagnosticsRoot)).toEqual([]);
});
test("write-triggered age retention deletes only strict expired published records; rollback retains future/pending/malformed/unknown", async () => {
 const f = await fixture(), now = Date.now(), older = now - DIAGNOSTIC_LIMITS.retentionMs - 1;
 const old = (time: number): ReceiverDiagnostic => ({ ...refusal, version: 1, id: randomUUID(), time });
 const records = [old(older), old(now), old(now + 86400_000)];
 for (const r of records) await fs.writeFile(join(f.diagnosticsRoot, `${r.id}.json`), JSON.stringify(r), { mode: 0o600 });
 const pending = old(older); await fs.writeFile(join(f.diagnosticsRoot, `.pending-${pending.id}`), JSON.stringify(pending), { mode: 0o600 });
 await fs.writeFile(join(f.diagnosticsRoot, "unknown"), JSON.stringify(old(older)), { mode: 0o600 });
 const malformed = `${randomUUID()}.json`; await fs.writeFile(join(f.diagnosticsRoot, malformed), secret, { mode: 0o600 });
 await persistReceiverDiagnostic(f.diagnosticsRoot, refusal, [], { now: () => now });
 expect(await fs.lstat(join(f.diagnosticsRoot, `${records[0].id}.json`)).catch(() => null)).toBeNull();
 for (const name of [`.pending-${pending.id}`, "unknown", malformed, ...records.slice(1).map(r => `${r.id}.json`)]) expect(await fs.lstat(join(f.diagnosticsRoot, name))).toBeDefined();
 const before = await fs.readdir(f.diagnosticsRoot); await persistReceiverDiagnostic(f.diagnosticsRoot, refusal, [], { now: () => older });
 expect((await fs.readdir(f.diagnosticsRoot)).length).toBe(before.length + 1);
});
test("exclusive lock attempts once, never waits/steals; stale lock and pending/UUID collisions remain", async () => {
 const f = await fixture(), lock = join(f.diagnosticsRoot, ".diagnostic-lock");
 await fs.mkdir(lock, { mode: 0o700 }); await fs.writeFile(join(lock, "unknown"), secret);
 await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow(); expect(await fs.readFile(join(lock, "unknown"), "utf8")).toBe(secret); await fs.rm(lock, { recursive: true });
 const outcomes = await Promise.allSettled([persistReceiverDiagnostic(f.diagnosticsRoot, refusal), persistReceiverDiagnostic(f.diagnosticsRoot, refusal)]);
 expect(outcomes.filter(r => r.status === "fulfilled").length).toBe(1); expect((await f.records()).length).toBe(1);
 const id = randomUUID(), pending = join(f.diagnosticsRoot, `.pending-${id}`);
 await fs.writeFile(pending, secret, { mode: 0o600 }); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal, [], { id: () => id })).rejects.toThrow(); expect(await fs.readFile(pending, "utf8")).toBe(secret); await fs.unlink(pending);
 const destination = join(f.diagnosticsRoot, `${id}.json`); await fs.writeFile(destination, secret, { mode: 0o600 }); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal, [], { id: () => id })).rejects.toThrow(); expect(await fs.readFile(destination, "utf8")).toBe(secret); expect(await fs.lstat(pending).catch(() => null)).toBeNull();
});
test("write/sync/publish/cleanup faults never replace refusal; uncertain publication retains evidence", async () => {
 for (const step of ["write", "file-sync", "publish", "root-sync", "temp-cleanup", "lock-release"] as const) {
  const f = await fixture();
  const adapter: NonNullable<DiagnosticStoreOptions["fs"]> = {
   open: async (...args) => {
    const file = await fs.open(...args), path = String(args[0]);
    if (path.includes(".pending-") && (step === "write" || step === "temp-cleanup")) file.writeFile = async () => { throw injectedError("ENOSPC"); };
    if (step === "file-sync" && path.includes(".pending-") || step === "root-sync" && path === f.diagnosticsRoot) file.sync = async () => { throw injectedError("EIO"); };
    return file;
   },
   link: async (...args) => { if (step === "publish") throw injectedError("EPERM"); return fs.link(...args); },
   unlink: async (...args) => { if (step === "temp-cleanup") throw injectedError("EIO"); return fs.unlink(...args); },
   rmdir: async (...args) => { if (step === "lock-release") throw injectedError("EIO"); return fs.rmdir(...args); },
  };
  const response = await serveSshResponse(raw(secret), f.config, { ...f.options, diagnostics: { ...f.options.diagnostics!, store: { fs: adapter } } });
  expect(response).toEqual({ version: 1, error: "receiver_failed" }); expect(f.warnings()).toBe(1); expect(f.calls()).toBe(0);
  const names = await fs.readdir(f.diagnosticsRoot);
  if (step === "root-sync" || step === "lock-release") expect((await f.records()).length).toBe(1);
  else expect(await f.records()).toEqual([]);
  expect(names.some(n => n.startsWith(".pending-"))).toBe(step === "temp-cleanup");
  expect(names.includes(".diagnostic-lock")).toBe(step === "lock-release");
 }
});

test("store rejects wrong-owner entries, symlinked ancestors and aliased job-root overlap", async () => {
 const f = await fixture(), path = join(f.diagnosticsRoot, "unknown");
 await fs.writeFile(path, secret, { mode: 0o600 });
 const lstat = (async (candidate: string) => { const s = await fs.lstat(candidate); if (candidate === path) Object.defineProperty(s, "uid", { value: process.getuid!() + 1 }); return s; }) as typeof fs.lstat;
 await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal, [], { fs: { lstat } })).rejects.toThrow("entry");
 expect(await fs.readFile(path, "utf8")).toBe(secret);
 await fs.symlink(f.root, join(f.root, "ancestor-alias")); await expect(persistReceiverDiagnostic(join(f.root, "ancestor-alias", "diagnostics"), refusal)).rejects.toThrow("path");
 await fs.symlink(f.diagnosticsRoot, join(f.root, "jobs-alias")); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal, [join(f.root, "jobs-alias")])).rejects.toThrow("Overlapping");
 await fs.chmod(f.root, 0o1777); await expect(persistReceiverDiagnostic(f.diagnosticsRoot, refusal)).rejects.toThrow("permissions"); await fs.chmod(f.root, 0o700);
});
test("maximal strict record remains below 1024 bytes; over-limit published-looking evidence is retained", async () => {
 const f = await fixture(), maximum: RefusalDiagnostic = { operation: "submit", job: { jobId: randomUUID(), generation: Number.MAX_SAFE_INTEGER }, primary: { stage: "executor_boundary", code: "profile_not_approved" }, cleanup: { stage: "cleanup", code: "upload_no_progress" } };
 const id = randomUUID(), old = { ...maximum, version: 1, id, time: Date.now() - DIAGNOSTIC_LIMITS.retentionMs - 1, raw: secret.repeat(100) };
 const path = join(f.diagnosticsRoot, `${id}.json`); await fs.writeFile(path, JSON.stringify(old), { mode: 0o600 });
 await persistReceiverDiagnostic(f.diagnosticsRoot, maximum);
 expect(await fs.readFile(path, "utf8")).toBe(JSON.stringify(old));
 const published = (await fs.readdir(f.diagnosticsRoot)).filter(n => n !== `${id}.json`); expect(published.length).toBe(1);
 const text = await fs.readFile(join(f.diagnosticsRoot, published[0]), "utf8"); expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024); expect(text).not.toContain(secret);
});

test("partially invalid operator config still excludes its jobs root from diagnostic storage", async () => {
 const f = await fixture(), invalid = { ...f.config, executorId: "invalid " + secret };
 const response = await serveSshResponse(raw(""), invalid, { ...f.options, diagnostics: { ...f.options.diagnostics!, root: f.jobsRoot } });
 expect(response).toEqual({ version: 1, error: "receiver_failed" }); expect(f.warnings()).toBe(1); expect(await fs.readdir(f.jobsRoot)).toEqual([]);
 const child = await cli(f, "", ["--diagnostics-root", f.jobsRoot], invalid);
 expect(child).toEqual({ code: 0, stdout: '{"version":1,"error":"receiver_failed"}\n', stderr: "ranger remote-test: private diagnostic unavailable.\n" });
 expect(await fs.readdir(f.jobsRoot)).toEqual([]); expect(f.calls()).toBe(0);
});
