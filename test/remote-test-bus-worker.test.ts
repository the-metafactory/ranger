import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { type MyelinSubscribePullOpts } from "@the-metafactory/cortex/bus";
import { taskSubjectAndType } from "@the-metafactory/myelin/subjects";
import { runCmd } from "../src/exec.ts";
import { persistExecution } from "../src/remote-test/artifacts.ts";
import { validateBusConfig, BUS_LIMITS } from "../src/remote-test/bus-contract.ts";
import { startBusWorker, connectBusWorker, BusWorkerReadinessRefusal, type BusWorker, type BusWorkerTransport, type BusWorkerInjected } from "../src/remote-test/bus-worker.ts";
import { BUS_WORKER_DIR, readBusWorkerOwner, writeBusWorkerOwner } from "../src/remote-test/bus-worker-workspace.ts";
import { reconcileRemoteTests } from "../src/remote-test/executor.ts";
import { openJobLedger, BusyRemoteTestExecutor } from "../src/remote-test/job-ledger.ts";
import type { RemoteTestJob, RemoteTestReceipt } from "../src/remote-test/contract.ts";
import { busWorkerIssuers, busWorkerRegistry, busWorkerRequest, busWorkerSource, issuer, sha } from "./remote-test-bus-worker-support.ts";

const roots: string[] = [], workers: BusWorker[] = [];
afterEach(async () => { for (const w of workers.splice(0)) await w.stop(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(probe: () => boolean) { for (let i = 0; i < 500 && !probe(); i++) await Bun.sleep(5); expect(probe()).toBe(true); }

async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-bus-worker-"))); roots.push(root);
 const outboxRoot = join(root, "outbox");
 const { jobsRoot, bytes, executor, job } = await busWorkerSource(root), { seed, registryFile: registry } = await busWorkerRegistry(root);
 const bus = validateBusConfig({ version: 1, target: { domain: "private", account: "A".repeat(56) }, routing: { classification: "local", principal: "example", stack: "private" },
  streams: { request: { stream: "REQUESTS", durable: "executor" }, result: { stream: "RESULTS" } }, transport: { servers: ["nats://127.0.0.1:4222"], credentialsFile: join(root, "user.creds") }, ssh: { configFile: join(root, "ssh.json") }, registry: { file: registry },
  execution: { maxAckPending: 1, maxConcurrentJobs: 1, ackWaitSeconds: 10, progressIntervalSeconds: 1, maxDeliver: 3 }, issuers: busWorkerIssuers(job) });
 const route = taskSubjectAndType("example", "ci-test", "private");
 const consumer = { durable_name: "executor", filter_subject: route.subject, ack_policy: "explicit", max_ack_pending: 1, ack_wait: 10e9, max_deliver: 3 };
 let subscription: MyelinSubscribePullOpts | undefined, closed = 0, executions = 0;
 const published: any[] = [], diagnostics: string[] = [];
 let publish: (envelope: any) => Promise<any> = async () => ({ stream: "RESULTS", domain: "private", seq: 1, duplicate: false });
 const transport: BusWorkerTransport = { enabled: true,
  publishDurable: async e => { published.push(structuredClone(e)); return await publish(e); },
  jetstreamManager: async () => ({ streams: { info: async () => ({ config: { max_msg_size: BUS_LIMITS.requestBytes } }), add: () => { throw Error("must not provision"); }, update: () => { throw Error("must not repair"); } },
   consumers: { info: async () => ({ config: consumer }), add: () => { throw Error("must not provision"); }, update: () => { throw Error("must not repair"); }, delete: () => { throw Error("must not repair"); } } }) as any,
  subscribePull: opts => { subscription = opts; return { ready: Promise.resolve(), stop: async () => {} }; }, stop: async () => { closed++; } };
 const ledger = () => openJobLedger(jobsRoot, "fixture");
 let beforeExecution = async (_signal?: AbortSignal) => {};
 const execute: NonNullable<BusWorkerInjected["execute"]> = async (input, options) => {
  executions++;
  expect(await readFile(input.bundlePath)).toEqual(bytes);
  const j = input.job as RemoteTestJob, l = await ledger();
  try {
   const a = l.admit(j); if (a.kind === "busy") throw new BusyRemoteTestExecutor(); if (a.kind !== "admitted") throw Error(a.kind);
   const cancel = () => { l.cancel(j); }; options?.signal?.addEventListener("abort", cancel, { once: true });
   if (options?.signal?.aborted) cancel();
   try {
    await beforeExecution(options?.signal);
    const allowed = l.allowed(j, a.token);
    if (allowed) l.launch(j, a.token);
    const r: RemoteTestReceipt = { version: 1, identity: j, executorId: "fixture", status: allowed ? "passed" : "cancelled", exitCode: allowed ? 0 : null, completedAt: Date.now() };
    const stored = await persistExecution(join(jobsRoot, ".artifacts"), r, { startedAt: Date.now(), log: Buffer.from("log"), truncated: false, outputState: "captured", resources: { state: "skipped", cpuTimeMicros: null, peakMemoryBytes: null } });
    return l.complete(j, a.token, stored);
   } finally { options?.signal?.removeEventListener("abort", cancel); }
  } finally { l.close(); }
 };
 const input = async (j = job, signed = true, sourceBytes = bytes.length) => {
  const e = await busWorkerRequest({ source: "example.private.ranger", type: route.type, job: j, bundleBytes: sourceBytes, seed: signed ? seed : undefined });
  return { bytes: Buffer.from(JSON.stringify(e)), subject: route.subject };
 };
 const start = async (injected: BusWorkerInjected = {}) => { const w = await startBusWorker({ bus, executor, signer: { issuer, seed }, outboxRoot, offerings: [{ capability: "ci-test", scopes: ["local"] }] }, { connect: async () => transport, execute, diagnostic: code => { diagnostics.push(code); }, ...injected }); workers.push(w); return w; };
 return { root, jobsRoot, outboxRoot, bus, executor, job, consumer, transport, input, ledger, start, published, diagnostics, executions: () => executions, closed: () => closed, subscription: () => subscription,
  publish: (fn: typeof publish) => { publish = fn; }, beforeExecution: (fn: typeof beforeExecution) => { beforeExecution = fn; } };
}

test("public lifecycle uses one pull and serial handler and only a durably published receipt permits ack", async () => {
 const f = await fixture(), w = await f.start();
 const l = await f.ledger();
 try { expect(await readBusWorkerOwner(join(f.jobsRoot, BUS_WORKER_DIR))).toEqual({ ledgerId: l.id }); } finally { l.close(); }
 expect(f.subscription()).toMatchObject({ stream: "REQUESTS", durable: "executor", maxMessages: 1, maxConcurrent: 1 });
 expect(await w.handle(await f.input(), { working() {} })).toEqual({ kind: "ack" });
 expect(f.executions()).toBe(1); expect(f.published).toHaveLength(1);
 expect(f.published[0].payload.result_summary).toContain("status=passed");
 expect(await w.handle(await f.input(), { working() {} })).toEqual({ kind: "ack" });
 expect(f.executions()).toBe(1); expect(f.published).toHaveLength(1);
 await w.stop(); expect(f.closed()).toBe(1); expect(existsSync(join(f.jobsRoot, BUS_WORKER_DIR))).toBe(false);
});

test("pending durable publication retries after restart without another execution and keeps event identity", async () => {
 const f = await fixture(); f.publish(async () => { throw Error("transport unavailable"); });
 const first = await f.start(); expect((await first.handle(await f.input(), { working() {} })).kind).toBe("nak");
 await first.stop();
 f.publish(async () => ({ stream: "RESULTS", domain: "private", seq: 2, duplicate: true }));
 const second = await f.start(); expect(await second.handle(await f.input(), { working() {} })).toEqual({ kind: "ack" });
 expect(f.executions()).toBe(1); expect(f.published).toHaveLength(2); expect(f.published[0].id).toBe(f.published[1].id);
});

test("publication ack followed by local outbox commit failure remains retryable with the same event", async () => {
 const f = await fixture(); let fail = true;
 const w = await f.start({ outboxFault: step => { if (step === "acked" && fail) { fail = false; throw Error("lost fsync"); } } });
 expect((await w.handle(await f.input(), { working() {} })).kind).toBe("nak");
 expect(await w.handle(await f.input(), { working() {} })).toEqual({ kind: "ack" });
 expect(f.executions()).toBe(1); expect(f.published[0].id).toBe(f.published[1].id);
});

test("progress covers execution and pending terminal delivery and concurrent handle never launches", async () => {
 const f = await fixture(), execution = deferred(), publication = deferred();
 f.beforeExecution(async () => { await execution.promise; }); f.publish(async () => { await publication.promise; return { stream: "RESULTS", domain: "private", seq: 1, duplicate: false }; });
 const w = await f.start(); let progress = 0;
 const running = w.handle(await f.input(), { working() { progress++; } });
 await until(() => f.executions() === 1 && progress > 0);
 expect((await w.handle(await f.input(), { working() {} })).kind).toBe("nak");
 execution.resolve(); await until(() => f.published.length === 1);
 const before = progress; await until(() => progress > before); publication.resolve();
 expect(await running).toEqual({ kind: "ack" }); const finished = progress; await Bun.sleep(30); expect(progress).toBe(finished);
});

test("working failure cannot acknowledge success and terminal redelivery does not execute again", async () => {
 const f = await fixture(), release = deferred(); f.beforeExecution(async () => { await release.promise; });
 const w = await f.start(); let progress = 0;
 const running = w.handle(await f.input(), { working() { progress++; throw Error("lost progress"); } });
 await until(() => progress > 0); release.resolve(); expect((await running).kind).toBe("nak");
 expect(await w.handle(await f.input(), { working() {} })).toEqual({ kind: "ack" }); expect(f.executions()).toBe(1);
});

test("malformed, unsigned and unauthorized delivery terms without attributed events or ledger records", async () => {
 const f = await fixture(), w = await f.start();
 for (const input of [{ bytes: Buffer.from("not json"), subject: "local.example.private.tasks.ci-test" }, await f.input(f.job, false), await f.input({ ...f.job, repositoryId: "github:github.com/other/repo" })]) expect((await w.handle(input, { working() {} })).kind).toBe("term");
 const l = await f.ledger(); try { expect(l.recorded(f.job)).toBe(false); } finally { l.close(); }
 expect(f.executions()).toBe(0); expect(f.published).toHaveLength(0); expect(f.diagnostics.every(s => s.length < 100)).toBe(true);
});

test("unavailable registry is delayed nak without a false permanent authentication verdict", async () => {
 const f = await fixture(), w = await f.start(); await rm(f.bus.registry.file);
 expect((await w.handle(await f.input(), { working() {} })).kind).toBe("nak"); expect(f.executions()).toBe(0); expect(f.published).toHaveLength(0);
});

test("authenticated expired work durably publishes an explicit non-receipt refusal before ack", async () => {
 const f = await fixture(), w = await f.start(), expired = { ...f.job, deadline: Date.now() - 1 };
 expect(await w.handle(await f.input(expired), { working() {} })).toEqual({ kind: "ack" });
 expect(f.published[0].payload.error_summary).toContain("refusal=expired"); expect(JSON.stringify(f.published)).not.toContain("receipt=");
 const l = await f.ledger(); try { expect(l.recorded(expired)).toBe(false); } finally { l.close(); } expect(f.executions()).toBe(0);
});

test("source refusal is replayed durably and never acquires execution authority", async () => {
 const f = await fixture(), w = await f.start(); await rm(join(f.jobsRoot, ".source-store", f.job.bundleDigest.slice(7)), { recursive: true });
 f.publish(async () => { throw Error("offline"); }); expect((await w.handle(await f.input(), { working() {} })).kind).toBe("nak");
 f.publish(async () => ({ stream: "RESULTS", domain: "private", seq: 1, duplicate: false })); expect(await w.handle(await f.input(), { working() {} })).toEqual({ kind: "ack" });
 expect(f.published[0].payload.error_summary).toContain("refusal=source_rejected"); expect(f.published[1].id).toBe(f.published[0].id); expect(f.executions()).toBe(0);
});

test("source byte binding mismatch and invalid restored identities refuse before execution", async () => {
 const f = await fixture(), w = await f.start();
 expect(await w.handle(await f.input(f.job, true, 1), { working() {} })).toEqual({ kind: "ack" });
 const other = { ...f.job, jobId: randomUUID(), treeDigest: "f".repeat(40) };
 expect(await w.handle(await f.input(other), { working() {} })).toEqual({ kind: "ack" }); expect(f.executions()).toBe(0);
});

test("transient staged metadata I/O returns delayed nak without a durable source refusal", async () => {
 const f = await fixture(), w = await f.start(), original = fs.open;
 const reference = join(f.jobsRoot, ".source-store", f.job.bundleDigest.slice(7), "reference.json");
 const fault = spyOn(fs, "open").mockImplementation((path, flags, mode) => {
  if (path === reference) throw Object.assign(Error("synthetic private metadata I/O failure"), { code: "EIO" });
  return original(path, flags, mode);
 });
 try { expect((await w.handle(await f.input(), { working() {} })).kind).toBe("nak"); expect(f.published).toHaveLength(0); expect(f.executions()).toBe(0); }
 finally { fault.mockRestore(); }
 expect(await w.handle(await f.input(), { working() {} })).toEqual({ kind: "ack" }); expect(f.executions()).toBe(1);
});

test("source cleanup failure fences subsequent work until service cleanup completes", async () => {
 const f = await fixture(), w = await f.start({ removeSource: async () => { throw Error("synthetic cleanup failure"); } });
 expect((await w.handle(await f.input(), { working() {} })).kind).toBe("nak");
 expect((await w.handle(await f.input({ ...f.job, jobId: randomUUID() }), { working() {} })).kind).toBe("nak"); expect(f.executions()).toBe(1);
 await w.stop(); const restarted = await f.start(); expect(await restarted.handle(await f.input(), { working() {} })).toEqual({ kind: "ack" }); expect(f.executions()).toBe(1);
});

test("active and interrupted ledger work never restarts on redelivery", async () => {
 const f = await fixture(), l = await f.ledger(), a = l.admit(f.job); if (a.kind !== "admitted") throw Error();
 const w = await f.start(); expect((await w.handle(await f.input(), { working() {} })).kind).toBe("nak");
 l.interrupt(f.job, a.token); l.close(); await w.stop();
 const restarted = await f.start(); expect((await restarted.handle(await f.input(), { working() {} })).kind).toBe("nak"); expect(f.executions()).toBe(0); expect(f.published).toHaveLength(0);
});

test("busy lane yields delayed retry and higher generation fences the occupied job", async () => {
 const f = await fixture(), l = await f.ledger(), old = { ...f.job, jobId: randomUUID(), generation: 1 };
 const a = l.admit(old); if (a.kind !== "admitted") throw Error(); l.launch(old, a.token);
 const w = await f.start(); expect((await w.handle(await f.input(), { working() {} })).kind).toBe("nak"); expect(l.allowed(old, a.token)).toBe(false);
 expect(l.recorded(f.job)).toBe(false); expect(f.published).toHaveLength(0); l.close();
});

test("only explicit confirmed recovery enables the remaining bounded attempt with a new token", async () => {
 const f = await fixture(), l = await f.ledger(), a = l.admit(f.job); if (a.kind !== "admitted") throw Error();
 l.launch(f.job, a.token); l.interrupt(f.job, a.token);
 const w = await f.start(); expect((await w.handle(await f.input(), { working() {} })).kind).toBe("nak"); expect(l.retryReady(f.job)).toBe(false);
 await w.stop();
 let inspected = 0;
 await l.reconcile({ list: async () => { inspected++; return []; }, remove: async () => { throw Error("no containers exist"); }, cleanup: async () => {} });
 expect(inspected).toBe(2); expect(l.retryReady(f.job)).toBe(true); expect(l.allowed(f.job, a.token)).toBe(false); l.close();
 const restarted = await f.start(); expect(await restarted.handle(await f.input(), { working() {} })).toEqual({ kind: "ack" }); expect(f.executions()).toBe(1);
});

test("explicit executor recovery removes only a ledger-owned stale bus workspace after container absence", async () => {
 const f = await fixture(), l = await f.ledger();
 const workspace = join(f.jobsRoot, BUS_WORKER_DIR); await mkdir(workspace, { mode: 0o700 }); await writeBusWorkerOwner(workspace, l.id); l.close();
 const commands: string[][] = [];
 await reconcileRemoteTests(f.executor, { launcher: async argv => { commands.push([...argv]); return { code: 0, stdout: "" }; } });
 expect(commands).toHaveLength(2); expect(commands.every(c => c.includes("ps"))).toBe(true); expect(existsSync(workspace)).toBe(false);
 await f.start();
});

test.each([
 ["foreign ledger", (_id: string) => ({ ledgerId: randomUUID() })],
 ["malformed ledger", (_id: string) => ({ ledgerId: "invalid" })],
 ["unknown field", (id: string) => ({ ledgerId: id, extra: true })],
] as const)("executor recovery retains a bus workspace with %s", async (_label, owner) => {
 const f = await fixture(), l = await f.ledger(), invalid = owner(l.id); l.close();
 const workspace = join(f.jobsRoot, BUS_WORKER_DIR); await mkdir(workspace, { mode: 0o700 });
 await writeFile(join(workspace, "owner.json"), JSON.stringify(invalid), { mode: 0o600 });
 await expect(reconcileRemoteTests(f.executor, { launcher: async () => ({ code: 0, stdout: "" }) })).rejects.toThrow();
 expect(existsSync(workspace)).toBe(true);
 await expect(f.start()).rejects.toThrow(); expect(f.subscription()).toBeUndefined();
});

test("authenticated profile refusal delivers non-receipt evidence and cannot launch", async () => {
 const f = await fixture(), w = await f.start(), mismatch = { ...f.job, lockDigest: sha("other lock") };
 expect(await w.handle(await f.input(mismatch), { working() {} })).toEqual({ kind: "ack" });
 expect(f.published[0].payload.error_summary).toContain("refusal=profile_rejected"); expect(f.executions()).toBe(0);
 const l = await f.ledger(); try { expect(l.recorded(mismatch)).toBe(false); } finally { l.close(); }
});

test("revoked retained success cannot be replayed as current success", async () => {
 const f = await fixture(), w = await f.start(); expect((await w.handle(await f.input(), { working() {} })).kind).toBe("ack");
 const l = await f.ledger(); l.cancel(f.job); l.close();
 expect((await w.handle(await f.input(), { working() {} })).kind).toBe("term"); expect(f.executions()).toBe(1); expect(f.published).toHaveLength(1);
});

test("stop durably cancels execution and waits for cleanup before reopening the worker lane", async () => {
 const f = await fixture(), cleanup = deferred(); let cancelled = false;
 f.beforeExecution(async signal => { await new Promise<void>(resolve => { if (signal?.aborted) { cancelled = true; resolve(); } else signal?.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }); }); await cleanup.promise; });
 const w = await f.start(), running = w.handle(await f.input(), { working() {} }); await until(() => f.executions() === 1);
 let stopped = false; const stopping = w.stop().then(() => { stopped = true; }); await until(() => cancelled);
 expect(stopped).toBe(false); await expect(f.start()).rejects.toThrow(); cleanup.resolve(); await running; await stopping;
 const l = await f.ledger(); try { expect(l.status(f.job)).toMatchObject({ kind: "terminal", receipt: { status: "cancelled" } }); } finally { l.close(); }
 await f.start(); expect((await w.handle(await f.input(), { working() {} })).kind).toBe("nak");
});

