import { journalKeyFor } from "./forge-ref.ts";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { openDb, openDbReadOnly, type RangerDb } from "./store/db.ts";
import { seedLegacyRoots } from "./store/legacy-roots.ts";
import {
 escalations,
 escalationDestinations,
 events,
 headSubstrates,
 health,
 substrateReadings,
 substrateSessions,
 type SessionKind,
 type SessionOutcome,
 type SubstrateName,
 vetoes,
 workers,
} from "./store/schema.ts";
import type { RangerConfig } from "./config.ts";
import { expandHome } from "./config.ts";
import { holdsImplementLane, workerLane, type ImplementLane, type LaneMap } from "./lanes.ts";
import { assertNotLiveJournalUnderTest } from "./journal-guard.ts";

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
 | "released"
 /** Implement lane: PR ready, waiting on the principal's one-tap merge. */
 | "awaiting-merge";

/** Implement-lane phases (F2, #23 amendment) — GitHub wins on resume. */
export type ImplementPhase = "implement" | "review" | "awaiting-merge" | "close";

export interface WorkerRow {
 nodeId: string;
 root: number;
 repo: string;
 pid: number | null;
 status: WorkerStatus;
 attempts: number;
 worktree: string | null;
 startedAt: string | null;
 finishedAt: string | null;
 outcome: string | null;
 messageId: string | null;
 lane: string | null;
 generation: number;
 workerPgid: number | null;
 phase: ImplementPhase | null;
 prNumber: number | null;
 researchBaseSha: string | null;
 reviewRound: number;
 verdictSha: string | null;
 verdictBlockers: number | null;
 mergeMessageId: string | null;
 /** The substrate the worker ran on (claude | codex | pi). */
 substrate: SubstrateName | null;
}

/** Fields a supervisor may update in place on its own row. */
export type WorkerPatch = Partial<
 Omit<WorkerRow, "nodeId" | "repo" | "root" | "generation">
>;

/**
 * Thrown when a supervisor's generation is no longer the row's — a newer
 * run-node took the node over, so this occupant must stop before any outward
 * action (the OpenRig occupant-generation pattern, #23 amendment F1).
 */
export class FencedError extends Error {
 override readonly name = "FencedError";
}

export interface EventRow {
 id: number;
 at: string;
 nodeId: string | null;
 repo: string | null;
 kind: string;
 detail: string | null;
}

export interface SubstrateReading {
 substrate: SubstrateName;
 readAt: string;
 fiveHourUsedPct: number | null;
 sevenDayUsedPct: number | null;
 fiveHourResetsAt: string | null;
 sevenDayResetsAt: string | null;
 resetsAt: string | null;
 capped: boolean;
 cappedUntil: string | null;
}

/** One substrate session (node #56): a build, a fix pass or a sage round. */
export interface SubstrateSessionRow {
 id: number;
 substrate: SubstrateName;
 kind: SessionKind;
 repo: string;
 nodeId: string;
 /** The supervisor generation that opened the row. */
 generation: number;
 startedAt: string;
 endedAt: string | null;
 outcome: SessionOutcome | null;
}

export interface EscalationRow {
 /** `${repo}:${nodeId}` */
 key: string;
 root: number;
 repo: string;
 nodeId: string;
 title: string | null;
 /** §3 route class at last post/edit — escalate-hitl | provisioning. */
 route: string | null;
 /** Content last sent to Discord — edit-on-change skips identical re-edits. */
 lastContent: string | null;
 /** Discord channel the card lives in — a moved destination reposts. */
 channelId: string | null;
 messageId: string;
 createdAt: string;
 lastEditedAt: string | null;
 /** open | closed — the write-side (node #21) transitions a card to closed
  *  on a principal response or operator verb; the desk only ever writes open.
  *  (Unified vocabulary, round-27 review — the design contract is open →
  *  closed.) */
 status: "open" | "closed";
 /** When the queue-exit note was written (bounds the absent-card scan). */
 notedAt: string | null;
}

