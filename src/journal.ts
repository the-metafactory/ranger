import { desc, eq } from "drizzle-orm";
import { openDb, type RangerDb } from "./store/db.ts";
import { events, health, vetoes, workers } from "./store/schema.ts";
import type { RangerConfig } from "./config.ts";
import { expandHome } from "./config.ts";

/**
 * Journal (design §8) — the typed data-access layer over the Drizzle schema.
 * Holds only what the graph cannot: worker liveness/outcomes, the dead-man
 * counter + spawn ledger, the veto cache, and an append-only event log.
 */

export type WorkerStatus =
  | "claimed"
  | "running"
  | "success"
  | "failed"
  | "parked"
  | "released";

export interface WorkerRow {
 nodeId: string;
 repo: string;
 pid: number | null;
 status: WorkerStatus;
 attempts: number;
 worktree: string | null;
 startedAt: string | null;
 finishedAt: string | null;
 outcome: string | null;
 messageId: string | null;
}

export interface EventRow {
 id: number;
 at: string;
 nodeId: string | null;
 repo: string | null;
 kind: string;
 detail: string | null;
}

export type EventKind =
  | "announced"
  | "claimed"
  | "worker-start"
  | "worker-success"
  | "closed"
  | "decisions-written"
  | "refused"
  | "parked"
  | "released"
  | "sweep"
  | "deadman-paused";

const DAY_MS = 24 * 60 * 60 * 1000;

export class Journal {
 private readonly db: RangerDb;
 private readonly closeDb: () => void;

 constructor(path: string) {
  const opened = openDb(path);
  this.db = opened.db;
  this.closeDb = opened.close;
 }

 // ---- workers ----

 upsertWorker(row: Partial<WorkerRow> & Pick<WorkerRow, "nodeId" | "repo" | "status">): void {
  this.db
   .insert(workers)
   .values({
    nodeId: row.nodeId,
    repo: row.repo,
    pid: row.pid ?? null,
    status: row.status,
    attempts: row.attempts ?? 0,
    worktree: row.worktree ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    outcome: row.outcome ?? null,
    messageId: row.messageId ?? null,
   })
   .onConflictDoUpdate({
    target: workers.nodeId,
    set: {
     repo: row.repo,
     pid: row.pid,
     status: row.status,
     attempts: row.attempts,
     worktree: row.worktree,
     startedAt: row.startedAt,
     finishedAt: row.finishedAt,
     outcome: row.outcome,
     messageId: row.messageId,
    },
   })
   .run();
 }

 getWorker(nodeId: string): WorkerRow | null {
  const row = this.db.query.workers.findFirst({
   where: eq(workers.nodeId, nodeId),
  }).sync();
  return row === undefined ? null : hydrateWorker(row);
 }

 listWorkers(repo?: string): WorkerRow[] {
  const rows =
   repo === undefined
    ? this.db.query.workers.findMany().sync()
    : this.db.query.workers.findMany({
       where: eq(workers.repo, repo),
      }).sync();
  return rows.map(hydrateWorker);
 }

 // ---- events ----

 recordEvent(kind: EventKind, opts: { nodeId?: string; repo?: string; detail?: string } = {}): void {
  this.db
   .insert(events)
   .values({
    at: new Date().toISOString(),
    kind,
    nodeId: opts.nodeId ?? null,
    repo: opts.repo ?? null,
    detail: opts.detail ?? null,
   })
   .run();
 }

 listEvents(repo?: string, limit = 50): EventRow[] {
  const base = this.db.select().from(events);
  const query =
   repo === undefined
    ? base.orderBy(desc(events.id)).limit(limit)
    : base.where(eq(events.repo, repo)).orderBy(desc(events.id)).limit(limit);
  const rows = query.all();
  return rows.map(hydrateEvent);
 }

 // ---- health ----

 getHealth(key: string): string | null {
  const row = this.db.query.health.findFirst({
   where: eq(health.key, key),
  }).sync();
  return row?.value ?? null;
 }

 setHealth(key: string, value: string): void {
  this.db
   .insert(health)
   .values({ key, value })
   .onConflictDoUpdate({ target: health.key, set: { value } })
   .run();
 }

 getInt(key: string): number {
  const v = this.getHealth(key);
  return v === null ? 0 : Number.parseInt(v, 10) || 0;
 }

 // ---- dead-man + spawn ledger ----

 /** Consecutive worker failures. Tripping the threshold pauses claiming (§7). */
 deadmanCount(): number {
  return this.getInt("deadman.count");
 }

 resetDeadman(): void {
  this.setHealth("deadman.count", "0");
 }

 bumpDeadman(): number {
  const next = this.deadmanCount() + 1;
  this.setHealth("deadman.count", String(next));
  return next;
 }

 isPaused(): boolean {
  return this.getHealth("paused") === "true";
 }

 setPaused(paused: boolean): void {
  this.setHealth("paused", paused ? "true" : "false");
 }

 /** Day-keyed spawn counter — the global spend bound (§7). */
 spawnsToday(now = new Date()): number {
  return this.getInt(`spawns.${dayKey(now)}`);
 }

 recordSpawn(now = new Date()): void {
  const key = `spawns.${dayKey(now)}`;
  this.setHealth(key, String(this.spawnsToday(now) + 1));
 }

 // ---- vetoes ----

 recordVeto(nodeId: string, commentId: string, detail?: string): void {
  this.db
   .insert(vetoes)
   .values({
    nodeId,
    commentId,
    at: new Date().toISOString(),
    detail: detail ?? null,
   })
   .onConflictDoUpdate({
    target: vetoes.nodeId,
    set: { commentId, at: new Date().toISOString(), detail: detail ?? null },
   })
   .run();
 }

 hasVeto(nodeId: string): boolean {
  const row = this.db.query.vetoes.findFirst({
   where: eq(vetoes.nodeId, nodeId),
  }).sync();
  return row !== undefined;
 }

 /** Prune spawn-ledger keys older than the retention window (keeps health tidy). */
 pruneSpawnLedger(now = new Date(), retentionDays = 30): void {
  const cutoff = dayKey(new Date(now.getTime() - retentionDays * DAY_MS));
  const stale = this.db.select({ key: health.key }).from(health).all().filter((r) =>
   r.key.startsWith("spawns.") && r.key.slice("spawns.".length) < cutoff,
  );
  for (const row of stale) {
   this.db.delete(health).where(eq(health.key, row.key)).run();
  }
 }

 close(): void {
  this.closeDb();
 }
}

function dayKey(date: Date): string {
 return date.toISOString().slice(0, 10);
}

function hydrateWorker(row: {
 nodeId: string;
 repo: string;
 pid: number | null;
 status: string;
 attempts: number;
 worktree: string | null;
 startedAt: string | null;
 finishedAt: string | null;
 outcome: string | null;
 messageId: string | null;
}): WorkerRow {
 return {
  nodeId: row.nodeId,
  repo: row.repo,
  pid: row.pid,
  status: row.status as WorkerStatus,
  attempts: row.attempts,
  worktree: row.worktree,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  outcome: row.outcome,
  messageId: row.messageId,
 };
}

function hydrateEvent(row: {
 id: number;
 at: string;
 nodeId: string | null;
 repo: string | null;
 kind: string;
 detail: string | null;
}): EventRow {
 return {
  id: row.id,
  at: row.at,
  nodeId: row.nodeId,
  repo: row.repo,
  kind: row.kind,
  detail: row.detail,
 };
}

/** Open the configured journal (default from config.state.journalPath). */
export function openJournal(config: RangerConfig): Journal {
 return new Journal(expandHome(config.state.journalPath));
}
