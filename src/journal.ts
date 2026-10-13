import { journalKeyFor } from "./forge-ref.ts";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { openDb, openDbReadOnly, type RangerDb } from "./store/db.ts";
import { seedLegacyRoots } from "./store/legacy-roots.ts";
import {
 escalations,
 escalationDestinations,
 events,
 headSubstrates,
 health,
 intakeCursors,
 intakeDrafts,
 resumeQueue,
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
 | "awaiting-merge"
 /**
  * A `propose` research node whose findings are posted as a proposal comment
  * (node #246, ruling D10): the claim stays, no worker runs, no lane slot is
  * held, and the node waits for the principal's 👍.
  */
 | "proposed";

/**
 * Implement-lane phases (F2, #23 amendment) — the forge wins on resume.
 * `awaiting-review` is a parked GitLab change request with no review gate yet
 * (node #131): its row is never on the merge desk.
 */
export type ImplementPhase = "implement" | "review" | "awaiting-review" | "awaiting-merge" | "close";

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
 /** The proposal comment `close --propose` posted (node #246, D8); null when unknown. */
 proposalCommentId: string | null;
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

/** The fixed prefix `recordRebase` writes and `listRebases` reads: the SHAs, and ` wait` when no request was sent; the note follows. */
const REBASE_PREFIX = /^from=([0-9a-f]{7,64})(?: to=([0-9a-f]{7,64}))?( wait)?: ?([\s\S]*)$/;

/** The fixed prefix `recordCiAbsent` writes and `listCiAbsent` reads: the head, then the step. */
const CI_ABSENT_PREFIX = /^head=([0-9a-f]{7,64}) (seen|sent-back|surfaced)(?::|$)/;

/**
 * The merge desk's steps for a head that no CI ran on (`ci-absent` events):
 * first seen with no check runs, sent back for a base merge pass, surfaced to
 * the principal once nothing else will start CI.
 */
export type CiAbsentStep = "seen" | "sent-back" | "surfaced";

export interface EventRow {
 id: number;
 at: string;
 nodeId: string | null;
 repo: string | null;
 kind: string;
 detail: string | null;
}

/** One vetoed node (node #240). */
export interface VetoRow {
 /** '' on a row from before node #240: it vetoes the node on every repo. */
 repo: string;
 nodeId: string;
 root: number | null;
 /** Ranger's veto comment on the node. */
 commentId: string;
 /** The proposal comment the principal 👎'd; null when unknown. */
 proposalCommentId: string | null;
 at: string;
 detail: string | null;
}

/**
 * Does this veto stop the node on this repo? Its own repo's row does, and a
 * row from before node #240 (repo '') does on every repo. The one rule every
 * "is it vetoed" reader applies (`Journal.hasVeto`, `ranger serve`).
 */
export function vetoApplies(veto: Pick<VetoRow, "repo" | "nodeId">, nodeId: string, repo: string): boolean {
 return veto.nodeId === nodeId && (veto.repo === repo || veto.repo === "");
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
 /** A confirmed graph closure also resolves the card. */
 status: "open" | "closed";
 /** When the queue-exit note was written (bounds the absent-card scan). */
 notedAt: string | null;
}

/** One intake draft card (node #247): a principal message ranger drafted a node from. */
export interface IntakeDraftRow {
 messageId: string;
 channelId: string;
 repo: string;
 root: number;
 authorId: string;
 title: string;
 checkpoint: string;
 body: string;
 messageUrl: string;
 drafter: string;
 /** The drafted kind (node #252); null when the drafter set none. */
 kind: string | null;
 /** JSON array of soma probes. */
 probes: string | null;
 cardMessageId: string;
 /** draft | filing | filed | discarded (node #251) | superseding | superseded (node #241). */
 status: string;
 createdAt: string;
 /** The spec hash the card showed (ruling D13); null before node #251. */
 specHash: string | null;
 /** The node the principal's 👍 filed. */
 filedNode: string | null;
 /** When the gate last read the card's reactions. */
 gateReadAt: string | null;
 /** The drafted parent node: the card shows it and the add files below it. */
 parent: number;
 /** The drafted autonomy: the card shows it and the add mints it. */
 autonomy: string;
 /** The draft this correction replaced (node #241, ruling D13); null on a mention's own draft. */
 supersedes: string | null;
 /** The @-mention a corrected draft traces back to; null on the mention's own draft. */
 originMessageId: string | null;
}

export interface ResumeQueueRow {
 id: number;
 repo: string;
 nodeId: string;
 root: number;
 lane: ImplementLane;
 queuedAt: string;
 failedStarts: number;
}

export type EventKind =
 | "resume-queued"
 | "resume-cancelled"
 | "resume-dropped"
 | "resume-started"
 | "announced"
 | "claimed"
 | "worker-start"
 | "worker-success"
 | "closed"
 | "closed-elsewhere"
 | "closed-elsewhere-ungated"
 | "decisions-written"
 | "decisions-failed"
 | "refused"
 | "parked"
 | "released"
 | "sweep"
 | "deadman-paused"
 | "drain"
 | "fenced"
 | "pushed"
 | "pr-opened"
 | "ci-passed"
 | "reviewed"
 | "awaiting-merge"
 | "proposed"
 /** Ratify phase (node #250): a proposal bound from the node's comments, one not found, one ratified. */
 | "proposal-bound"
 | "proposal-missing"
 | "ratified"
 /** Node #240: a principal 👎 vetoed a proposal; a lost journal recovered a proposal or a veto from GitHub. */
 | "vetoed"
 | "proposal-recovered"
 | "veto-recovered"
 | "merge-card"
 | "merged"
 | "rebased"
 | "orphan-killed"
 | "substrate-capped"
 | "transient"
 | "git-trust"
 | "log-failed"
 | "worktree-synced"
 | "filed"
 | "intake-draft"
 /** Intake gate (node #251): the principal's 👍 filed a draft, or ❌ discarded one. */
 | "intake-filed"
 | "intake-discarded"
 /** A principal correction reply got a new draft card that supersedes the old (node #241). */
 | "intake-corrected"
 /** The merge desk's steps for a head no CI ran on (`CiAbsentStep`). */
 | "ci-absent";

/** The health-store key of a checkout's known-good git state (`knownGoodGitState`). */
const knownGoodGitKey = (canonical: string): string => `git.known-good.${canonical}`;

/** The health-store keys of the drains (node #165), stored the way `paused` is. */
const VISUAL_DRAIN_KEY = "drain.lane.visual";
const mapDrainKey = (key: string): string => `drain.map.${key}`;

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
  private readonly laneSlots: Partial<Record<ImplementLane, number>> = {},
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
 static openReadOnly(
  path: string,
  maps: readonly LaneMap[] = [],
  laneSlots: Partial<Record<ImplementLane, number>> = {},
 ): Journal | null {
  const opened = openDbReadOnly(path);
  return opened === null ? null : new Journal(path, opened, maps, {}, laneSlots);
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
    proposalCommentId: row.proposalCommentId ?? null,
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
     proposalCommentId: row.proposalCommentId,
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
  * A resource lane holds `workers.laneSlots` claimed/running implement
  * workers across all maps (default one). Returns the first occupant once
  * every slot is taken, null while one is free.
  * Excluding an occupant requires its repo as well as node id.
  * Unknown or ambiguous maps conservatively hold both resource lanes.
  */
 laneHolder(
  lane: ImplementLane,
  except?: { nodeId: string; repo: string },
  isActive: (worker: WorkerRow) => boolean = () => true,
 ): WorkerRow | null {
  const occupants = this.listWorkers().filter((w) => {
   if (w.nodeId === except?.nodeId && w.repo === except?.repo) return false;
   if (!holdsImplementLane(w)) return false;
   if (!isActive(w)) return false;
   const resource = workerLane(w, this.maps);
   return resource === lane || resource === null;
  });
  return occupants.length >= (this.laneSlots[lane] ?? 1) ? occupants[0] : null;
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

 // ---- queued resumes ----

 enqueueResume(entry: Omit<ResumeQueueRow, "id" | "queuedAt" | "failedStarts">, now = new Date()): ResumeQueueRow {
  return this.db.transaction(() => {
   const inserted = this.db.insert(resumeQueue).values({ ...entry, queuedAt: now.toISOString() })
    .onConflictDoNothing({ target: [resumeQueue.repo, resumeQueue.nodeId] }).returning().get();
   if (inserted !== undefined) {
    this.recordEvent("resume-queued", { nodeId: entry.nodeId, repo: entry.repo, detail: `resume-node queued for the ${entry.lane} implement lane (map root ${entry.root})` });
    return inserted;
   }
   return this.db.select().from(resumeQueue)
    .where(and(eq(resumeQueue.repo, entry.repo), eq(resumeQueue.nodeId, entry.nodeId))).get()!;
  });
 }

 listResumeQueue(lane?: ImplementLane): ResumeQueueRow[] {
  return this.db.select().from(resumeQueue).where(lane === undefined ? undefined : eq(resumeQueue.lane, lane))
   .orderBy(asc(resumeQueue.id)).all();
 }

 getResume(repo: string, nodeId: string): ResumeQueueRow | null {
  return this.db.select().from(resumeQueue)
   .where(and(eq(resumeQueue.repo, repo), eq(resumeQueue.nodeId, nodeId))).get() ?? null;
 }

 recordResumeStartFailure(entry: ResumeQueueRow, reason: string): boolean {
  return this.db.transaction(() => {
   const updated = this.db.update(resumeQueue)
    .set({ failedStarts: sql`${resumeQueue.failedStarts} + 1` })
    .where(eq(resumeQueue.id, entry.id)).returning().get();
   if (updated === undefined) return true;
   if (updated.failedStarts < 3) return false;
   this.removeResume(updated, "resume-dropped", `3 consecutive failed starts; last error: ${reason}`);
   return true;
  });
 }

 removeResume(entry: ResumeQueueRow, kind: "resume-cancelled" | "resume-dropped" | "resume-started", reason: string): boolean {
  return this.db.transaction(() => {
   const removed = this.db.delete(resumeQueue).where(eq(resumeQueue.id, entry.id)).returning().get();
   if (removed === undefined) return false;
   this.recordEvent(kind, { nodeId: entry.nodeId, repo: entry.repo, detail: reason });
   return true;
  });
 }

 /** Bounded keyset page for graph-closure reconciliation, scoped to one map. */
 listClosureCandidates(repo: string, root: number, limit: number, after?: string): WorkerRow[] {
  return this.db.select().from(workers).where(and(
   eq(workers.repo, repo), eq(workers.root, root),
   inArray(workers.status, ["parked", "failed", "awaiting-merge", "proposed"]),
   after === undefined ? undefined : gt(workers.nodeId, after),
  )).orderBy(asc(workers.nodeId)).limit(limit).all().map(hydrateWorker);
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

 /** The newest `limit` events, of one repo and, with `nodeId`, one node of it. */
 listEvents(repo?: string, limit = 50, nodeId?: string): EventRow[] {
  const where = and(
   repo === undefined ? undefined : eq(events.repo, repo),
   nodeId === undefined ? undefined : eq(events.nodeId, nodeId),
  );
  const rows = this.db.select().from(events).where(where).orderBy(desc(events.id)).limit(limit).all();
  return rows.map(hydrateEvent);
 }

 /**
  * A rebase pass on a node's change request from the gated head `from`
  * (node #126): `to` is the new head once ranger saw it move, else null;
  * `requested` is false when the pass only waited on a running rebase. These
  * lead the detail in a fixed prefix that `listRebases` reads back, so
  * `note` stays free prose.
  */
 recordRebase(opts: { nodeId: string; repo: string; from: string; to: string | null; requested: boolean; note: string }): void {
  const prefix = `from=${opts.from}${opts.to === null ? "" : ` to=${opts.to}`}${opts.requested ? "" : " wait"}`;
  this.recordEvent("rebased", { nodeId: opts.nodeId, repo: opts.repo, detail: `${prefix}: ${opts.note}` });
 }

 /**
  * A node's recorded rebase passes, newest first. Queried by kind, so other
  * events (a send-back waiting on the lane logs one per pass) never push a
  * rebase out of the window.
  */
 listRebases(repo: string, nodeId: string, limit = 60): { from: string; to: string | null; requested: boolean; note: string }[] {
  return this.db
   .select()
   .from(events)
   .where(and(eq(events.repo, repo), eq(events.nodeId, nodeId), eq(events.kind, "rebased")))
   .orderBy(desc(events.id))
   .limit(limit)
   .all()
   .flatMap((e) => {
    const m = REBASE_PREFIX.exec(e.detail ?? "");
    return m === null ? [] : [{ from: m[1]!, to: m[2] ?? null, requested: m[3] === undefined, note: m[4] ?? "" }];
   });
 }

 /** One step for a head no CI ran on; `note` is free prose after the fixed prefix. */
 recordCiAbsent(opts: { nodeId: string; repo: string; head: string; step: CiAbsentStep; note: string }): void {
  this.recordEvent("ci-absent", { nodeId: opts.nodeId, repo: opts.repo, detail: `head=${opts.head} ${opts.step}: ${opts.note}` });
 }

 /** A node's `ci-absent` steps, newest first; queried by kind, like `listRebases`. */
 listCiAbsent(repo: string, nodeId: string, limit = 30): { head: string; step: CiAbsentStep; at: string }[] {
  return this.db
   .select()
   .from(events)
   .where(and(eq(events.repo, repo), eq(events.nodeId, nodeId), eq(events.kind, "ci-absent")))
   .orderBy(desc(events.id))
   .limit(limit)
   .all()
   .flatMap((e) => {
    const m = CI_ABSENT_PREFIX.exec(e.detail ?? "");
    return m === null ? [] : [{ head: m[1]!, step: m[2] as CiAbsentStep, at: e.at }];
   });
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

 // ---- drain (node #165) ----

 /**
  * The visual lane's drain: one switch for every visual-lane map, because
  * the lane is a machine singleton (`laneHolder` scans this one journal).
  */
 isVisualLaneDrained(): boolean {
  return this.getHealth(VISUAL_DRAIN_KEY) === "true";
 }

 setVisualLaneDrained(drained: boolean): void {
  this.setHealth(VISUAL_DRAIN_KEY, drained ? "true" : "false");
 }

 /** One headless-lane map's drain, keyed `owner/name#root`. */
 isMapDrained(key: string): boolean {
  return this.getHealth(mapDrainKey(key)) === "true";
 }

 setMapDrained(key: string, drained: boolean): void {
  this.setHealth(mapDrainKey(key), drained ? "true" : "false");
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

 /**
  * Record a veto (node #240): idempotent per (repo, node). `commentId` is
  * ranger's veto comment, the record a lost journal is rebuilt from.
  */
 recordVeto(veto: {
  repo: string;
  nodeId: string;
  root?: number;
  commentId: string;
  proposalCommentId?: string | null;
  detail?: string;
 }): void {
  const at = new Date().toISOString();
  const fields = {
   root: veto.root ?? null,
   commentId: veto.commentId,
   proposalCommentId: veto.proposalCommentId ?? null,
   at,
   detail: veto.detail ?? null,
  };
  this.db
   .insert(vetoes)
   .values({ repo: veto.repo, nodeId: veto.nodeId, ...fields })
   .onConflictDoUpdate({ target: [vetoes.repo, vetoes.nodeId], set: fields })
   .run();
 }

 /** Every veto, in one query (#37: `ranger serve` reads them per poll). */
 listVetoes(repo?: string, root?: number): VetoRow[] {
  const rows = this.db.query.vetoes
   .findMany({
    where: repo === undefined ? undefined : and(eq(vetoes.repo, repo), root === undefined ? undefined : eq(vetoes.root, root)),
   })
   .sync();
  return rows.map((v) => ({
   repo: v.repo,
   nodeId: v.nodeId,
   root: v.root,
   commentId: v.commentId,
   proposalCommentId: v.proposalCommentId,
   at: v.at,
   detail: v.detail,
  }));
 }

 /**
  * This repo's veto record on the node, or null: the veto comment ranger
  * posted and the proposal it refused. A row from before node #240 has
  * neither, so it is not returned; `hasVeto` still counts it.
  */
 getVeto(nodeId: string, repo: string): VetoRow | null {
  return this.listVetoes(repo).find((veto) => veto.nodeId === nodeId) ?? null;
 }

 /** Is this node vetoed on this repo (`vetoApplies`)? */
 hasVeto(nodeId: string, repo: string): boolean {
  return this.db.query.vetoes
   .findMany({ where: eq(vetoes.nodeId, nodeId) })
   .sync()
   .some((row) => vetoApplies(row, nodeId, repo));
 }

 // ---- escalations (design §5 escalation desk) ----

 /**
  * Record/update the card for a node. `key` is `${repo}:${nodeId}`. Called
  * with a new messageId on first post, or the existing messageId + an
  * `lastEditedAt` on an in-place edit. A card whose node leaves the
  * HITL/provisioning set is EDITED to a queue-exit note but KEPT OPEN — it
  * stays open until a graph closure, principal response or operator verb resolves it
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
  * it drops out of the default scan. notedOnly selects the separate closure
  * scan; includeNoted selects both. The caller bounds each scan with a cursor.
  */
 listUnreconciledOpen(
  repo: string,
  opts: {
   limit?: number;
   root?: number;
   after?: { createdAt: string; nodeId: string };
   includeNoted?: boolean;
   notedOnly?: boolean;
  } = {},
 ): EscalationRow[] {
  const rows = this.db.query.escalations
   .findMany({
    where: and(
     eq(escalations.repo, repo),
     rootFilter(escalations.root, opts.root),
     eq(escalations.status, "open"),
     ...(opts.notedOnly ? [isNotNull(escalations.notedAt)] : opts.includeNoted ? [] : [isNull(escalations.notedAt)]),
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

 // ---- human-observation intake (node #247) ----

 /**
  * How far intake has handled a map thread: every message up to this id is
  * done. Null when the journal holds no cursor, before the first read or
  * after the journal was lost: the rescan then reads from the thread's
  * oldest message (node #249).
  */
 intakeCursor(channelId: string): string | null {
  const row = this.db.select().from(intakeCursors).where(eq(intakeCursors.channelId, channelId)).get();
  return row?.lastMessageId ?? null;
 }

 setIntakeCursor(channelId: string, lastMessageId: string, now = new Date()): void {
  const values = { lastMessageId, updatedAt: now.toISOString() };
  this.db
   .insert(intakeCursors)
   .values({ channelId, ...values })
   .onConflictDoUpdate({ target: intakeCursors.channelId, set: values })
   .run();
 }

 /** The draft posted for a principal message, or null when none was. */
 getIntakeDraft(messageId: string): IntakeDraftRow | null {
  return this.db.select().from(intakeDrafts).where(eq(intakeDrafts.messageId, messageId)).get() ?? null;
 }

 /** Record a posted draft card; a second record for one message is refused. */
 recordIntakeDraft(row: Omit<IntakeDraftRow, "status" | "filedNode" | "gateReadAt" | "supersedes" | "originMessageId">): void {
  this.db.insert(intakeDrafts).values({ ...row, status: "draft" }).run();
 }

 /**
  * Record a correction's draft and mark the draft it replaces `superseding`
  * in one transaction (node #241, ruling D13): from here only the new card
  * can be filed. Refused unless the replaced draft is still `draft`.
  */
 recordIntakeCorrection(row: Omit<IntakeDraftRow, "status" | "filedNode" | "gateReadAt"> & { supersedes: string }): void {
  this.db.transaction((tx) => {
   const replaced = tx
    .update(intakeDrafts)
    .set({ status: "superseding" })
    .where(and(eq(intakeDrafts.messageId, row.supersedes), eq(intakeDrafts.status, "draft")))
    .returning()
    .get();
   if (replaced === undefined) throw new Error(`draft ${row.supersedes} is no longer a draft — the correction is not recorded`);
   tx.insert(intakeDrafts).values({ ...row, status: "draft" }).run();
  });
 }

 /** The draft whose card is this Discord message, or null. */
 getIntakeDraftByCard(cardMessageId: string): IntakeDraftRow | null {
  return this.db.select().from(intakeDrafts).where(eq(intakeDrafts.cardMessageId, cardMessageId)).get() ?? null;
 }

 /** The correction that replaced this draft (node #241), or null. */
 getIntakeSuccessor(messageId: string): IntakeDraftRow | null {
  return this.db.select().from(intakeDrafts).where(eq(intakeDrafts.supersedes, messageId)).get() ?? null;
 }

 updateIntakeDraft(
  messageId: string,
  patch: Partial<Pick<IntakeDraftRow, "status" | "filedNode" | "gateReadAt">>,
 ): void {
  this.db.update(intakeDrafts).set(patch).where(eq(intakeDrafts.messageId, messageId)).run();
 }

 /**
  * The drafts in a thread the gate still reads (node #251): `draft`,
  * `filing` and `superseding` (its old card still to edit, node #241), the
  * least recently read first, then the oldest.
  */
 listOpenIntakeDrafts(channelId: string): IntakeDraftRow[] {
  return this.db
   .select()
   .from(intakeDrafts)
   .where(and(eq(intakeDrafts.channelId, channelId), inArray(intakeDrafts.status, ["draft", "filing", "superseding"])))
   .orderBy(sql`coalesce(${intakeDrafts.gateReadAt}, '')`, asc(intakeDrafts.createdAt), asc(intakeDrafts.messageId))
   .all();
 }

 listIntakeDrafts(repo?: string): IntakeDraftRow[] {
  const query = this.db.select().from(intakeDrafts);
  return (repo === undefined ? query : query.where(eq(intakeDrafts.repo, repo))).orderBy(asc(intakeDrafts.createdAt)).all();
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
 proposalCommentId: string | null;
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
  proposalCommentId: row.proposalCommentId,
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
 return new Journal(expandHome(config.state.journalPath), undefined, config.maps, config.state.legacyMapRoots, config.workers.laneSlots);
}