export type EventKind =
 | "announced"
 | "claimed"
 | "worker-start"
 | "worker-success"
 | "closed"
 | "decisions-written"
 | "decisions-failed"
 | "refused"
 | "parked"
 | "released"
 | "sweep"
 | "deadman-paused"
 | "fenced"
 | "pushed"
 | "pr-opened"
 | "ci-passed"
 | "reviewed"
 | "awaiting-merge"
 | "merge-card"
 | "merged"
 | "orphan-killed"
 | "substrate-capped"
 | "transient"
 | "git-trust"
 | "log-failed";

/** The health-store key of a checkout's known-good git state (`knownGoodGitState`). */
const knownGoodGitKey = (canonical: string): string => `git.known-good.${canonical}`;

const rootFilter = (column: typeof workers.root | typeof escalations.root, root?: number) => root === undefined ? undefined : eq(column, root);

const DAY_MS = 24 * 60 * 60 * 1000;

export class Journal {
 private readonly db: RangerDb;
 private readonly closeDb: () => void;
 /** The sqlite file path — callers derive sibling lock/state dirs from it. */
 readonly path: string;

 constructor(
  path: string,
  opened?: { db: RangerDb; close: () => void },
  private readonly maps: readonly LaneMap[] = [],
  legacyMapRoots: Readonly<Record<string, number>> = {},
 ) {
  // Under test, the live journal is out of reach (node #66).
  assertNotLiveJournalUnderTest(expandHome(path));
  this.path = path;
  const connection = opened ?? openDb(path, sqlite => seedLegacyRoots(sqlite, maps, legacyMapRoots));
  this.db = connection.db;
  this.closeDb = connection.close;
 }

 /**
  * The journal for a reader that must not write it (#37, `ranger serve`):
  * `null` when no journal exists yet. Calling a write method on it throws
  * SQLITE_READONLY rather than touching the file.
  */
 static openReadOnly(path: string, maps: readonly LaneMap[] = []): Journal | null {
  const opened = openDbReadOnly(path);
  return opened === null ? null : new Journal(path, opened, maps);
 }

 // ---- workers ----

 assertWorkerRoot(nodeId: string, repo: string, root: number): void {
  const existing = this.getWorker(nodeId, repo);
  if (existing !== null && existing.root !== root) {
   throw new Error(`node ${repo}#${nodeId} already belongs to map ${repo}#${existing.root}; refusing to move it to map ${repo}#${root}`);
  }
 }

 upsertWorker(
  row: Partial<WorkerRow> & Pick<WorkerRow, "nodeId" | "repo" | "root" | "status">,
 ): void {
  this.assertWorkerRoot(row.nodeId, row.repo, row.root);
  this.db
   .insert(workers)
   .values({
    nodeId: row.nodeId,
    repo: row.repo,
    root: row.root,
    pid: row.pid ?? null,
    status: row.status,
    attempts: row.attempts ?? 0,
    worktree: row.worktree ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    outcome: row.outcome ?? null,
    messageId: row.messageId ?? null,
    lane: row.lane ?? null,
    workerPgid: row.workerPgid ?? null,
    phase: row.phase ?? null,
    prNumber: row.prNumber ?? null,
    researchBaseSha: row.researchBaseSha ?? null,
    reviewRound: row.reviewRound ?? 0,
    verdictSha: row.verdictSha ?? null,
    verdictBlockers: row.verdictBlockers ?? null,
    mergeMessageId: row.mergeMessageId ?? null,
    substrate: row.substrate ?? null,
   })
   .onConflictDoUpdate({
    target: [workers.repo, workers.nodeId],
    set: {
     pid: row.pid,
     status: row.status,
     attempts: row.attempts,
     worktree: row.worktree,
     startedAt: row.startedAt,
     finishedAt: row.finishedAt,
     outcome: row.outcome,
     messageId: row.messageId,
     lane: row.lane,
     workerPgid: row.workerPgid,
     phase: row.phase,
     prNumber: row.prNumber,
     researchBaseSha: row.researchBaseSha,
     reviewRound: row.reviewRound,
     verdictSha: row.verdictSha,
     verdictBlockers: row.verdictBlockers,
     mergeMessageId: row.mergeMessageId,
     substrate: row.substrate,
    },
   })
   .run();
 }

