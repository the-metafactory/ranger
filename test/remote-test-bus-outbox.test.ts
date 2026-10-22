import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MyelinDurablePublishError, validateEnvelope, type Envelope, type MyelinDurablePublishErrorKind } from "@the-metafactory/cortex/bus";
import { persistExecution, readExecutionReceipt } from "../src/remote-test/artifacts.ts";
import { BusContractRefusal, validateBusConfig } from "../src/remote-test/bus-contract.ts";
import { BusOutboxRefusal, CI_TEST_CAPABILITY, openBusOutbox, type BusOutbox, type DurablePublisher, type OutboxFault, type OutboxRefusalReason } from "../src/remote-test/bus-outbox.ts";
import { REMOTE_TEST_STATUSES, type RemoteTestJob, type RemoteTestStatus } from "../src/remote-test/contract.ts";
import { openJobLedger, type JobLedger } from "../src/remote-test/job-ledger.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const ISSUER = "did:myelin:ranger-ci";
const STREAM = "CI_TEST_RESULTS";
const DOMAIN = "clawbox";
const bus = validateBusConfig({
 version: 1,
 target: { domain: DOMAIN, account: "ci" },
 routing: { classification: "local", principal: "jc", stack: "clawbox" },
 streams: { request: { stream: "CI_TEST_REQUESTS", durable: "ranger-ci" }, result: { stream: STREAM } },
 transport: { servers: ["nats://127.0.0.1:4222"], credentialsFile: "/operator/ci.creds" },
 ssh: { configFile: "/operator/ssh.json" },
 execution: { maxAckPending: 1, maxConcurrentJobs: 1, ackWaitSeconds: 60, progressIntervalSeconds: 10, maxDeliver: 3 },
 registry: { file: "/operator/registry.json" },
 issuers: [{ issuer: ISSUER, bindings: [{ repositoryId: "github:github.com/example/repo", profileId: "unit", profileDigest: digest("a") }] }],
});

function job(): RemoteTestJob {
 return { version: 1, jobId: randomUUID(), correlationId: randomUUID(), repositoryId: "github:github.com/example/repo", commitDigest: "a".repeat(40), treeDigest: "b".repeat(40), bundleDigest: digest("a"), profileId: "unit", profileDigest: digest("a"), lockDigest: digest("a"), imageDigest: digest("a"), platform: "linux-arm64", deadline: 20_000, generation: 1 };
}

