import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Journal } from "./journal.ts";
import { acquireLease, releaseLease, startHeartbeat } from "./lock.ts";

/**
 * The claim lock (node #58): one cross-process lease over "check the claim
 * gates, then claim and write the journal". The walk and `ranger build-now`
 * both take it around each claim, so the gates they read (the node's row, the
 * daily spawn cap, the implement-lane holder) cannot change between the check
 * and the `claimed` row: two concurrent claims are serialized, and the second
 * re-reads the gates after the first has written its row and counted its
 * spawn. Both claim under the same bot identity, so the graph claim alone
 * would let both through.
 *
 * It is the announce-once lease (`lock.ts`): atomic create, renewed while
 * held, reclaimable only once its holder is gone. The lock lives next to the
 * journal; an in-memory journal (tests) gets a lock of its own under tmpdir.
 */

/** How long a claim waits for another claim to finish (announce + claim + spawn are each bounded). */
export const CLAIM_LOCK_TIMEOUT_MS = 120_000;

export class ClaimLockBusy extends Error {
 override readonly name = "ClaimLockBusy";
}

const memoryLocks = new WeakMap<Journal, string>();

function claimLockFile(journal: Journal): string {
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
 fn: () => Promise<T>,
 timeoutMs = CLAIM_LOCK_TIMEOUT_MS,
): Promise<T> {
 const lockFile = claimLockFile(journal);
 const lease = await acquireLease(lockFile, `${lockFile}.reclaiming`, {
  timeoutMs,
  contended: () =>
   new ClaimLockBusy(`another claim holds the claim lock (${lockFile}) for over ${Math.round(timeoutMs / 1000)} s`),
 });
 const { heartbeat, lostOwnership } = startHeartbeat(lease);
 try {
  return await fn();
 } finally {
  releaseLease(lease, heartbeat, lostOwnership);
 }
}