 /**
  * Patch fields on an existing row. Unlike upsertWorker this never inserts and
  * never touches a field the patch omits, so a phase update cannot null a PID
  * or a message id by accident (the worker.ts pid:null bug, #23 F1).
  */
 updateWorker(nodeId: string, repo: string, patch: WorkerPatch): void {
  const set = Object.fromEntries(
   Object.entries(patch).filter(([, v]) => v !== undefined),
  );
  if (Object.keys(set).length === 0) return;
  this.db.update(workers).set(set).where(and(eq(workers.nodeId, nodeId), eq(workers.repo, repo))).run();
 }

 /**
  * Take the node as a new occupant: bump and return its generation. Every
  * run-node start calls this once; the row must exist (the claim made it).
  */
 beginGeneration(nodeId: string, repo: string): number {
  const rows = this.db
   .update(workers)
   .set({ generation: sql`${workers.generation} + 1` })
   .where(and(eq(workers.nodeId, nodeId), eq(workers.repo, repo)))
   .returning({ generation: workers.generation })
   .all();
  if (rows.length === 0) {
   throw new FencedError(
    `node ${nodeId} has no worker row — run-node needs the claim's row to take a generation`,
   );
  }
  return rows[0].generation;
 }

 /**
  * The fence: throw unless `generation` is still the row's. Called before
  * every outward action (push, PR, review, ready, close, decisions). The
  * journal is a single-host SQLite file, so this is sound for supervisors on
  * this host; the window between check and action is milliseconds.
  */
 assertGeneration(nodeId: string, repo: string, generation: number, action: string): void {
  const row = this.getWorker(nodeId, repo);
  if (row === null || row.generation !== generation) {
   throw new FencedError(
    `node ${nodeId}: generation ${generation} superseded by ${row?.generation ?? "a removed row"} — refusing to ${action}`,
   );
  }
 }

 /**
  * One claimed/running implement worker per resource lane across all maps.
  * Excluding an occupant requires its repo as well as node id.
  * Unknown or ambiguous maps conservatively hold both resource lanes.
  */
 laneHolder(
  lane: ImplementLane,
  except?: { nodeId: string; repo: string },
  isActive: (worker: WorkerRow) => boolean = () => true,
 ): WorkerRow | null {
  return (
   this.listWorkers().find((w) => {
    if (w.nodeId === except?.nodeId && w.repo === except?.repo) return false;
    if (!holdsImplementLane(w)) return false;
    if (!isActive(w)) return false;
    const resource = workerLane(w, this.maps);
    return resource === lane || resource === null;
   }) ?? null
  );
 }

 getWorker(nodeId: string, repo: string): WorkerRow | null {
  const row = this.db.query.workers
   .findFirst({
    where: and(eq(workers.nodeId, nodeId), eq(workers.repo, repo)),
   })
   .sync();
  return row === undefined ? null : hydrateWorker(row);
 }

 listWorkers(repo?: string, root?: number): WorkerRow[] {
  const rows =
   repo === undefined
    ? this.db.query.workers.findMany().sync()
    : this.db.query.workers
       .findMany({
        where: and(eq(workers.repo, repo), rootFilter(workers.root, root)),
       })
       .sync();
  return rows.map(hydrateWorker);
 }

 // ---- events ----

