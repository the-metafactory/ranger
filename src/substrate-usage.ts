/**
 * Substrate usage (node #56): every substrate's limits and what it has run.
 *
 * The implement lane records each worker session, fix pass and sage round in
 * `substrate_sessions` (`recordSession`); `ranger serve` builds one panel row
 * per substrate from those rows and the stored quota readings
 * (`substrateUsageViews`). Eligibility comes from the selector's own policy
 * functions (`substrate-policy.ts`, the `pick` the selector runs), so the
 * panel cannot disagree with what ranger will do.
 *
 * Read-only consumers import this module: it imports no spawning code and no
 * quota reader. Refreshing a reading stays the selector's job.
 */
import type { Journal, SubstrateReading, SubstrateSessionRow, WorkerRow } from "./journal.ts";
import {
 SESSION_KINDS,
 SUBSTRATE_NAMES,
 type SessionKind,
 type SessionOutcome,
 type SubstrateName,
} from "./store/schema.ts";
import {
 activeCappedUntil,
 effectiveThreshold,
 isEligible,
 isFresh,
 maxReadingAgeMs,
 readingAgeMin,
 type QuotaWindowKind,
 type SubstrateConfig,
} from "./substrate-policy.ts";
import { isTransientGitHubError } from "./transient.ts";

export type { SessionKind, SessionOutcome };

// ---- recording ----

export interface SessionScope {
 substrate: SubstrateName;
 kind: SessionKind;
 repo: string;
 nodeId: string;
}

/**
 * How a failed session ended, as the lane itself judges it: capped only on
 * the substrate's own cap signal, transient on a GitHub-side transient error
 * (the rule `failNode` applies), otherwise failed.
 */
export function failedSessionOutcome(detail: string, capSignal?: unknown): SessionOutcome {
 if (capSignal !== undefined && capSignal !== null) return "capped";
 return isTransientGitHubError(detail) ? "transient" : "failed";
}

/**
 * Run one substrate session between a started and an ended row. A thrown
 * error still ends the row (failed or transient) before it propagates.
 */
export async function recordSession<T>(
 journal: Journal,
 scope: SessionScope,
 run: () => Promise<T>,
 outcomeOf: (result: T) => SessionOutcome,
): Promise<T> {
 const id = journal.startSubstrateSession(scope);
 let outcome: SessionOutcome = "failed";
 try {
  const result = await run();
  outcome = outcomeOf(result);
  return result;
 } catch (error) {
  outcome = failedSessionOutcome(error instanceof Error ? error.message : String(error));
  throw error;
 } finally {
  journal.endSubstrateSession(id, outcome);
 }
}

// ---- the panel ----

export interface QuotaWindowView {
 usedPct: number;
 /** The threshold eligibility uses now (time-scaled, node #55). */
 threshold: number;
 /** ISO: this window's own reset, when the substrate reported one. */
 resetsAt: string | null;
 /** Minutes until this window resets (0 once reached); null when unknown. */
 resetInMin: number | null;
}

export interface Eligibility {
 /**
  * yes / no: what selection would decide on this reading now. stale: the
  * reading is past its max age, and selection re-reads before it chooses.
  */
 state: "yes" | "no" | "stale";
 reason: string;
}

export interface OutcomeCounts {
 sessions: number;
 failed: number;
 capped: number;
 transient: number;
}

export type SessionCounts = Record<SessionKind, OutcomeCounts> & { total: OutcomeCounts };

export interface LastSession {
 repo: string;
 nodeId: string;
 kind: SessionKind;
 startedAt: string;
 endedAt: string | null;
 outcome: SessionOutcome | null;
}

export interface SubstrateUsageView {
 substrate: SubstrateName;
 /** none: Pi has no quota. unread: no stored reading. read: the reading below. */
 quota: "none" | "unread" | "read";
 fiveHour: QuotaWindowView | null;
 sevenDay: QuotaWindowView | null;
 readAt: string | null;
 ageMin: number | null;
 maxAgeMin: number | null;
 /** Within its max age; a stale reading's values are shown greyed. */
 fresh: boolean;
 /** Capped now: a fresh reading's status, or a capped-until still ahead. */
 capped: boolean;
 /** ISO, only while still in the future. */
 cappedUntil: string | null;
 eligible: Eligibility;
 sessions: {
  /** Sessions whose supervisor is alive now, by kind. */
  running: Record<SessionKind, number>;
  day: SessionCounts;
  week: SessionCounts;
 };
 lastSession: LastSession | null;
}

export interface UsageInputs {
 /** Stored quota readings (no reads from here). */
 readings: SubstrateReading[];
 /** Sessions started in the last 7 days, plus every open one. */
 sessions: SubstrateSessionRow[];
 /** Each substrate's most recent session, however old. */
 lastSession: (substrate: SubstrateName) => SubstrateSessionRow | null;
 /** Whether an open session's supervisor is still running it. */
 live: (session: SubstrateSessionRow) => boolean;
 config: SubstrateConfig;
 now: Date;
}

const DAY_MS = 24 * 60 * 60_000;

/** One row for every substrate ranger knows, with or without a reading. */
export function substrateUsageViews(inputs: UsageInputs): SubstrateUsageView[] {
 return SUBSTRATE_NAMES.map((name) => usageView(name, inputs));
}

