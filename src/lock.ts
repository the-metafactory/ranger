import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { EscalateError, sleep } from "./discord.ts";
import type { Journal } from "./journal.ts";

/**
 * The announce-once cross-process lock (design §5) — extracted from
 * escalate.ts (round-37 maintainability finding). Atomic wx create + lease +
 * owner nonce + reclaim marker: only one run holds the desk at a time, a
 * renewing run is never reclaimed, a dead/crashed/recycled-pid holder's
 * expired lease is safely reclaimable, and a resumed holder whose lock was
 * reclaimed can never overwrite or unlink the new owner's lock.
 */

/** ATOMIC lock write: write the new content to a temp file then rename over
 *  the lock. A rename is atomic on POSIX, so an interrupted heartbeat can
 *  never leave the lock file UNREADABLE — a lock is either the old or the new
 *  complete JSON, never a partial write. (The wx create-only acquires are
 *  already atomic.) This is what makes "unreadable ⇒ definitively dead" a
 *  sound rule in lockOwnerStale (round-34 blocker: a non-atomic heartbeat
 *  could corrupt the lock and strand the desk forever).
 */
export function writeLockAtomic(lockFile: string, content: string): void {
  const tmp = `${lockFile}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, lockFile);
}

/** Atomic create-with-content: returns true when we now hold the lock. */
export function tryAcquireLock(lockFile: string, owner: string): boolean {
  try {
    writeFileSync(lockFile, owner, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

/**
 * Is the lock's owner a dead process (ESRCH)? Never reclaim on age or on an
 * unreadable owner — stealing a live run's lock breaks announce-once.
 */
/** A lock older than this is a dead run — no live escalate pass takes this
 *  long (throttled writes + bounded backoffs finish in minutes). The age arm
 *  catches the PID-reuse case a PID check cannot: a dead process's lock whose
 *  pid got recycled by an unrelated, still-alive process would otherwise look
 *  live forever and strand the desk (every tick times out, no cards/digests). */
/** Lease expiry (and heartbeat interval) for the announce-once lock — see
 *  `withEscalateLock`. A holder renews its lease while running, so a live run
 *  is NEVER stale, while a dead/crashed/recycled-pid holder's lease expires
 *  and the lock becomes safely reclaimable. */
const LOCK_LEASE_MS = 60_000;
/** Legacy locks (pre-lease, or the reclaim marker) fall back to age. */
const LOCK_STALE_MS = 30 * 60 * 1000;
/** The reclaim marker is held for microseconds — any marker this old is a
 *  crash artifact (immediate cleanup on a dead pid, plus this age arm for
 *  the recycled-pid case). */
const MARKER_STALE_MS = 60_000;

/**
 * Is the lock's owner provably gone? For a LEASED lock: true when its
 * `leaseUntil` has passed — a live run renews the lease, so an expired lease
 * means the holder died, crashed, or its pid got recycled (no heartbeat). For
 * legacy/marker locks: true when the recorded pid is dead (ESRCH) OR the
 * lock is older than `maxAgeMs`. A live, renewing run is never reclaimed.
 * Never reclaim on an unreadable owner — stealing a live run's lock breaks
 * announce-once.
 */
export function lockOwnerStale(
  lockFile: string,
  maxAgeMs: number = LOCK_STALE_MS,
): boolean {
  try {
    const prior = JSON.parse(readFileSync(lockFile, "utf8")) as {
      pid?: number;
      startedAt?: number;
      at?: number;
      leaseUntil?: number;
    };
    if (typeof prior.pid !== "number") return false;
    // Leased lock: the LEASE governs — an expired lease is a definitive signal
    // the holder is gone (its heartbeat stopped), which is what makes
    // PID-reuse reclaimable while never touching a live run's RENEWED lock.
    // A valid lease NEVER falls through to the age arm (a run held >30min
    // with a renewed lease is not stale — round-28 review).
    if (typeof prior.leaseUntil === "number") {
      return prior.leaseUntil < Date.now();
    }
    // Legacy / marker fallback (no lease): dead pid OR old enough to be a
    // crash artifact.
    const stamp = prior.startedAt ?? prior.at;
    if (typeof stamp === "number" && Date.now() - stamp > maxAgeMs) {
      return true;
    }
    try {
      process.kill(prior.pid, 0);
      return false;
    } catch (killError) {
      return (killError as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    /* Unreadable owner — with ATOMIC lock writes (writeLockAtomic) a live
     * holder's lock is always complete readable JSON with a valid lease, so
     * an unreadable lock can only be a crash artifact (a partial write from
     * a pre-atomic path, or a zero-length file left by a killed heartbeat).
     * It is NOT being renewed (no heartbeat can be running), so it is
     * definitively stale — reclaim it instead of stranding the desk forever
     * (round-34 blocker). */
    return true;
  }
}

/**
 * Reclaim outcome for a dead-owner lock: `acquired` (we now hold it),
 * `busy` (a live holder is mid-reclaim), or `not-dead` (the lock was
 * replaced by a live owner while we waited — do NOT delete it).
 */
type ReclaimOutcome = "acquired" | "busy" | "not-dead";

/**
 * EXCLUSIVE reclaim of a dead-owner lock. The reclaim marker is created
 * atomically (wx), so only one process can hold it and remove+re-acquire.
 * Two refinements make this both race-safe and crash-safe:
 *
 * - Stale-marker reclaim: a process that dies mid-reclaim leaves `.reclaiming`
 *   behind, which would strand every later run (EEXIST forever → timeout).
 *   When the marker's OWNER is provably dead, we remove it and retry the wx
 *   create — the desk can never permanently stop.
 * - Owner revalidation: after acquiring the marker we RE-READ the main lock
 *   and delete it only if the owner is STILL dead. If another contender
 *   reclaimed and re-acquired it while we waited for the marker, we back off
 *   instead of deleting a live lock (which would let two runs both POST).
 *
 * Returns "acquired" | "busy" | "not-dead". The residual window — a stale-
 * marker cleanup unlinking a marker re-created in the same instant — is
 * documented in docs/live-validation: its worst case is one visible duplicate
 * card, the same class as the acknowledged POST→journal crash window.
 */
export function reclaimDeadLock(
  lockFile: string,
  reclaimMarker: string,
  owner: string,
): ReclaimOutcome {
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(
        reclaimMarker,
        JSON.stringify({ pid: process.pid, at: Date.now() }),
        { flag: "wx" },
      );
      break;
    } catch (markerError) {
      if ((markerError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw markerError;
      }
      // Someone holds the marker. If its owner is provably stale (dead pid
      // or old enough to be a crashed reclaim), remove it and retry —
      // otherwise a live holder is mid-reclaim and we wait.
      if (!lockOwnerStale(reclaimMarker, MARKER_STALE_MS) || attempt >= 2) {
        return "busy";
      }
      try {
        rmSync(reclaimMarker, { force: true });
      } catch {
        return "busy"; // lost the unlink race — someone else owns the marker
      }
    }
  }
  try {
    // Revalidate the main lock before deleting it: a contender may have
    // reclaimed and re-acquired it while we waited for the marker. Delete
    // only a lock whose owner is STILL stale.
    if (!lockOwnerStale(lockFile)) {
      return "not-dead";
    }
    rmSync(lockFile, { force: true });
    writeFileSync(lockFile, owner, { flag: "wx" });
    return "acquired";
  } finally {
    try {
      rmSync(reclaimMarker, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** An acquired announce-once lease: the lock file + marker paths and the
 *  owner nonce + fresh-owner generator used by the heartbeat and release. */
interface Lease {
  lockFile: string;
  reclaimMarker: string;
  ownerNonce: string;
  leaseOwner: () => string;
}

/**
 * Acquire the announce-once lease, waiting (up to the timeout) under
 * contention and reclaiming a provably-dead/stale owner. The owner payload is
 * generated FRESH at each attempt: the wait can run ~60s, and a lease
 * computed beforehand would already be expired when acquisition succeeds —
 * letting another run reclaim our live lock before the heartbeat starts
 * (round-22 blocker).
 */
export async function acquireLease(
  lockFile: string,
  reclaimMarker: string,
): Promise<Lease> {
  const started = Date.now();
  const timeoutMs = 60_000;
  const lockStartedAt = Date.now();
  // The lock carries a LEASE and an OWNER NONCE. The lease (renewed by a
  // heartbeat while we hold the lock) makes an actively-running run
  // never-stale, so only a dead/crashed/recycled-pid holder is reclaimed.
  // The nonce FENCES the lease: if our lease ever expires and another run
  // reclaims the lock, our heartbeat and release re-read the lock and act
  // only when the nonce is still OURS — a resumed holder can never overwrite
  // or unlink a lock another run now owns (round-21 blocker).
  const ownerNonce = `${process.pid}-${randomUUID()}`;
  const leaseOwner = () =>
    JSON.stringify({
      nonce: ownerNonce,
      pid: process.pid,
      startedAt: lockStartedAt,
      leaseUntil: Date.now() + LOCK_LEASE_MS,
    });
  const lease: Lease = { lockFile, reclaimMarker, ownerNonce, leaseOwner };
  for (;;) {
    if (tryAcquireLock(lockFile, leaseOwner())) return lease;
    if (lockOwnerStale(lockFile)) {
      const outcome = reclaimDeadLock(lockFile, reclaimMarker, leaseOwner());
      if (outcome === "acquired") return lease;
      // "busy" / "not-dead" — wait and re-check the lock below.
    }
    if (Date.now() - started > timeoutMs) {
      throw new EscalateError(
        `another escalate run holds the lock (${lockFile}) — ` +
          "refusing to risk duplicate cards",
      );
    }
    await sleep(250);
  }
}

/**
 * Renew the lease while the run is live so a long (or paused) run is never
 * reclaimed by an expired lease — but only while the lock is still OURS. If
 * the nonce changed (another run reclaimed us), stop heartbeating: never
 * overwrite their lock. Returns the interval plus a ref the release uses to
 * surface a lost-ownership reclaim loudly.
 */
export function startHeartbeat(lease: Lease): {
  heartbeat: ReturnType<typeof setInterval>;
  lostOwnership: { value: boolean };
} {
  const lostOwnership = { value: false };
  const heartbeat = setInterval(() => {
    try {
      const cur = JSON.parse(readFileSync(lease.lockFile, "utf8")) as {
        nonce?: string;
      };
      if (cur.nonce !== lease.ownerNonce) {
        lostOwnership.value = true;
        clearInterval(heartbeat);
        return;
      }
      writeLockAtomic(lease.lockFile, lease.leaseOwner());
    } catch {
      /* lock released — nothing to renew */
    }
  }, LOCK_LEASE_MS / 2);
  return { heartbeat, lostOwnership };
}

/**
 * Stop the heartbeat and release the lock — but only OUR lock: if the nonce
 * changed (we were reclaimed), leave the new owner's lock alone (unlinking it
 * would let a third run in), and surface the lost-ownership reclaim loudly.
 * The `.reclaiming` marker is deliberately NOT touched here: it is owned by
 * reclaimDeadLock (removed in its own finally), and a resumed holder must
 * never unlink a marker a NEW reclaimer currently holds — doing so would let
 * a third run in and deserialize the desk (round-25 review). A crashed
 * reclaimer's marker is cleaned by the next run's stale-marker reclaim.
 */
export function releaseLease(
  lease: Lease,
  heartbeat: ReturnType<typeof setInterval>,
  lostOwnership: { value: boolean },
): void {
  clearInterval(heartbeat);
  try {
    let ours = false;
    try {
      const cur = JSON.parse(readFileSync(lease.lockFile, "utf8")) as {
        nonce?: string;
      };
      ours = cur.nonce === lease.ownerNonce;
    } catch {
      /* unreadable — nothing to release */
    }
    if (ours) rmSync(lease.lockFile, { force: true });
  } catch {
    /* best-effort release */
  }
  if (lostOwnership.value) {
    // We were reclaimed mid-run (lease expired, machine paused >60s): our
    // cards already posted this run are duplicative of the new holder's —
    // surface it loudly rather than hiding it.
    console.error(
      "[escalate] lock was reclaimed mid-run (lease expired >60s); " +
        "another run owns the desk now — check for duplicate cards",
    );
  }
}

/** Thrown when the announce-once lease is no longer OURS at a mutation
 *  boundary (round-35 blocker): a resumed holder whose lease was reclaimed
 *  must stop before its next Discord write or journal update, not after —
 *  otherwise it can post/overwrite alongside the new owner. Caught by the
 *  pass orchestration, which aborts the whole map (every further write would
 *  be dangerous) and surfaces the lost-ownership loudly.
 */
export class LeaseLostError extends EscalateError {
  override readonly name = "LeaseLostError";
}

/** Re-reads the lock and throws LeaseLostError when the nonce is no longer
 *  ours (or the lock is unreadable/released — either way we do not own it). */
export type OwnedCheck = () => void;

export async function withEscalateLock<T>(
  journal: Journal,
  fn: (owned: OwnedCheck) => Promise<T>,
): Promise<T> {
  const lockFile = join(dirname(journal.path), ".escalate.lock");
  const reclaimMarker = `${lockFile}.reclaiming`;
  const lease = await acquireLease(lockFile, reclaimMarker);
  const { heartbeat, lostOwnership } = startHeartbeat(lease);
  const owned: OwnedCheck = () => {
    try {
      const cur = JSON.parse(readFileSync(lockFile, "utf8")) as {
        nonce?: string;
      };
      if (cur.nonce !== lease.ownerNonce) {
        lostOwnership.value = true;
        throw new LeaseLostError(
          "announce-once lease lost: another run owns the desk",
        );
      }
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      // Unreadable or missing lock: a live holder's lock is always complete
      // JSON (atomic writes) and carries OUR nonce while we run — anything
      // else means the lock was reclaimed or released. Treat as lost.
      lostOwnership.value = true;
      throw new LeaseLostError(
        "announce-once lease lost: lock unreadable/released",
      );
    }
  };
  try {
    return await fn(owned);
  } finally {
    releaseLease(lease, heartbeat, lostOwnership);
  }
}
