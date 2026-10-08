import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Journal } from "./journal.ts";
import { type OwnedCheck, withOwnedLease } from "./lock.ts";

/**
 * The claim lock (node #58): one cross-process lease that the walk and
 * `ranger build-now` each hold while they claim. The walk holds it for a
 * map's whole claim phase (the gate reads, the frontier read, the plan and
 * every claim in it); build-now holds it from its gate reads through its
 * spawn. Both claim under the same bot identity, so the graph claim alone
 * lets two claimers of one node through; under the lock, the second reads
 * the gates (the node's row, the daily spawn cap, the implement-lane holder)
 * only after the first has written its `claimed` row and counted its spawn.
 *
 * Operator resumes, the walk's queued-resume pass and automatic probe
 * requeues also take it while reserving a lane and starting their child.
 * The merge desk's send-back of a ready PR starts workers without it; a
 * lane read under the lock can still be joined by a send-back
 * before the claim's row lands. Neither does a claimer re-read the pause or
 * a veto after its gate check: one recorded during a claimer's announce is
 * seen by the next claim, as in the walk before this lock.
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
 * How long the walk waits for a build-now to finish its one claim (its
 * frontier read, announce, claim and spawn are each bounded). Past it the
 * walk leaves that map unclaimed for the tick, and the next tick claims.
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
 return withOwnedLease(
  lockFile,
  {
   timeoutMs,
   contended: () =>
    new ClaimLockBusy(`another claim holds the claim lock (${lockFile}) for over ${Math.round(timeoutMs / 1000)} s`),
   lost: (why) => new ClaimLeaseLost(`claim lock lost mid-claim (${why}) — stopped before the next write`),
   rejectExpired: true,
   lostMessage:
    "[claim] claim lock was lost mid-claim (lease expired >60s) — the claim stopped at its next write; check for a write made before it",
  },
  fn,
 );
}