test.each(["filter_subject", "max_ack_pending", "ack_wait", "max_deliver", "ack_policy"])("startup refuses consumer drift in %s without repair", async field => {
 const f = await fixture(); (f.consumer as any)[field] = field === "filter_subject" || field === "ack_policy" ? "wrong" : 2;
 await expect(f.start()).rejects.toBeInstanceOf(BusWorkerReadinessRefusal); expect(f.subscription()).toBeUndefined(); expect(f.closed()).toBe(1);
});

test("startup refuses unsupported SDK, missing resources, and unbounded request stream", async () => {
 const f = await fixture();
 for (const mutate of [() => { f.transport.subscribePull = undefined; }, () => { f.transport.jetstreamManager = async () => { throw Error("missing stream"); }; }, () => { f.transport.jetstreamManager = async () => ({ streams: { info: async () => ({ config: { max_msg_size: -1 } }) }, consumers: { info: async () => ({ config: f.consumer }) } }) as any; }]) {
  mutate(); await expect(f.start()).rejects.toBeInstanceOf(BusWorkerReadinessRefusal);
 }
 expect(f.executions()).toBe(0);
});

test("progress defaults to one third of ack wait and refuses sub-second or expired intervals", async () => {
 const f = await fixture(), raw = structuredClone(f.bus) as any; delete raw.execution.progressIntervalSeconds;
 expect(validateBusConfig(raw).execution.progressIntervalSeconds).toBe(10 / 3);
 for (const value of [0, -1, 0.001, 0.999, 10, 11, NaN, Infinity]) { raw.execution.progressIntervalSeconds = value; expect(() => validateBusConfig(raw)).toThrow(); }
 for (const value of [1, 1.5, 9.999]) { raw.execution.progressIntervalSeconds = value; expect(validateBusConfig(raw).execution.progressIntervalSeconds).toBe(value); }
});