function usageView(name: SubstrateName, inputs: UsageInputs): SubstrateUsageView {
 const { now, config } = inputs;
 const reading = name === "pi" ? null : (inputs.readings.find((r) => r.substrate === name) ?? null);
 const mine = inputs.sessions.filter((s) => s.substrate === name);
 const last = inputs.lastSession(name);
 const fresh = reading !== null && isFresh(reading, config, now);
 const cappedUntil = reading === null ? null : activeCappedUntil(reading, now);
 return {
  substrate: name,
  quota: name === "pi" ? "none" : reading === null ? "unread" : "read",
  fiveHour: reading === null ? null : windowView("five_hour", reading, config, now),
  sevenDay: reading === null ? null : windowView("seven_day", reading, config, now),
  readAt: reading?.readAt ?? null,
  ageMin: reading === null ? null : readingAgeMin(reading, now),
  maxAgeMin: name === "pi" ? null : maxReadingAgeMs(name, config) / 60_000,
  fresh,
  capped: cappedUntil !== null || (fresh && reading?.capped === true),
  cappedUntil,
  eligible: eligibility(name, reading, config, now),
  sessions: {
   running: runningByKind(mine.filter((s) => s.endedAt === null && inputs.live(s))),
   day: countSince(mine, now.getTime() - DAY_MS),
   week: countSince(mine, now.getTime() - 7 * DAY_MS),
  },
  lastSession:
   last === null
    ? null
    : {
       repo: last.repo,
       nodeId: last.nodeId,
       kind: last.kind,
       startedAt: last.startedAt,
       endedAt: last.endedAt,
       outcome: last.outcome,
      },
 };
}

function windowView(
 window: QuotaWindowKind,
 reading: SubstrateReading,
 config: SubstrateConfig,
 now: Date,
): QuotaWindowView | null {
 const fiveHour = window === "five_hour";
 const used = fiveHour ? reading.fiveHourUsedPct : reading.sevenDayUsedPct;
 if (used === null) return null;
 const resetsAt = fiveHour ? reading.fiveHourResetsAt : reading.sevenDayResetsAt;
 const resetMs = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
 return {
  usedPct: used,
  threshold: effectiveThreshold(window, reading, now, config),
  resetsAt,
  resetInMin: Number.isFinite(resetMs) ? Math.max(0, Math.round((resetMs - now.getTime()) / 60_000)) : null,
 };
}

/**
 * Eligibility as selection sees it. Only a missing or capped reading is
 * ineligible before selection runs: a stale one is re-read first, so it is
 * shown as stale, not as a verdict. A fresh reading is judged by the
 * selector's `isEligible`, nothing else.
 */
function eligibility(
 name: SubstrateName,
 reading: SubstrateReading | null,
 config: SubstrateConfig,
 now: Date,
): Eligibility {
 if (name === "pi") return { state: "yes", reason: "no quota (always eligible)" };
 if (reading === null) return { state: "no", reason: "no reading: treated as capped" };
 const until = activeCappedUntil(reading, now);
 // A capped-until survives a fresh read (persistReading), so it binds now.
 if (until !== null) return { state: "no", reason: `capped until ${until}` };
 if (!isFresh(reading, config, now)) {
  return { state: "stale", reason: `stale (${readingAgeMin(reading, now)}m): re-read at next selection` };
 }
 const eligible = isEligible(reading, config, now);
 if (eligible !== null) return { state: "yes", reason: `${eligible.headroom.toFixed(1)}% headroom` };
 if (reading.capped) return { state: "no", reason: "capped (until the next reading)" };
 if (reading.fiveHourUsedPct === null && reading.sevenDayUsedPct === null) {
  return { state: "no", reason: "no quota window reported" };
 }
 return { state: "no", reason: "at or over its threshold" };
}

function emptyCounts(): OutcomeCounts {
 return { sessions: 0, failed: 0, capped: 0, transient: 0 };
}

function runningByKind(open: SubstrateSessionRow[]): Record<SessionKind, number> {
 const running = Object.fromEntries(SESSION_KINDS.map((k) => [k, 0])) as Record<SessionKind, number>;
 for (const s of open) running[s.kind] += 1;
 return running;
}

/** Sessions started at or after `sinceMs`, by kind, with their non-ok outcomes. */
function countSince(sessions: SubstrateSessionRow[], sinceMs: number): SessionCounts {
 const counts = {
  total: emptyCounts(),
  ...Object.fromEntries(SESSION_KINDS.map((k) => [k, emptyCounts()])),
 } as SessionCounts;
 for (const s of sessions) {
  if (Date.parse(s.startedAt) < sinceMs) continue;
  for (const bucket of [counts[s.kind], counts.total]) {
   bucket.sessions += 1;
   if (s.outcome === "failed" || s.outcome === "capped" || s.outcome === "transient") bucket[s.outcome] += 1;
  }
 }
 return counts;
}

/**
 * An open session is running while its node's supervisor is: the worker
 * row is claimed or running and its process is alive. An open row of a dead
 * supervisor is not running (the next session of the node closes it).
 */
export function liveSession(
 workers: WorkerRow[],
 pidAlive: (pid: number | null) => boolean,
): (session: SubstrateSessionRow) => boolean {
 return (session) => {
  const w = workers.find((x) => x.repo === session.repo && x.nodeId === session.nodeId);
  return (
   w !== undefined &&
   (w.status === "claimed" || w.status === "running") &&
   w.pid !== null &&
   pidAlive(w.pid)
  );
 };
}
