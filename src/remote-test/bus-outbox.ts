import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
 createDispatchTaskAbortedEvent, createDispatchTaskCompletedEvent, createDispatchTaskFailedEvent,
 MyelinDurablePublishError, type Envelope, type MyelinRuntime,
} from "@the-metafactory/cortex/bus";
import { z } from "zod";
import { InvalidStoredRemoteTestReceipt, privateDirectory, publishReceiptFile, readExecutionReceipt, syncDirectory, type FaultStep } from "./artifacts.ts";
import { privateOperatorPath } from "./baseline.ts";
import { authorizeBusProducer, validateBusConfig, type BusConfig } from "./bus-contract.ts";
import { NameSchema, validateJobIdentity, type RemoteTestJob, type RemoteTestReceipt, type RemoteTestStatus } from "./contract.ts";
import { openJobLedger, RemoteTestIdentityConflict } from "./job-ledger.ts";

export const CI_TEST_CAPABILITY = "ci-test";
const AGENT_ID = "ranger";
const DRAIN_BATCH = 32;

const LIFECYCLE = {
 passed: "completed", test_failed: "failed", infra_failed: "failed", rejected: "failed", timed_out: "aborted", cancelled: "aborted",
} as const satisfies Record<RemoteTestStatus, "completed" | "failed" | "aborted">;

export const RefusalCodeSchema = z.enum(["expired", "busy", "source_rejected", "profile_rejected", "internal"]);
export type RefusalCode = z.infer<typeof RefusalCodeSchema>;

export type OutboxRefusalReason = "rowless" | "not_terminal" | "revoked" | "no_retained_receipt" | "conflict" | "already_recorded";
export class BusOutboxRefusal extends Error {
 constructor(readonly code: OutboxRefusalReason, message: string) { super(message); }
}

export type OutboxStep = "verified" | "exported" | "enqueue" | "publish" | "acked";
export type OutboxFault = (step: OutboxStep | FaultStep) => void | Promise<void>;
export interface DurablePublisher { publishDurable: NonNullable<MyelinRuntime["publishDurable"]> }

export interface BusOutboxOptions {
 bus: BusConfig;
 root: string;
 jobsRoot: string;
 executorId: string;
 now?: () => number;
 fault?: OutboxFault;
}
export type OutboxState = "pending" | "delivered" | "withheld";
export interface OutboxEvent { eventId: string; jobId: string; origin: "receipt" | "refusal"; state: OutboxState; attempts: number; failure: string | null }
export interface DrainReport {
 delivered: string[];
 withheld: { eventId: string; code: OutboxRefusalReason }[];
 failed: { eventId: string; kind: string }[];
}

interface EventRow {
 id: string; jobid: string; origin: "receipt" | "refusal"; job: string; evidence: string; envelope: string;
 state: OutboxState; attempts: number; failure: string | null;
}

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const receiptBytes = (receipt: RemoteTestReceipt) => JSON.stringify(receipt) + "\n";
const contains = (parent: string, child: string) => { const path = relative(parent, child); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };

function lifecycleEnvelope(bus: BusConfig, status: RemoteTestStatus, job: RemoteTestJob, startedAt: number, endedAt: number, summary: string): Envelope {
 const common = {
  source: { principal: bus.routing.principal, agent: AGENT_ID, instance: bus.routing.stack },
  taskId: job.jobId, agentId: AGENT_ID, correlationId: job.correlationId, classification: bus.routing.classification,
 };
 const started = new Date(startedAt), ended = new Date(endedAt);
 switch (LIFECYCLE[status]) {
  case "completed": return createDispatchTaskCompletedEvent({ ...common, startedAt: started, completedAt: ended, resultSummary: summary });
  case "failed": return createDispatchTaskFailedEvent({ ...common, startedAt: started, failedAt: ended, errorSummary: summary });
  case "aborted": return createDispatchTaskAbortedEvent({ ...common, startedAt: started, abortedAt: ended, reason: summary });
 }
}
const summaryOf = (status: RemoteTestStatus, job: RemoteTestJob, reference: string) =>
 `status=${status} correlation=${job.correlationId} capability=${CI_TEST_CAPABILITY} ${reference}`;

