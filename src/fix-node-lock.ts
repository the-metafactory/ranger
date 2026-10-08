import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Journal } from "./journal.ts";
import { type OwnedCheck, withOwnedLease } from "./lock.ts";

/**
 * The fix-the-base filing lock (node #152): one cross-process lease per
 * journal record key (map and probe), held across the record read, the
 * status read, the add or link, and the record write. Two runs of one map
 * (`--force` lets them overlap) that confirm the same probe red would
 * otherwise both read no record, both add, and keep only the last node.
 *
 * It is the claim lock's lease (`claim-lock.ts`): atomic create, renewed
 * while held, reclaimable once it expires, with an `owned` fence the filer
 * calls before each write. The lock lives next to the journal under a hash
 * of the key (probe names are paths); an in-memory journal gets its own
 * under tmpdir.
 */

/** A holder needs at most a status read and an add, 60 s each. */
export const FIX_NODE_LOCK_TIMEOUT_MS = 150_000;

export class FixNodeLockBusy extends Error {
 override readonly name = "FixNodeLockBusy";
}

export class FixNodeLeaseLost extends Error {
 override readonly name = "FixNodeLeaseLost";
}

const memoryPrefixes = new WeakMap<Journal, string>();

export function fixNodeLockFile(journal: Journal, key: string): string {
 const name = `.base-red-fix.${createHash("sha256").update(key).digest("hex").slice(0, 16)}.lock`;
 if (journal.path !== ":memory:") return join(dirname(journal.path), name);
 let prefix = memoryPrefixes.get(journal);
 if (prefix === undefined) {
  prefix = join(tmpdir(), `ranger-fix-${process.pid}-${randomUUID()}`);
  memoryPrefixes.set(journal, prefix);
 }
 return `${prefix}${name}`;
}

export async function withFixNodeLock<T>(
 journal: Journal,
 key: string,
 fn: (owned: OwnedCheck) => Promise<T>,
 timeoutMs = FIX_NODE_LOCK_TIMEOUT_MS,
): Promise<T> {
 const lockFile = fixNodeLockFile(journal, key);
 return withOwnedLease(
  lockFile,
  {
   timeoutMs,
   contended: () => new FixNodeLockBusy(`another run holds the fix-the-base lock (${lockFile}) for over ${Math.round(timeoutMs / 1000)} s`),
   lost: (why) => new FixNodeLeaseLost(`fix-the-base lock lost (${why}) — stopped before the next write`),
   rejectExpired: true,
   lostMessage: "[fix-node] fix-the-base lock was lost mid-filing — check for a duplicate fix node",
  },
  fn,
 );
}
