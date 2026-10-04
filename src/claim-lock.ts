import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Journal } from "./journal.ts";
import { acquireLease, leaseOwnedCheck, type OwnedCheck, releaseLease, startHeartbeat } from "./lock.ts";

/**
 * The claim lock (node #58): one cross-process lease over "check the claim
 * gates, then claim and write the journal". The walk and `ranger build-now`
 * both take it around each claim, so the gates they read (the node's row, the
 * daily spawn cap, the implement-lane holder) cannot change between the check
 * and the `claimed` row: while the lease holds, two concurrent claims are
 * serialized, and the second re-reads the gates after the first has written
 * its row and counted its spawn. Both claim under the same bot identity, so
 * the graph claim alone would let both through.
 * Both also read the frontier under it, so a node blocked or re-routed while
 * a claimer waited for the lease is seen before its claim.
 *
 * It is the announce-once lease (`lock.ts`): atomic create, renewed while
 * held, reclaimable once its lease expires. A holder stopped past the lease
 * (a suspended laptop, SIGSTOP) can be reclaimed while its callback still
 * runs, so the callback gets an `owned` fence. `claimNode` calls it before
 * the announce, before the graph claim, and before the journal writes that
 * precede the spawn (no await between those and the spawn): a holder whose
 * lease expired or was reclaimed throws `ClaimLeaseLost` at its next fence
 * instead of writing beside the new holder. The residual window is a stop
 * between a passed fence and the writes right after it, the same class as
 * the escalate desk's (`lock.ts`).
 *
 * The lock lives next to the journal; an in-memory journal (tests) gets a
 * lock of its own under tmpdir.
 */

/**
 * How long a claim waits for another claim to finish (the frontier read,
 * announce, claim and spawn are each bounded). A holder near every bound at
 * once (build-now: ~150 s) outlasts it; the walk then stops claiming that map
 * for the tick, and the next tick claims.
 */
export const CLAIM_LOCK_TIMEOUT_MS = 120_000;

export class ClaimLockBusy extends Error {
 override readonly name = "ClaimLockBusy";
}

/** The claim lock was reclaimed (or its lease expired) mid-claim: stop before the next mutation. */
export class ClaimLeaseLost extends Error {
 override readonly name = "ClaimLeaseLost";
}

const memoryLocks = new WeakMap<Journal, string>();

export function claimLockFile(journal: Journal): string {
 if (journal.path !== ":memory:") return join(dirname(journal.path), ".claim.lock");
 let file = memoryLocks.get(journal);
 if (file === undefined) {
  file = join(tmpdir(), `ranger-claim-${process.pid}-${randomUUID()}.lock`);
  memoryLocks.set(journal, file);
 }
 return file;
}

export async function withClaimLock<T>(
 journal: Journal,
 fn: (owned: OwnedCheck) => Promise<T>,
 timeoutMs = CLAIM_LOCK_TIMEOUT_MS,
): Promise<T> {
 const lockFile = claimLockFile(journal);
 const lease = await acquireLease(lockFile, `${lockFile}.reclaiming`, {
  timeoutMs,
  contended: () =>
   new ClaimLockBusy(`another claim holds the claim lock (${lockFile}) for over ${Math.round(timeoutMs / 1000)} s`),
 });
 const { heartbeat, lostOwnership } = startHeartbeat(lease);
 const owned = leaseOwnedCheck(
  lease,
  lostOwnership,
  (why) => new ClaimLeaseLost(`claim lock lost mid-claim (${why}) — stopped before the next write`),
  { rejectExpired: true },
 );
 try {
  return await fn(owned);
 } finally {
  releaseLease(
   lease,
   heartbeat,
   lostOwnership,
   "[claim] claim lock was lost mid-claim (lease expired >60s) — the claim stopped at its next write; check for a write made before it",
  );
 }
}