async function fixture(fault?: OutboxFault) {
 const home = await mkdtemp(join(tmpdir(), "bus-outbox-")); roots.push(home);
 const jobsRoot = join(home, "jobs"), root = join(home, "outbox");
 await mkdir(jobsRoot, { mode: 0o700 });
 const ledger: JobLedger = await openJobLedger(jobsRoot, "fixture", () => 10_000);
 const open = (f = fault) => openBusOutbox({ bus, root, jobsRoot, executorId: "fixture", now: () => 12_345, fault: f });
 const outboxes: BusOutbox[] = [];
 const opened = async (f = fault) => { const o = await open(f); outboxes.push(o); return o; };
 return { home, jobsRoot, root, ledger, opened, close: () => { for (const o of outboxes.splice(0)) o.close(); ledger.close(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const exitFor = (status: RemoteTestStatus) => status === "passed" ? 0 : status === "test_failed" ? 1 : null;
async function finish(f: Fixture, j: RemoteTestJob, status: RemoteTestStatus = "passed", options: { retain?: boolean } = {}) {
 const admitted = f.ledger.admit(j);
 if (admitted.kind !== "admitted") throw Error("not admitted");
 f.ledger.launch(j, admitted.token);
 const base = { version: 1 as const, identity: j, executorId: "fixture", status, exitCode: exitFor(status), completedAt: 10_000 };
 const receipt = options.retain === false ? base
  : await persistExecution(join(f.jobsRoot, ".artifacts"), base, { startedAt: 9_000, log: Buffer.from("SECRET test log\n"), truncated: false, outputState: "captured", resources: { state: "skipped", cpuTimeMicros: null, peakMemoryBytes: null } }, { now: () => 10_000 });
 f.ledger.complete(j, admitted.token, receipt);
 return receipt;
}

interface Published { envelope: Envelope; expectedStream: string }
function recorder(behaviour: (envelope: Envelope, call: number) => unknown = (_, call) => ({ stream: STREAM, seq: call, duplicate: false, domain: DOMAIN })) {
 const calls: Published[] = [];
 const publisher: DurablePublisher = {
  publishDurable: async (envelope, options) => {
   calls.push({ envelope: structuredClone(envelope), expectedStream: options.expectedStream });
   const result = behaviour(envelope, calls.length);
   if (result instanceof Error) throw result;
   return result as Awaited<ReturnType<DurablePublisher["publishDurable"]>>;
  },
 };
 return { calls, publisher };
}
const failing = (kind: MyelinDurablePublishErrorKind) => (envelope: Envelope) => new MyelinDurablePublishError(kind, envelope.id, "injected");

test("an authoritative passed receipt is exported and queued as a completed lifecycle with a bounded opaque summary", async () => {
 const f = await fixture(), j = job(), receipt = await finish(f, j), outbox = await f.opened();
 try {
  const event = await outbox.enqueueTerminal(j);
  expect(event).toMatchObject({ jobId: j.jobId, origin: "receipt", state: "pending", attempts: 0, failure: null });
  const envelope = outbox.envelope(event.eventId)!;
  expect(envelope.type).toBe("dispatch.task.completed");
  expect(validateEnvelope(envelope).ok).toBe(true);
  expect(envelope.correlation_id).toBe(j.correlationId);
  const summary = String((envelope.payload).result_summary);
  expect(summary).toMatch(new RegExp(`^status=passed correlation=${j.correlationId} capability=${CI_TEST_CAPABILITY} receipt=sha256:[0-9a-f]{64}$`));
  const wire = JSON.stringify(envelope);
  expect(wire).not.toContain("SECRET");
  expect(wire).not.toContain(f.home);
  const exported = join(f.root, "receipts", `${j.jobId}.json`);
  expect(JSON.parse(await readFile(exported, "utf8"))).toEqual(receipt);
  expect((await stat(exported)).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.root, "outbox.sqlite"))).mode & 0o777).toBe(0o600);
  expect(outbox.ackEligible(j.jobId)).toBe(false);
  expect(await outbox.enqueueTerminal(j)).toEqual(event);
  expect(outbox.events()).toHaveLength(1);
 } finally { f.close(); }
});

test("each terminal status maps to the completed, failed or aborted lifecycle", async () => {
 const expected = { passed: "completed", test_failed: "failed", infra_failed: "failed", rejected: "failed", timed_out: "aborted", cancelled: "aborted" } as const;
 const f = await fixture(), outbox = await f.opened();
 try {
  for (const status of REMOTE_TEST_STATUSES) {
   const j = job(); await finish(f, j, status);
   const envelope = outbox.envelope((await outbox.enqueueTerminal(j)).eventId)!;
   expect(envelope.type).toBe(`dispatch.task.${expected[status]}`);
   expect(validateEnvelope(envelope).ok).toBe(true);
   expect(JSON.stringify(envelope.payload)).toContain(`status=${status} correlation=${j.correlationId}`);
  }
 } finally { f.close(); }
});

test("rowless, revoked, unfinished, absent and conflicting evidence queue nothing", async () => {
 const f = await fixture(), outbox = await f.opened();
 try {
  const rowless = job();
  await persistExecution(join(f.jobsRoot, ".artifacts"), { version: 1, identity: rowless, executorId: "fixture", status: "passed", exitCode: 0, completedAt: 10_000 },
   { startedAt: 9_000, log: Buffer.from("x"), truncated: false, outputState: "captured", resources: { state: "skipped", cpuTimeMicros: null, peakMemoryBytes: null } }, { now: () => 10_000 });
  const revoked = job(); await finish(f, revoked); f.ledger.cancel(revoked);
  const absent = job(); await finish(f, absent, "passed", { retain: false });
  const conflicting = job(), admitted = f.ledger.admit(conflicting);
  if (admitted.kind !== "admitted") throw Error();
  f.ledger.launch(conflicting, admitted.token);
  await persistExecution(join(f.jobsRoot, ".artifacts"), { version: 1, identity: conflicting, executorId: "fixture", status: "test_failed", exitCode: 1, completedAt: 10_000 },
   { startedAt: 9_000, log: Buffer.from("x"), truncated: false, outputState: "captured", resources: { state: "skipped", cpuTimeMicros: null, peakMemoryBytes: null } }, { now: () => 10_000 });
  f.ledger.complete(conflicting, admitted.token, { version: 1, identity: conflicting, executorId: "fixture", status: "passed", exitCode: 0, completedAt: 10_000 });
  const active = job(); expect(f.ledger.admit(active).kind).toBe("admitted");
  const codes: [RemoteTestJob, OutboxRefusalReason][] = [[rowless, "rowless"], [revoked, "revoked"], [active, "not_terminal"], [absent, "no_retained_receipt"], [conflicting, "conflict"]];
  for (const [candidate, code] of codes) {
   const refusal = await outbox.enqueueTerminal(candidate).catch((e: unknown) => e);
   expect(refusal).toBeInstanceOf(BusOutboxRefusal);
   expect((refusal as BusOutboxRefusal).code).toBe(code);
  }
  expect(outbox.events()).toEqual([]);
  await expect(outbox.enqueueTerminal({ ...rowless, deadline: 30_000 })).rejects.toBeInstanceOf(BusOutboxRefusal);
  await expect(outbox.enqueueTerminal({ not: "a job" })).rejects.toThrow();
 } finally { f.close(); }
});

test("delivery publishes to the configured stream with a stable id and is durable only after a positive expected PubAck", async () => {
 const f = await fixture(), j = job(); await finish(f, j);
 const outbox = await f.opened(), { calls, publisher } = recorder();
 try {
  const event = await outbox.enqueueTerminal(j);
  const report = await outbox.drain(publisher);
  expect(report).toEqual({ delivered: [event.eventId], withheld: [], failed: [] });
  expect(calls).toHaveLength(1);
  expect(calls[0].expectedStream).toBe(STREAM);
  expect(calls[0].envelope.id).toBe(event.eventId);
  expect(outbox.ackEligible(j.jobId)).toBe(true);
  expect(outbox.events()[0]).toMatchObject({ state: "delivered", failure: null });
  expect(await outbox.drain(publisher)).toEqual({ delivered: [], withheld: [], failed: [] });
  expect(calls).toHaveLength(1);
 } finally { f.close(); }
});

test("publisher failures and unexpected acknowledgements keep the same event replayable and grant no request ack", async () => {
 const f = await fixture(), j = job(); await finish(f, j);
 const outbox = await f.opened();
 try {
  const event = await outbox.enqueueTerminal(j), first = outbox.envelope(event.eventId)!;
  const kinds: MyelinDurablePublishErrorKind[] = ["timeout", "jetstream-error", "stream-mismatch", "domain-mismatch", "sign-failed", "no-signer", "stopped", "disabled", "unroutable"];
  const bad: [string, (e: Envelope) => unknown][] = [
   ...kinds.map((k): [string, (e: Envelope) => unknown] => [k, failing(k)]),
   ["publish_failed", () => new Error("socket reset")],
   ["ack_mismatch", () => ({ stream: "OTHER", seq: 4, duplicate: false, domain: DOMAIN })],
   ["ack_mismatch", () => ({ stream: STREAM, seq: 4, duplicate: false, domain: "elsewhere" })],
   ["ack_mismatch", () => ({ stream: STREAM, seq: 4, duplicate: false })],
   ["ack_mismatch", () => ({ stream: STREAM, seq: 0, duplicate: false, domain: DOMAIN })],
  ];
  let attempts = 0;
  for (const [kind, behaviour] of bad) {
   const { calls, publisher } = recorder(behaviour);
   expect(await outbox.drain(publisher)).toEqual({ delivered: [], withheld: [], failed: [{ eventId: event.eventId, kind }] });
   attempts += 1;
   expect(outbox.events()[0]).toMatchObject({ state: "pending", attempts, failure: kind });
   expect(outbox.ackEligible(j.jobId)).toBe(false);
   expect(calls[0].envelope).toEqual(first);
  }
  const { calls, publisher } = recorder();
  expect((await outbox.drain(publisher)).delivered).toEqual([event.eventId]);
  expect(calls[0].envelope).toEqual(first);
  expect(outbox.ackEligible(j.jobId)).toBe(true);
 } finally { f.close(); }
});

test("a crash after the PubAck but before the local commit replays the event without executing again", async () => {
 let crash = true;
 const f = await fixture(step => { if (step === "acked" && crash) throw Error("crash before local commit"); });
 const j = job(); await finish(f, j);
 const before = f.ledger.status(j);
 let outbox = await f.opened();
 const { calls, publisher } = recorder((_, call) => ({ stream: STREAM, seq: call, duplicate: call > 1, domain: DOMAIN }));
 try {
  const event = await outbox.enqueueTerminal(j);
  await expect(outbox.drain(publisher)).rejects.toThrow("crash before local commit");
  expect(calls).toHaveLength(1);
  outbox.close();
  crash = false;
  outbox = await f.opened();
  expect(outbox.events()).toEqual([event]);
  expect(outbox.ackEligible(j.jobId)).toBe(false);
  expect((await outbox.drain(publisher)).delivered).toEqual([event.eventId]);
  expect(calls).toHaveLength(2);
  expect(calls[1].envelope).toEqual(calls[0].envelope);
  expect(f.ledger.status(j)).toEqual(before);
  expect(await readExecutionReceipt(f.jobsRoot, j, "fixture")).toMatchObject({ status: "passed" });
 } finally { f.close(); }
});

test("a crash at every enqueue transition leaves nothing half-queued and a restart converges on one event", async () => {
 const steps = ["verified", "receipt-write", "file-sync", "publish", "root-sync", "exported", "enqueue"] as const;
 for (const step of steps) {
  let armed = true;
  const f = await fixture(s => { if (s === step && armed) throw Error(`crash at ${step}`); });
  const j = job(); await finish(f, j);
  try {
   let outbox = await f.opened();
   await expect(outbox.enqueueTerminal(j)).rejects.toThrow(`crash at ${step}`);
   expect(outbox.events()).toEqual([]);
   outbox.close();
   armed = false;
   outbox = await f.opened();
   const event = await outbox.enqueueTerminal(j);
   expect(outbox.events()).toEqual([event]);
   const { publisher } = recorder();
   expect((await outbox.drain(publisher)).delivered).toEqual([event.eventId]);
  } finally { f.close(); }
 }
});

test("a store failure inside the queue transaction rolls back", async () => {
 const home = await fixture(), j = job(); await finish(home, j);
 let broken = false;
 const outbox = await openBusOutbox({ bus, root: home.root, jobsRoot: home.jobsRoot, executorId: "fixture", now: () => broken ? 0 : 12_345 });
 try {
  broken = true;
  await expect(outbox.enqueueTerminal(j)).rejects.toThrow("Invalid outbox clock");
  expect(outbox.events()).toEqual([]);
  broken = false;
  expect((await outbox.enqueueTerminal(j)).state).toBe("pending");
 } finally { outbox.close(); home.close(); }
});

test("startup re-verifies retained receipt and ledger evidence and withholds success that is revoked, fenced or no longer backed", async () => {
 const f = await fixture(), outbox = await f.opened(), { calls, publisher } = recorder();
 try {
  const fenced = job(), backed = job(), lost = job(), failed = job();
  for (const j of [fenced, backed, lost]) await finish(f, j);
  await finish(f, failed, "test_failed");
  const events = [];
  for (const j of [fenced, backed, lost, failed]) events.push(await outbox.enqueueTerminal(j));
  outbox.close();
  f.ledger.cancel(fenced);
  f.ledger.cancel(failed);
  await rm(join(f.jobsRoot, ".artifacts", lost.jobId), { recursive: true });
  const restarted = await f.opened();
  const report = await restarted.drain(publisher);
  expect(report.withheld).toEqual([{ eventId: events[0].eventId, code: "revoked" }, { eventId: events[2].eventId, code: "no_retained_receipt" }]);
  expect(report.delivered).toEqual([events[1].eventId, events[3].eventId]);
  expect(calls.map(c => c.envelope.id)).toEqual([events[1].eventId, events[3].eventId]);
  expect(restarted.ackEligible(fenced.jobId)).toBe(false);
  expect(restarted.ackEligible(lost.jobId)).toBe(false);
  expect(restarted.events().map(e => e.state)).toEqual(["withheld", "delivered", "withheld", "delivered"]);
 } finally { f.close(); }
});

test("a refused job from an authorized issuer is retained as provenance and reported failed without a receipt or ledger row", async () => {
 const f = await fixture(), outbox = await f.opened(), j = job();
 try {
  const event = await outbox.enqueueRefusal({ job: j, origin: { issuer: ISSUER, actor: ISSUER }, code: "busy" });
  const envelope = outbox.envelope(event.eventId)!;
  expect(envelope.type).toBe("dispatch.task.failed");
  expect(validateEnvelope(envelope).ok).toBe(true);
  expect(String((envelope.payload).error_summary)).toMatch(new RegExp(`^status=rejected correlation=${j.correlationId} capability=${CI_TEST_CAPABILITY} refusal=busy record=sha256:[0-9a-f]{64}$`));
  expect(await readExecutionReceipt(f.jobsRoot, j, "fixture")).toBeNull();
  expect(f.ledger.recorded(j)).toBe(false);
  expect(f.ledger.status(j)).toBeNull();
  expect(await outbox.enqueueRefusal({ job: j, origin: { issuer: ISSUER }, code: "busy" })).toEqual(event);
  await expect(outbox.enqueueRefusal({ job: j, origin: { issuer: ISSUER }, code: "expired" })).rejects.toBeInstanceOf(BusOutboxRefusal);
  const { calls, publisher } = recorder();
  expect((await outbox.drain(publisher)).delivered).toEqual([event.eventId]);
  expect(calls[0].expectedStream).toBe(STREAM);
  expect(outbox.ackEligible(j.jobId)).toBe(true);
  expect(f.ledger.recorded(j)).toBe(false);
  expect(await readExecutionReceipt(f.jobsRoot, j, "fixture")).toBeNull();
 } finally { f.close(); }
});

test("refusal provenance needs an authorized issuer acting as itself and refuses jobs that have an execution record", async () => {
 const f = await fixture(), outbox = await f.opened(), j = job();
 try {
  await expect(outbox.enqueueRefusal({ job: j, origin: { issuer: "did:myelin:stranger" }, code: "busy" })).rejects.toBeInstanceOf(BusContractRefusal);
  await expect(outbox.enqueueRefusal({ job: j, origin: { issuer: ISSUER, actor: "did:myelin:other" }, code: "busy" })).rejects.toBeInstanceOf(BusContractRefusal);
  await expect(outbox.enqueueRefusal({ job: { ...j, profileDigest: digest("b") }, origin: { issuer: ISSUER }, code: "busy" })).rejects.toBeInstanceOf(BusContractRefusal);
  await expect(outbox.enqueueRefusal({ job: j, origin: { issuer: ISSUER }, code: "nope" as "busy" })).rejects.toThrow();
  const executed = job(); await finish(f, executed);
  const refusal = await outbox.enqueueRefusal({ job: executed, origin: { issuer: ISSUER }, code: "busy" }).catch((e: unknown) => e);
  expect((refusal as BusOutboxRefusal).code).toBe("already_recorded");
  expect(outbox.events()).toEqual([]);
  await outbox.enqueueTerminal(executed);
  await expect(outbox.enqueueRefusal({ job: executed, origin: { issuer: ISSUER }, code: "busy" })).rejects.toBeInstanceOf(BusOutboxRefusal);
  expect(outbox.events()).toHaveLength(1);
 } finally { f.close(); }
});

test("a queued refusal is withheld if the job is admitted before delivery", async () => {
 const f = await fixture(), outbox = await f.opened(), j = job();
 try {
  const event = await outbox.enqueueRefusal({ job: j, origin: { issuer: ISSUER }, code: "busy" });
  await finish(f, j);
  const { calls, publisher } = recorder();
  expect(await outbox.drain(publisher)).toEqual({ delivered: [], withheld: [{ eventId: event.eventId, code: "already_recorded" }], failed: [] });
  expect(calls).toEqual([]);
 } finally { f.close(); }
});

test("the outbox root must be private, separate from the jobs root and bound to one executor, stream and domain", async () => {
 const f = await fixture(), outbox = await f.opened();
 try {
  expect((await stat(f.root)).mode & 0o777).toBe(0o700);
  expect((await stat(join(f.root, "receipts"))).mode & 0o777).toBe(0o700);
  const options = { bus, jobsRoot: f.jobsRoot, executorId: "fixture" };
  await expect(openBusOutbox({ ...options, root: join(f.jobsRoot, "outbox") })).rejects.toThrow("separate");
  await expect(openBusOutbox({ ...options, root: f.home })).rejects.toThrow("separate");
  await expect(openBusOutbox({ ...options, root: f.root, executorId: "other" })).rejects.toThrow("different executor");
  const moved = validateBusConfig({ ...bus, streams: { request: bus.streams.request, result: { stream: "ELSEWHERE" } } });
  await expect(openBusOutbox({ ...options, bus: moved, root: f.root })).rejects.toThrow("different executor, stream or domain");
 } finally { outbox.close(); f.close(); }
});