 recordEvent(
  kind: EventKind,
  opts: { nodeId?: string; repo?: string; detail?: string } = {},
 ): void {
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

 /** One node's events, newest first (node #54: the dashboard's reason class). */
 listNodeEvents(repo: string, nodeId: string, limit = 60): EventRow[] {
  return this.db
   .select()
   .from(events)
   .where(and(eq(events.repo, repo), eq(events.nodeId, nodeId)))
   .orderBy(desc(events.id))
   .limit(limit)
   .all()
   .map(hydrateEvent);
 }

 // ---- health ----

 getHealth(key: string): string | null {
  const row = this.db.query.health
   .findFirst({
    where: eq(health.key, key),
   })
   .sync();
  return row?.value ?? null;
 }

 setHealth(key: string, value: string): void {
  this.db
   .insert(health)
   .values({ key, value })
   .onConflictDoUpdate({ target: health.key, set: { value } })
   .run();
 }

 // ---- known-good git state (node #81) ----

 /**
  * The canonical checkout's known-good git state record (`git-trust.ts`):
  * the chain-of-trust anchor, one per checkout, opaque JSON. Its own
  * accessor so the anchor is never read or pruned as a health counter.
  */
 knownGoodGitState(canonical: string): string | null {
  return this.getHealth(knownGoodGitKey(canonical));
 }

 setKnownGoodGitState(canonical: string, record: string): void {
  this.setHealth(knownGoodGitKey(canonical), record);
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

 /** Every vetoed node id, in one query (#37: `ranger serve` reads them per poll). */
 listVetoes(): Set<string> {
  return new Set(
   this.db.query.vetoes.findMany({ columns: { nodeId: true } }).sync().map((v) => v.nodeId),
  );
 }

 hasVeto(nodeId: string): boolean {
  const row = this.db.query.vetoes
   .findFirst({
    where: eq(vetoes.nodeId, nodeId),
   })
   .sync();
  return row !== undefined;
 }

 // ---- escalations (design §5 escalation desk) ----

 /**
  * Record/update the card for a node. `key` is `${repo}:${nodeId}`. Called
  * with a new messageId on first post, or the existing messageId + an
  * `lastEditedAt` on an in-place edit. A card whose node leaves the
  * HITL/provisioning set is EDITED to a queue-exit note but KEPT OPEN — it
  * stays open until a principal response or an operator verb resolves it
  * (design §5: cards persist; leaving the frontier is not a resolution).
  */
 upsertEscalation(
  row: Pick<
   EscalationRow,
   "key" | "repo" | "root" | "nodeId" | "messageId" | "createdAt"
  > &
   Partial<
    Pick<
     EscalationRow,
     | "title"
     | "route"
     | "lastContent"
     | "channelId"
     | "lastEditedAt"
     | "status"
     | "notedAt"
    >
   >,
 ): void {
  const existing = this.getEscalation(row.repo, row.nodeId);
  if (existing !== null && existing.root !== row.root) {
   throw new Error(`escalation ${row.repo}#${row.nodeId} belongs to map ${row.repo}#${existing.root}; refusing to move it to map ${row.repo}#${row.root}`);
  }
  // One resolved field set, reused for both the insert values and the
  // conflict-update set (adding an escalation field is a single edit).
  const fields = {
   root: row.root,
   title: row.title ?? existing?.title ?? null,
   route: row.route ?? existing?.route ?? null,
   lastContent: row.lastContent ?? existing?.lastContent ?? null,
   channelId: row.channelId ?? existing?.channelId ?? null,
   messageId: row.messageId,
   // createdAt is IMMUTABLE once set: it is the card's first appearance, and
   // reposts (moved channel / message gone) keep it so the card's 3/7-day
   // escalation age survives channel moves (design §5 "re-surfaced with
   // age"; round-23 review).
   createdAt: existing?.createdAt ?? row.createdAt,
   lastEditedAt: row.lastEditedAt ?? existing?.lastEditedAt ?? null,
   status: row.status ?? existing?.status ?? "open",
   notedAt:
    row.notedAt === undefined ? (existing?.notedAt ?? null) : row.notedAt,
  };
  this.db
   .insert(escalations)
   .values({ key: row.key, repo: row.repo, nodeId: row.nodeId, ...fields })
   .onConflictDoUpdate({ target: escalations.key, set: fields })
   .run();
 }

 /**
  * Record which Discord message a card lives in per destination channel. A
  * map that moves away and back recovers its original message via
  * `getEscalationDestination` instead of posting a duplicate.
  */
 setEscalationDestination(
  key: string,
  channelId: string,
  messageId: string,
  createdAt: string,
 ): void {
  this.db
   .insert(escalationDestinations)
   .values({ key, channelId, messageId, createdAt })
   .onConflictDoUpdate({
    target: [escalationDestinations.key, escalationDestinations.channelId],
    set: { messageId, createdAt },
   })
   .run();
 }

 /** The card's message id in a given destination channel, or null. */
 /** All (channel, message) destinations for a card, oldest first — the
  *  queue-exit note must reconcile EVERY live card, not just the current
  *  channel's (round-19 review). */
 getEscalationDestinations(key: string): {
  channelId: string;
  messageId: string;
 }[] {
  return this.db.query.escalationDestinations
   .findMany({
    where: eq(escalationDestinations.key, key),
    orderBy: asc(escalationDestinations.createdAt),
   })
   .sync()
   .map((r) => ({ channelId: r.channelId, messageId: r.messageId }));
 }

 getEscalationDestination(key: string, channelId: string): string | null {
  const row = this.db.query.escalationDestinations
   .findFirst({
    where: and(
     eq(escalationDestinations.key, key),
     eq(escalationDestinations.channelId, channelId),
    ),
   })
   .sync();
  return row?.messageId ?? null;
 }

 /**
  * Batch lookup for one repo's cards — the active pass resolves its whole
  * frontier in ONE query instead of N round trips per tick (round-17
  * review).
  */
 getEscalations(repo: string, nodeIds: string[]): Map<string, EscalationRow> {
  if (nodeIds.length === 0) return new Map();
  const rows = this.db.query.escalations
   .findMany({
    where: and(
     eq(escalations.repo, repo),
     inArray(escalations.nodeId, nodeIds),
    ),
   })
   .sync();
  return new Map(rows.map((r) => [r.nodeId, hydrateEscalation(r)]));
 }

 getEscalation(repo: string, nodeId: string): EscalationRow | null {
  const row = this.db.query.escalations
   .findFirst({
    where: eq(escalations.key, journalKeyFor(repo, nodeId)),
   })
   .sync();
  return row === undefined ? null : hydrateEscalation(row);
 }

 listEscalations(repo?: string): EscalationRow[] {
  const rows =
   repo === undefined
    ? this.db.query.escalations.findMany().sync()
    : this.db.query.escalations
       .findMany({
        where: eq(escalations.repo, repo),
       })
       .sync();
  return rows.map(hydrateEscalation);
 }

 /** Open cards only — avoids materializing resolved history on every pass. */
 /**
  * Open cards for a repo, optionally capped at `limit`. Returns the capped
  * rows plus the TOTAL count — the digest renders ≤15 cards but must know
  * how many open cards exist (round-17 review: don't materialize all open
  * escalations just to render a capped list).
  */
 listOpenEscalations(
  repo: string,
  now: Date,
  opts: { limit?: number; root?: number } = {},
 ): { rows: EscalationRow[]; total: number; aged: number; overdue: number } {
  // ONE aggregate: total + aged (≥3 UTC days) + overdue (≥7 UTC days) over
  // ACTIONABLE open rows — the digest header must report the true counts
  // even when an overdue card falls outside the rendered ≤15 list. UTC
  // calendar-day cutoffs match dayDiff (a card created 23:59 yesterday is 1d
  // old at 00:01 today; a rolling 72h window would exclude a card dayDiff
  // shows as 3d). NOTED cards (their queue-exit note already written, design
  // §5 — status stays open pending the #21 write-side resolution) are
  // EXCLUDED: they have been surfaced and would otherwise accumulate in the
  // daily aggregate + scan forever while rendering only 15 (round-37
  // review).
  const dayStart = (daysBack: number) =>
   new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
     daysBack * DAY_MS,
   ).toISOString();
  const agedAt = dayStart(3);
  const overdueAt = dayStart(7);
  const agg = this.db
   .select({
    total: sql<number>`count(*)`,
    aged: sql<number>`sum(case when ${escalations.createdAt} <= ${agedAt} then 1 else 0 end)`,
    overdue: sql<number>`sum(case when ${escalations.createdAt} <= ${overdueAt} then 1 else 0 end)`,
   })
   .from(escalations)
   .where(
    and(
     eq(escalations.repo, repo),
     rootFilter(escalations.root, opts.root),
     eq(escalations.status, "open"),
     isNull(escalations.notedAt),
    ),
   )
   .get();
  const rows = this.db.query.escalations
   .findMany({
    where: and(
     eq(escalations.repo, repo),
     rootFilter(escalations.root, opts.root),
     eq(escalations.status, "open"),
     isNull(escalations.notedAt),
    ),
    // Oldest first — the most urgent cards are the ones surfaced in the
    // capped display.
    orderBy: asc(escalations.createdAt),
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
   })
   .sync();
  return {
   rows: rows.map(hydrateEscalation),
   total: Number(agg?.total ?? 0),
   aged: Number(agg?.aged ?? 0),
   overdue: Number(agg?.overdue ?? 0),
  };
 }

 /**
  * Open cards whose queue-exit note has NOT yet been written — RAW keyset
  * pages (NO exclusion predicate, round-36 review). This is what the
  * absent-card pass reconciles: once a card is noted, `noted_at` is set and
  * it drops out of the scan, so per-tick work stays bounded even as open
  * (persisted) cards accumulate (design §5). The caller (selectAbsentCards)
  * drops the current-frontier rows in JS and advances the cursor on the raw
  * rows.
  */
 listUnreconciledOpen(
  repo: string,
  opts: {
   limit?: number;
   root?: number;
   after?: { createdAt: string; nodeId: string };
  } = {},
 ): EscalationRow[] {
  const rows = this.db.query.escalations
   .findMany({
    where: and(
     eq(escalations.repo, repo),
     rootFilter(escalations.root, opts.root),
     eq(escalations.status, "open"),
     isNull(escalations.notedAt),
     // KEYSET pagination: resume strictly AFTER the last raw row seen —
     // O(page), not O(offset) (round-31 review: a 50k-row queue must not
     // skip ~50k indexed rows per 50-row batch). nodeId is the tiebreaker
     // (unique per repo).
     ...(opts.after === undefined
      ? []
      : [
         or(
          gt(escalations.createdAt, opts.after.createdAt),
          and(
           eq(escalations.createdAt, opts.after.createdAt),
           gt(escalations.nodeId, opts.after.nodeId),
          ),
         ),
        ]),
    ),
    // Oldest exits first (most urgent) with nodeId as the tiebreak — MUST
    // match the keyset cursor's (createdAt, nodeId) predicate so same-createdAt
    // rows (cards posted in one pass share a timestamp) aren't skipped
    // (round-32 review).
    orderBy: [asc(escalations.createdAt), asc(escalations.nodeId)],
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
   })
   .sync();
  return rows.map(hydrateEscalation);
 }

 // ---- substrate readings (node #45) ----

 /** Upsert a substrate quota reading. */
 upsertSubstrateReading(row: SubstrateReading): void {
  const { substrate: _key, ...reading } = row;
  this.db
   .insert(substrateReadings)
   .values(row)
   .onConflictDoUpdate({ target: substrateReadings.substrate, set: reading })
   .run();
 }

 /** Get the latest reading for a substrate. */
 getSubstrateReading(substrate: SubstrateName): SubstrateReading | null {
  const row = this.db.query.substrateReadings
   .findFirst({ where: eq(substrateReadings.substrate, substrate) })
   .sync();
  return row === undefined ? null : hydrateSubstrateReading(row);
 }

 /** Get all substrate readings. */
 listSubstrateReadings(): SubstrateReading[] {
  return this.db.query.substrateReadings.findMany().sync().map(hydrateSubstrateReading);
 }

 /** Record which substrate wrote a pushed SHA (review selection reads it back). */
 recordHeadSubstrate(row: { sha: string; repo: string; nodeId: string; substrate: SubstrateName }): void {
  const now = new Date();
  const recordedAt = now.toISOString();
  this.db
   .insert(headSubstrates)
   .values({ ...row, recordedAt })
   .onConflictDoUpdate({
    target: [headSubstrates.repo, headSubstrates.sha],
    set: { substrate: row.substrate, recordedAt },
   })
   .run();
  this.pruneHeadSubstrates(now);
 }

 /** The substrate that wrote a pushed SHA in a repo, or null when ranger never recorded it. */
 headSubstrate(repo: string, sha: string): SubstrateName | null {
  const row = this.db.query.headSubstrates
   .findFirst({ where: and(eq(headSubstrates.repo, repo), eq(headSubstrates.sha, sha)) })
   .sync();
  return row?.substrate ?? null;
 }

 /**
  * Drop head records past the retention window: a head that old has long
  * been reviewed, and an unrecorded head only falls back to Pi-written.
  */
 pruneHeadSubstrates(now = new Date(), retentionDays = 30): void {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  this.db.delete(headSubstrates).where(lt(headSubstrates.recordedAt, cutoff)).run();
 }

 // ---- substrate sessions (node #56) ----

 /**
  * Open a session row and return its id. The fence runs inside the
  * transaction: a superseded supervisor (generation no longer the worker
  * row's) gets a FencedError and touches no row. A node runs one session at
  * a time under its current supervisor, so a row still open for the same
  * node belongs to an older generation, superseded or dead mid-session: it
  * is closed as failed here, and its own late `endSubstrateSession` (if any) no longer
  * applies.
  */
 startSubstrateSession(
  scope: {
   substrate: SubstrateName;
   kind: SessionKind;
   repo: string;
   nodeId: string;
   generation: number;
   model?: string | null;
  },
  now = new Date(),
 ): number {
  const at = now.toISOString();
  return this.db.transaction((tx) => {
   const occupant = tx
    .select({ generation: workers.generation })
    .from(workers)
    .where(and(eq(workers.nodeId, scope.nodeId), eq(workers.repo, scope.repo)))
    .all()[0];
   if (occupant === undefined || occupant.generation !== scope.generation) {
    throw new FencedError(
     `node ${scope.nodeId}: generation ${scope.generation} superseded by ${occupant?.generation ?? "a removed row"} — refusing to open a ${scope.kind} session`,
    );
   }
   tx.update(substrateSessions)
    .set({ endedAt: at, outcome: "failed" })
    .where(
     and(
      eq(substrateSessions.repo, scope.repo),
      eq(substrateSessions.nodeId, scope.nodeId),
      isNull(substrateSessions.endedAt),
     ),
    )
    .run();
   const cutoff = new Date(now.getTime() - SESSION_RETENTION_DAYS * DAY_MS).toISOString();
   tx.delete(substrateSessions).where(lt(substrateSessions.startedAt, cutoff)).run();
   const [row] = tx
    .insert(substrateSessions)
    .values({ ...scope, startedAt: at })
    .returning({ id: substrateSessions.id })
    .all();
   return row.id;
  });
 }

 /** Close a session row; a row already closed (superseded) stays as it is. */
 endSubstrateSession(id: number, outcome: SessionOutcome, now = new Date()): void {
  this.db
   .update(substrateSessions)
   .set({ endedAt: now.toISOString(), outcome })
   .where(and(eq(substrateSessions.id, id), isNull(substrateSessions.endedAt)))
   .run();
 }

 /**
  * Sessions started since `since`, plus every still-open row: two indexed
  * reads (recent by `started_at`, open by `ended_at`), so a dashboard poll
  * never scans the retained history. Null for a journal no migration has
  * reached yet (`ranger serve` reads it without migrating): there is no
  * history to count, which is not the same as no sessions.
  */
 listSubstrateSessions(since: Date): SubstrateSessionRow[] | null {
  return withoutSessionsTable(() => {
   const recent = this.db
    .select(SESSION_COLUMNS)
    .from(substrateSessions)
    .where(gt(substrateSessions.startedAt, since.toISOString()))
    .all();
   const open = this.db.select(SESSION_COLUMNS).from(substrateSessions).where(isNull(substrateSessions.endedAt)).all();
   const byId = new Map([...recent, ...open].map((row) => [row.id, row]));
   return [...byId.values()].sort((a, b) => a.id - b.id);
  });
 }

 /** A substrate's most recent session, however old (within retention). */
 lastSubstrateSession(substrate: SubstrateName): SubstrateSessionRow | null {
  return (
   withoutSessionsTable(() =>
    this.db
     .select(SESSION_COLUMNS)
     .from(substrateSessions)
     .where(eq(substrateSessions.substrate, substrate))
     .orderBy(desc(substrateSessions.startedAt), desc(substrateSessions.id))
     .limit(1)
     .all(),
   )?.[0] ?? null
  );
 }

 /** Prune spawn-ledger keys older than the retention window (keeps health tidy). */
 pruneSpawnLedger(now = new Date(), retentionDays = 30): void {
  const cutoff = dayKey(new Date(now.getTime() - retentionDays * DAY_MS));
  const stale = this.db
   .select({ key: health.key })
   .from(health)
   .all()
   .filter(
    (r) =>
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

/**
 * The columns a session read returns. Named rather than `select()`: `ranger
 * serve` reads without migrating, and a journal from before the `model`
 * column (node #60) still has every one of these.
 */
const SESSION_COLUMNS = {
 id: substrateSessions.id,
 substrate: substrateSessions.substrate,
 kind: substrateSessions.kind,
 repo: substrateSessions.repo,
 nodeId: substrateSessions.nodeId,
 generation: substrateSessions.generation,
 startedAt: substrateSessions.startedAt,
 endedAt: substrateSessions.endedAt,
 outcome: substrateSessions.outcome,
};

/** Session rows are kept a month: the panel's widest window is 7 days. */
const SESSION_RETENTION_DAYS = 30;

/** Null when `substrate_sessions` is not migrated in yet. */
function withoutSessionsTable(read: () => SubstrateSessionRow[]): SubstrateSessionRow[] | null {
 try {
  return read();
 } catch (error) {
  if (error instanceof Error && error.message.includes("no such table: substrate_sessions")) return null;
  throw error;
 }
}

function dayKey(date: Date): string {
 return date.toISOString().slice(0, 10);
}

function hydrateWorker(row: {
 root: number;
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
 lane: string | null;
 generation: number;
 workerPgid: number | null;
 phase: string | null;
 prNumber: number | null;
 researchBaseSha: string | null;
 reviewRound: number;
 verdictSha: string | null;
 verdictBlockers: number | null;
 mergeMessageId: string | null;
 substrate: SubstrateName | null;
}): WorkerRow {
 return {
  nodeId: row.nodeId,
  repo: row.repo,
  root: row.root,
  pid: row.pid,
  status: row.status as WorkerStatus,
  attempts: row.attempts,
  worktree: row.worktree,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  outcome: row.outcome,
  messageId: row.messageId,
  lane: row.lane,
  generation: row.generation,
  workerPgid: row.workerPgid,
  phase: row.phase as ImplementPhase | null,
  prNumber: row.prNumber,
  researchBaseSha: row.researchBaseSha,
  reviewRound: row.reviewRound,
  verdictSha: row.verdictSha,
  verdictBlockers: row.verdictBlockers,
  mergeMessageId: row.mergeMessageId,
  substrate: row.substrate,
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

function hydrateEscalation(row: {
 root: number;
 key: string;
 repo: string;
 nodeId: string;
 title: string | null;
 route: string | null;
 lastContent: string | null;
 channelId: string | null;
 messageId: string;
 createdAt: string;
 lastEditedAt: string | null;
 status: string;
 notedAt: string | null;
}): EscalationRow {
 return {
  key: row.key,
  repo: row.repo,
  root: row.root,
  nodeId: row.nodeId,
  title: row.title,
  route: row.route,
  lastContent: row.lastContent,
  channelId: row.channelId,
  messageId: row.messageId,
  createdAt: row.createdAt,
  lastEditedAt: row.lastEditedAt,
  status: row.status as "open" | "closed",
  notedAt: row.notedAt,
 };
}

function hydrateSubstrateReading(row: {
 substrate: SubstrateName;
 readAt: string;
 fiveHourUsedPct: number | null;
 sevenDayUsedPct: number | null;
 fiveHourResetsAt: string | null;
 sevenDayResetsAt: string | null;
 resetsAt: string | null;
 capped: number | boolean;
 cappedUntil: string | null;
}): SubstrateReading {
 return {
  substrate: row.substrate,
  readAt: row.readAt,
  fiveHourUsedPct: row.fiveHourUsedPct,
  sevenDayUsedPct: row.sevenDayUsedPct,
  fiveHourResetsAt: row.fiveHourResetsAt,
  sevenDayResetsAt: row.sevenDayResetsAt,
  resetsAt: row.resetsAt,
  capped: row.capped === true || row.capped === 1,
  cappedUntil: row.cappedUntil,
 };
}

/** Open the configured journal (default from config.state.journalPath). */
export function openJournal(config: RangerConfig): Journal {
 return new Journal(expandHome(config.state.journalPath), undefined, config.maps, config.state.legacyMapRoots);
}