test("transport account mismatch refuses before SDK connection", async () => {
 const f = await fixture(); let calls = 0;
 await writeFile(f.bus.transport.credentialsFile, "-----BEGIN NATS USER JWT-----\n" + ["e30", Buffer.from(JSON.stringify({ iss: "B".repeat(56), sub: "U".repeat(56), nats: { type: "user" } })).toString("base64url"), "sig"].join(".") + "\n------END NATS USER JWT------\n-----BEGIN USER NKEY SEED-----\nSU" + "A".repeat(56) + "\n------END USER NKEY SEED------\n", { mode: 0o600 });
 const connect = connectBusWorker(async () => { calls++; throw Error(); });
 await expect(f.start({ connect })).rejects.toMatchObject({ code: "account_binding" }); expect(calls).toBe(0);
});

test("SDK authenticates only the exact checked credential blocks despite prepended account decoys", async () => {
 const f = await fixture(), token = ["e30", Buffer.from(JSON.stringify({ iss: f.bus.target.account, sub: "U".repeat(56), nats: { type: "user" } })).toString("base64url"), "sig"].join(".");
 const checked = `-----BEGIN NATS USER JWT-----\n${token}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\nSU${"A".repeat(56)}\n------END USER NKEY SEED------\n`;
 await writeFile(f.bus.transport.credentialsFile, `-----BEGIN DECOY JWT-----\nother-account-token\n------END DECOY JWT------\n-----BEGIN DECOY SEED-----\nother-account-seed\n------END DECOY SEED------\n${checked}`, { mode: 0o600 });
 let snapshot = "";
 const connect = connectBusWorker(async config => {
  snapshot = await readFile(config.nats!.credsPath!, "utf8");
  return { enabled: false, stop: async () => {} } as any;
 });
 await expect(f.start({ connect })).rejects.toMatchObject({ code: "sdk_transport" }); expect(snapshot).toBe(checked); expect(snapshot).not.toContain("other-account");
});

test("CLI advertises opt-in worker and refuses invalid private inputs without starting it", async () => {
 const help = await runCmd("bun", ["src/cli.ts", "remote-test", "bus-worker", "--help"]); expect(help.code).toBe(0); expect(help.stdout).toContain("--executor-config");
 const refused = await runCmd("bun", ["src/cli.ts", "remote-test", "bus-worker", "--config", "/missing/bus", "--executor-config", "/missing/executor", "--signer", "/missing/signer", "--outbox-root", "/missing/outbox"]);
 expect(refused.code).toBe(1); expect(refused.stderr).toContain("not ready (private_configuration)");
});