async function openStoreFile(directory: string): Promise<string> {
 const path = join(directory, "outbox.sqlite");
 try { const created = await open(path, "wx", 0o600); try { await created.sync(); } finally { await created.close(); } }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const info = await file.stat();
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.nlink !== 1) throw Error("Unsafe outbox store file");
 } finally { await file.close(); }
 await syncDirectory(directory);
 return path;
}

/** The terminal-lifecycle outbox. Its SQLite store is private and separate from
 * the executor ledger; it only reads ledger and receipt evidence and never
 * admits, completes or executes a job. A row is delivered only after a positive
 * PubAck from the configured result stream and domain; every other outcome
 * leaves the row replayable. */
export class BusOutbox {
 constructor(private db: Database, private options: Required<Pick<BusOutboxOptions, "bus" | "root" | "jobsRoot" | "executorId">> & { now: () => number; fault?: OutboxFault }) {
  db.run("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
  const { executorId, bus } = options;
  this.tx(() => {
   const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
   if (version !== 0 && version !== 1) throw Error("Unsupported outbox schema version");
   if (version === 0) {
    if (db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) throw Error("Unversioned outbox schema");
    db.run(`CREATE TABLE outbox_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), executor TEXT NOT NULL, stream TEXT NOT NULL, domain TEXT NOT NULL);
     CREATE TABLE events (id TEXT PRIMARY KEY, jobid TEXT NOT NULL UNIQUE, origin TEXT NOT NULL CHECK(origin IN ('receipt','refusal')), job TEXT NOT NULL, evidence TEXT NOT NULL, envelope TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','delivered','withheld')), attempts INTEGER NOT NULL DEFAULT 0, failure TEXT, stream TEXT, seq INTEGER, queued INTEGER NOT NULL, delivered INTEGER);
     CREATE TABLE refusals (jobid TEXT PRIMARY KEY, issuer TEXT NOT NULL, code TEXT NOT NULL, job TEXT NOT NULL, recorded INTEGER NOT NULL);
     PRAGMA user_version=1;`);
    db.query("INSERT INTO outbox_meta VALUES(1,?,?,?)").run(executorId, bus.streams.result.stream, bus.target.domain);
   }
   db.run("CREATE INDEX IF NOT EXISTS events_state ON events(state)");
  });
  const meta = db.query("SELECT executor,stream,domain FROM outbox_meta WHERE singleton=1").get() as { executor: string; stream: string; domain: string };
  if (meta.executor !== executorId || meta.stream !== bus.streams.result.stream || meta.domain !== bus.target.domain) { throw Error("Outbox store is bound to a different executor, stream or domain"); }
 }
 close() { this.db.close(); }
 private tx<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
 private async step(step: OutboxStep) { await this.options.fault?.(step); }
 private now() { const n = this.options.now(); if (!Number.isSafeInteger(n) || n <= 0) throw Error("Invalid outbox clock"); return n; }

 private async authoritativeReceipt(input: unknown): Promise<{ job: RemoteTestJob; receipt: RemoteTestReceipt }> {
  const job = validateJobIdentity(input), { jobsRoot, executorId, now } = this.options;
  const ledger = await openJobLedger(jobsRoot, executorId, now);
  try {
   const settled = (): RemoteTestReceipt => {
    let state;
    try {
     if (!ledger.recorded(job)) throw new BusOutboxRefusal("rowless", "No ledger row backs this job");
     state = ledger.status(job);
    } catch (e) { if (e instanceof RemoteTestIdentityConflict) throw new BusOutboxRefusal("conflict", "Ledger identity conflict"); throw e; }
    if (state?.kind === "revoked") throw new BusOutboxRefusal("revoked", "Ledger outcome is revoked");
    if (state?.kind !== "terminal") throw new BusOutboxRefusal("not_terminal", "Ledger outcome is not terminal");
    return state.receipt;
   };
   settled();
   let retained: RemoteTestReceipt | null;
   try { retained = await readExecutionReceipt(jobsRoot, job, executorId); }
   catch (e) { if (e instanceof InvalidStoredRemoteTestReceipt) throw new BusOutboxRefusal("conflict", "Retained receipt is invalid"); throw e; }
   if (!retained) throw new BusOutboxRefusal("no_retained_receipt", "No retained receipt backs this job");
   const current = settled();
   if (receiptBytes(current) !== receiptBytes(retained)) throw new BusOutboxRefusal("conflict", "Retained receipt differs from the ledger outcome");
   return { job, receipt: current };
  } finally { ledger.close(); }
 }

 private async assertNotAdmitted(job: RemoteTestJob) {
  const ledger = await openJobLedger(this.options.jobsRoot, this.options.executorId, this.options.now);
  try {
   if (ledger.recorded(job) || await readExecutionReceipt(this.options.jobsRoot, job, this.options.executorId)) throw new BusOutboxRefusal("already_recorded", "Job has an execution record");
  } catch (e) {
   if (e instanceof BusOutboxRefusal) throw e;
   if (e instanceof RemoteTestIdentityConflict || e instanceof InvalidStoredRemoteTestReceipt) throw new BusOutboxRefusal("already_recorded", "Job has an execution record");
   throw e;
  } finally { ledger.close(); }
 }

 private async exportReceipt(receipt: RemoteTestReceipt): Promise<string> {
  const bytes = receiptBytes(receipt), path = join(this.options.root, "receipts", `${receipt.identity.jobId}.json`);
  try { await publishReceiptFile(path, receipt, this.options.fault); }
  catch (e) {
   if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
   if (await readFile(path, "utf8") !== bytes) throw new BusOutboxRefusal("conflict", "Exported receipt differs from the ledger outcome");
  }
  return sha256(bytes);
 }

 private insert(origin: EventRow["origin"], job: RemoteTestJob, evidence: string, build: () => Envelope, extra?: () => void): OutboxEvent {
  const encoded = JSON.stringify(job);
  return this.tx(() => {
   const existing = this.db.query("SELECT * FROM events WHERE jobid=?").get(job.jobId) as EventRow | null;
   if (existing) {
    const supersedes = existing.state === "withheld" && existing.origin === "refusal" && origin === "receipt" && existing.job === encoded;
    if (!supersedes) {
     if (existing.origin !== origin || existing.job !== encoded || existing.evidence !== evidence) throw new BusOutboxRefusal("conflict", "A different lifecycle event is already queued for this job");
     return eventOf(existing);
    }
    this.db.query("DELETE FROM events WHERE id=?").run(existing.id);
   }
   const envelope = build();
   extra?.();
   this.db.query("INSERT INTO events(id,jobid,origin,job,evidence,envelope,state,attempts,queued) VALUES(?,?,?,?,?,?,'pending',0,?)")
    .run(envelope.id, job.jobId, origin, encoded, evidence, JSON.stringify(envelope), this.now());
   return eventOf(this.db.query("SELECT * FROM events WHERE jobid=?").get(job.jobId) as EventRow);
  });
 }

 async enqueueTerminal(input: unknown): Promise<OutboxEvent> {
  const { job, receipt } = await this.authoritativeReceipt(input);
  await this.step("verified");
  const digest = await this.exportReceipt(receipt);
  await this.step("exported");
  await this.step("enqueue");
  const started = receipt.evidence?.startedAt ?? receipt.completedAt;
  return this.insert("receipt", job, digest, () => lifecycleEnvelope(this.options.bus, receipt.status, job, started, receipt.completedAt, summaryOf(receipt.status, job, `receipt=${digest}`)));
 }

 async enqueueRefusal(input: { job: unknown; origin: { issuer: string; actor?: string }; code: RefusalCode }): Promise<OutboxEvent> {
  const job = validateJobIdentity(input.job), code = RefusalCodeSchema.parse(input.code);
  authorizeBusProducer(this.options.bus, input.origin, job);
  await this.assertNotAdmitted(job);
  await this.step("verified");
  await this.step("enqueue");
  const digest = sha256(JSON.stringify({ job, issuer: input.origin.issuer, code }));
  const at = this.now();
  return this.insert("refusal", job, digest, () => lifecycleEnvelope(this.options.bus, "rejected", job, at, at, summaryOf("rejected", job, `refusal=${code} record=${digest}`)),
   () => { this.db.query("INSERT INTO refusals VALUES(?,?,?,?,?)").run(job.jobId, input.origin.issuer, code, JSON.stringify(job), at); });
 }

 private async reverify(row: EventRow) {
  const job = validateJobIdentity(JSON.parse(row.job));
  if (row.origin === "refusal") { await this.assertNotAdmitted(job); return; }
  const { receipt } = await this.authoritativeReceipt(job);
  if (sha256(receiptBytes(receipt)) !== row.evidence) throw new BusOutboxRefusal("conflict", "Current receipt differs from the queued evidence");
 }

 private settle(sql: string, ...params: (string | number)[]) { this.tx(() => { this.db.query(sql).run(...params); }); }

 async drain(publisher: DurablePublisher, options: { timeoutMs?: number } = {}): Promise<DrainReport> {
  const report: DrainReport = { delivered: [], withheld: [], failed: [] };
  const { stream, domain } = { stream: this.options.bus.streams.result.stream, domain: this.options.bus.target.domain };
  let cursor = 0;
  for (;;) {
   const batch = this.db.query("SELECT rowid AS rid, * FROM events WHERE state='pending' AND rowid>? ORDER BY rowid LIMIT ?").all(cursor, DRAIN_BATCH) as (EventRow & { rid: number })[];
   if (batch.length === 0) return report;
   for (const row of batch) {
    cursor = row.rid;
    await this.step("publish");
    try { await this.reverify(row); }
    catch (e) {
     if (e instanceof BusOutboxRefusal) { this.settle("UPDATE events SET state='withheld',failure=? WHERE id=? AND state='pending'", e.code, row.id); report.withheld.push({ eventId: row.id, code: e.code }); continue; }
     this.settle("UPDATE events SET attempts=attempts+1,failure='evidence_unavailable' WHERE id=? AND state='pending'", row.id);
     report.failed.push({ eventId: row.id, kind: "evidence_unavailable" });
     continue;
    }
    let failure: string | undefined, ack: Awaited<ReturnType<DurablePublisher["publishDurable"]>> | undefined;
    try {
     ack = await publisher.publishDurable(JSON.parse(row.envelope) as Envelope, { expectedStream: stream, ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }) });
     if (ack.stream !== stream || ack.domain !== domain || !Number.isSafeInteger(ack.seq) || ack.seq <= 0) failure = "ack_mismatch";
    } catch (e) { failure = e instanceof MyelinDurablePublishError ? e.kind : "publish_failed"; }
    if (failure || !ack) {
     failure ??= "publish_failed";
     this.settle("UPDATE events SET attempts=attempts+1,failure=? WHERE id=? AND state='pending'", failure, row.id);
     report.failed.push({ eventId: row.id, kind: failure });
     return report;
    }
    await this.step("acked");
    this.settle("UPDATE events SET state='delivered',failure=NULL,stream=?,seq=?,delivered=? WHERE id=? AND state='pending'", ack.stream, ack.seq, this.now(), row.id);
    report.delivered.push(row.id);
   }
  }
 }

 ackEligible(jobId: string): boolean {
  return (this.db.query("SELECT state FROM events WHERE jobid=?").get(jobId) as { state: OutboxState } | null)?.state === "delivered";
 }
 events(): OutboxEvent[] { return (this.db.query("SELECT * FROM events ORDER BY rowid").all() as EventRow[]).map(eventOf); }
 envelope(eventId: string): Envelope | null {
  const row = this.db.query("SELECT envelope FROM events WHERE id=?").get(eventId) as { envelope: string } | null;
  return row ? JSON.parse(row.envelope) as Envelope : null;
 }
}

function eventOf(row: EventRow): OutboxEvent {
 return { eventId: row.id, jobId: row.jobid, origin: row.origin, state: row.state, attempts: row.attempts, failure: row.failure };
}

export async function openBusOutbox(options: BusOutboxOptions): Promise<BusOutbox> {
 const bus = validateBusConfig(options.bus), executorId = NameSchema.parse(options.executorId);
 const jobsRoot = await realpath(options.jobsRoot);
 const root = await privateOperatorPath(options.root);
 try { await mkdir(root, { mode: 0o700 }); await syncDirectory(dirname(root)); }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 await privateDirectory(root);
 const real = await realpath(root);
 if (contains(jobsRoot, real) || contains(real, jobsRoot)) throw Error("Outbox root must be separate from the executor jobs root");
 const receipts = join(real, "receipts");
 try { await mkdir(receipts, { mode: 0o700 }); await syncDirectory(real); }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 await privateDirectory(receipts);
 const db = new Database(await openStoreFile(real), { strict: true });
 try { return new BusOutbox(db, { bus, root: real, jobsRoot, executorId, now: options.now ?? Date.now, fault: options.fault }); }
 catch (e) { db.close(); throw e; }
}
