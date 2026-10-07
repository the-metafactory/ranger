import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateOperatorPath } from "./baseline.ts";
import { validateJobIdentity, validateRemoteTestReceipt, type RemoteTestJob, type RemoteTestReceipt } from "./contract.ts";

type Row = { job: string; state: "active" | "interrupted" | "terminal"; attempt: number; token: string; launched: number; receipt: string | null };
export type Admission = { kind: "admitted"; token: string; attempt: number } | { kind: "active"; attempt: number; launched: boolean } | { kind: "terminal"; receipt: RemoteTestReceipt } | { kind: "revoked"; receipt: RemoteTestReceipt };
export class ActiveRemoteTestJob extends Error {
 constructor(readonly status: Extract<Admission, { kind: "active" }>) { super("Remote-test job is active; query status instead of executing again"); }
}
export class InterruptedRemoteTestJob extends Error {
 constructor(readonly attempt: number) { super("Remote-test job was interrupted; explicit recovery may permit one retry"); }
}
export class RemoteTestIdentityConflict extends Error {}
export class RevokedRemoteTestJob extends Error {
 constructor(readonly receipt: RemoteTestReceipt) { super("Remote-test completed outcome is revoked; no accepted success"); }
}
export type JobStatus = Exclude<Admission, { kind: "admitted" }> | { kind: "interrupted"; attempt: number };
export interface OwnedContainer { id: string; ledgerId: string; jobId: string; token: string }
export interface RecoveryAdapters {
 list(): Promise<OwnedContainer[]>;
 remove(id: string): Promise<void>;
 /** Called only after all this ledger's containers are confirmed absent. */
 cleanup(jobs: RemoteTestJob[]): Promise<void>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function encoded(job: RemoteTestJob) { return JSON.stringify(Object.fromEntries(Object.entries(job).sort(([a], [b]) => a.localeCompare(b)))); }
function scope(job: RemoteTestJob) { return JSON.stringify([job.repositoryId, job.correlationId]); }

/** Only openJobLedger constructs this. Its database is a fixed private child
 * of the executor workspace, never the Ranger supervisor journal. All admission
 * and fencing decisions are SQLite IMMEDIATE transactions, across processes. */
export class JobLedger {
 readonly id: string;
 constructor(private db: Database, private directory: string, private executorId: string, private clock: () => number) {
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
  this.tx(() => {
   const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
   if (version !== 0 && version !== 1) throw Error("Unsupported execution ledger schema version");
   if (version === 0) {
    if (db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) throw Error("Unversioned execution ledger schema");
    db.exec(`CREATE TABLE ledger_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, executor TEXT NOT NULL, recovering INTEGER NOT NULL DEFAULT 0);
     CREATE TABLE generations (scope TEXT PRIMARY KEY, generation INTEGER NOT NULL, cancelled INTEGER NOT NULL, changed_at INTEGER NOT NULL);
     CREATE TABLE jobs (id TEXT PRIMARY KEY, job TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL, token TEXT NOT NULL, launched INTEGER NOT NULL, receipt TEXT);
     PRAGMA user_version=1;`);
    db.query("INSERT INTO ledger_meta(singleton,id,executor) VALUES(1,?,?)").run(randomUUID(), executorId);
   }
  });
  const meta = db.query("SELECT id,executor FROM ledger_meta WHERE singleton=1").get() as { id: string; executor: string };
  if (meta.executor !== executorId) { db.close(); throw Error("Execution ledger producer mismatch"); }
  this.id = meta.id;
 }
 close() { this.db.close(); }
 private now() { const n = this.clock(); if (!Number.isSafeInteger(n) || n <= 0) throw Error("Invalid ledger clock"); return n; }
 private tx<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
 private read<T>(fn: () => T): T { return this.db.transaction(fn).deferred(); }
 private row(job: RemoteTestJob): Row | null {
  const row = this.db.query("SELECT * FROM jobs WHERE id=?").get(job.jobId) as Row | null;
  if (row && row.job !== encoded(job)) throw new RemoteTestIdentityConflict("Remote-test identity conflict");
  return row;
 }
 private fence(job: RemoteTestJob, checkExpiry = true): "cancelled" | "timed_out" | "rejected" | undefined {
  const current = this.db.query("SELECT generation,cancelled FROM generations WHERE scope=?").get(scope(job)) as { generation: number; cancelled: number } | null;
  if (current && current.generation > job.generation) return "cancelled";
  if (current?.generation === job.generation && current.cancelled) return "cancelled";
  if (checkExpiry && this.now() >= job.deadline) return "timed_out";
 }
 private refusal(job: RemoteTestJob, status: RemoteTestReceipt["status"]): RemoteTestReceipt {
  const changed = status === "cancelled" ? (this.db.query("SELECT changed_at FROM generations WHERE scope=?").get(scope(job)) as { changed_at: number } | null)?.changed_at : undefined;
  return { version: 1, identity: job, executorId: this.executorId, status, exitCode: null, completedAt: changed ?? (status === "timed_out" ? job.deadline : this.now()) };
 }
 private terminal(job: RemoteTestJob, row: Row): Admission {
  const receipt = validateRemoteTestReceipt(JSON.parse(row.receipt!), job), reason = this.fence(job, false);
  return reason && receipt.status === "passed" ? { kind: "revoked", receipt } : { kind: "terminal", receipt };
 }
 status(input: unknown): JobStatus | null {
  const job = validateJobIdentity(input);
  return this.read(() => {
   const row = this.row(job);
   if (!row) { const reason = this.fence(job, false); return reason ? { kind: "terminal", receipt: this.refusal(job, reason) } : null; }
   if (row.state === "terminal") return this.terminal(job, row) as Extract<Admission, { kind: "terminal" | "revoked" }>;
   const reason = this.fence(job);
   if (reason) return { kind: "terminal", receipt: this.refusal(job, reason) };
   if (row.state === "interrupted") return { kind: "interrupted", attempt: row.attempt };
   return { kind: "active", attempt: row.attempt, launched: !!row.launched };
  });
 }
 recorded(input: unknown) {
  const job = validateJobIdentity(input); return this.read(() => this.row(job) !== null);
 }
 inspectLegacy(input: unknown, value: unknown): JobStatus | null {
  const job = validateJobIdentity(input), receipt = validateRemoteTestReceipt(value, job);
  if (receipt.executorId !== this.executorId) throw Error("Execution ledger producer mismatch");
  return this.read(() => {
   if (this.row(job)) return this.status(job);
   return this.fence(job, false) && receipt.status === "passed" ? { kind: "revoked", receipt } : { kind: "terminal", receipt };
  });
 }
 /** Upgrade a validated private pre-ledger receipt only when there is no
  * recorded attempt. Interrupted attempts can never adopt loose success. */
 adoptLegacy(input: unknown, value: unknown): Admission {
  const job = validateJobIdentity(input), receipt = validateRemoteTestReceipt(value, job);
  if (receipt.executorId !== this.executorId) throw Error("Execution ledger producer mismatch");
  return this.tx(() => {
   const row = this.row(job);
   if (this.recovering()) throw Error("Remote-test recovery fence is active");
   if (row) { if (row.state !== "terminal") throw Error("Cannot adopt receipt for a recorded attempt"); return this.terminal(job, row); }
   const current = this.db.query("SELECT generation FROM generations WHERE scope=?").get(scope(job)) as { generation: number } | null;
   if (!current || job.generation > current.generation) this.db.query("INSERT INTO generations VALUES(?,?,0,?) ON CONFLICT(scope) DO UPDATE SET generation=excluded.generation,cancelled=0,changed_at=excluded.changed_at").run(scope(job), job.generation, this.now());
   this.db.query("INSERT INTO jobs VALUES(?,?,'terminal',0,?,0,?)").run(job.jobId, encoded(job), randomUUID(), JSON.stringify(receipt));
   return this.terminal(job, this.row(job)!);
  });
 }
 admit(input: unknown): Admission {
  const job = validateJobIdentity(input);
  return this.tx(() => {
   const row = this.row(job); // Conflict check precedes every mutation.
   if (this.recovering()) throw Error("Remote-test recovery fence is active");
   if (row?.state === "terminal") return this.terminal(job, row);
   if (row?.state === "active") return { kind: "active", attempt: row.attempt, launched: !!row.launched };
   const current = this.db.query("SELECT generation FROM generations WHERE scope=?").get(scope(job)) as { generation: number } | null;
   if (!current || job.generation > current.generation) this.db.query("INSERT INTO generations VALUES(?,?,0,?) ON CONFLICT(scope) DO UPDATE SET generation=excluded.generation,cancelled=0,changed_at=excluded.changed_at").run(scope(job), job.generation, this.now());
   const reason = this.fence(job);
   const token = randomUUID(), attempt = (row?.attempt ?? 0) + 1;
   const receipt = reason ? this.refusal(job, reason) : attempt > 2 ? this.refusal(job, "infra_failed") : null;
   this.db.query("INSERT INTO jobs VALUES(?,?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,attempt=excluded.attempt,token=excluded.token,launched=0,receipt=excluded.receipt")
    .run(job.jobId, encoded(job), receipt ? "terminal" : "active", attempt, token, receipt ? JSON.stringify(receipt) : null);
   return receipt ? { kind: "terminal", receipt } : { kind: "admitted", attempt, token };
  });
 }
 private recovering() { return !!(this.db.query("SELECT recovering FROM ledger_meta").get() as { recovering: number }).recovering; }
 /** Called immediately before create AND start, without an intervening await. */
 launch(input: unknown, token: string) {
  const job = validateJobIdentity(input);
  this.tx(() => {
   const row = this.row(job);
   if (this.recovering() || !row || row.state !== "active" || row.token !== token || this.fence(job)) throw Error("Remote-test launch fence");
   this.db.query("UPDATE jobs SET launched=1 WHERE id=?").run(job.jobId);
  });
 }
 /** Pollable durable fence; callers abort their container when it changes. */
 allowed(input: unknown, token: string) {
  const job = validateJobIdentity(input);
  return this.read(() => { const row = this.row(job); return !this.recovering() && row?.state === "active" && row.token === token && !this.fence(job); });
 }
 cancel(input: unknown) {
  const job = validateJobIdentity(input);
  this.tx(() => {
   const row = this.row(job);
   const current = this.db.query("SELECT generation,cancelled FROM generations WHERE scope=?").get(scope(job)) as { generation: number; cancelled: number } | null;
   if (!current || current.generation < job.generation || current.generation === job.generation && !current.cancelled) this.db.query("INSERT INTO generations VALUES(?,?,1,?) ON CONFLICT(scope) DO UPDATE SET generation=excluded.generation,cancelled=1,changed_at=excluded.changed_at").run(scope(job), job.generation, this.now());
   if (!row) this.db.query("INSERT INTO jobs VALUES(?,?,'terminal',0,?,0,?)").run(job.jobId, encoded(job), randomUUID(), JSON.stringify(this.refusal(job, "cancelled")));
  });
 }
 /** A thrown execution is uncertain, never still reported as a live owner.
  * Cleanup must reconcile before another admission can use the retry allowance. */
 interrupt(input: unknown, token: string) {
  const job = validateJobIdentity(input);
  this.tx(() => {
   const row = this.row(job);
   if (!row || row.state !== "active" || row.token !== token) return;
   this.db.query("UPDATE jobs SET state='interrupted' WHERE id=?").run(job.jobId);
   this.db.exec("UPDATE ledger_meta SET recovering=1");
  });
 }
 /** Artifact persistence must precede this commit. Historical artifact bytes
 * are not authoritative; only this fenced terminal receipt may be exported. */
 complete(input: unknown, token: string, value: unknown): RemoteTestReceipt {
  const job = validateJobIdentity(input), receipt = validateRemoteTestReceipt(value, job);
  if (receipt.executorId !== this.executorId) throw Error("Execution ledger producer mismatch");
  return this.tx(() => {
   const row = this.row(job);
   if (this.recovering() || !row || row.state !== "active" || row.token !== token) throw Error("Remote-test attempt fence");
   const reason = this.fence(job), accepted = reason ? this.refusal(job, reason) : receipt;
   if (accepted.status === "passed" && !row.launched) throw Error("Remote-test success without launch");
   this.db.query("UPDATE jobs SET state='terminal',receipt=? WHERE id=?").run(JSON.stringify(accepted), job.jobId);
   return accepted;
  });
 }
 /** Explicit restart operation, only with the former executor stopped. It
 * fences all old attempts BEFORE engine I/O; a failed cleanup stays fenced.
 * Never recovers success from an exited container or a loose artifact file. */
 async reconcile(adapters: RecoveryAdapters) {
  const lock = join(this.directory, "recovery-lock");
  await mkdir(lock, { mode: 0o700 });
  try {
   this.tx(() => { this.db.exec("UPDATE ledger_meta SET recovering=1; UPDATE jobs SET state='interrupted' WHERE state='active';"); });
   const owned = (containers: OwnedContainer[]) => containers.filter(c => c.ledgerId === this.id).map(c => {
    if (!/^[a-f0-9]{64}$/.test(c.id) || !uuid.test(c.jobId) || !uuid.test(c.token)) throw Error("Invalid owned container labels"); return c;
   });
   for (const container of owned(await adapters.list())) await adapters.remove(container.id);
   if (owned(await adapters.list()).length) throw Error("Owned containers remain after recovery");
   const jobs = (this.db.query("SELECT job FROM jobs").all() as { job: string }[]).map(r => validateJobIdentity(JSON.parse(r.job)));
   await adapters.cleanup(jobs);
   this.tx(() => {
    for (const job of jobs) {
     const row = this.row(job)!; if (row.state !== "interrupted") continue;
     const reason = this.fence(job);
     if (reason || row.attempt >= 2) this.db.query("UPDATE jobs SET state='terminal',receipt=? WHERE id=?").run(JSON.stringify(this.refusal(job, reason ?? "infra_failed")), job.jobId);
    }
    this.db.exec("UPDATE ledger_meta SET recovering=0");
   });
  } finally { await rm(lock, { recursive: true }); }
 }
}

export async function openJobLedger(jobsRoot: string, executorId: string, clock: () => number = Date.now): Promise<JobLedger> {
 if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(executorId)) throw Error("Invalid ledger executor identity");
 const root = await realpath(jobsRoot), rootInfo = await lstat(root);
 if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o022)) throw Error("Unsafe execution jobs root");
 const directory = await privateOperatorPath(join(root, ".execution"));
 try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 const info = await lstat(directory);
 if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw Error("Unsafe execution ledger directory");
 const path = join(directory, "ledger.sqlite");
 try { const file = await open(path, "wx", 0o600); try { await file.sync(); } finally { await file.close(); } }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try { const s = await file.stat(); if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.nlink !== 1) throw Error("Unsafe execution ledger file"); } finally { await file.close(); }
 for (const parent of [directory, root]) {
  const handle = await open(parent, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
 }
 // No migrations or imports from src/store: this database has its own schema.
 const db = new Database(path, { strict: true });
 try { return new JobLedger(db, directory, executorId, clock); } catch (e) { try { db.close(); } catch {} throw e; }
}
