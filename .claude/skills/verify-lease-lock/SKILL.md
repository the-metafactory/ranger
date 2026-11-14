---
name: verify-lease-lock
description: Model-check ranger's cross-process lease lock (src/lock.ts) with TLA+/TLC. The claim, escalate, deploy, intake and fix-node locks all use it. Use when a change touches src/lock.ts (tryAcquireLock, lockOwnerStale, reclaimDeadLock, acquireLease, startHeartbeat, releaseLease, leaseOwnedCheck, withOwnedLease) or changes how a caller uses the lock, and before calling such a change done.
sync-commit: 7fb2488
---

# verify-lease-lock

`src/lock.ts` is the only thing that stops two ranger processes from doing
the same work at once. The walk, `build-now`, resume and `stop-node` claim
under it (`src/claim-lock.ts`). The escalate desk posts Discord cards under
it, and deploys, intake and fix-node filing run under it
(`src/deploy.ts`, `src/intake.ts`, `src/fix-node-lock.ts`). Tests cannot
reach its bugs, because those bugs need another process to act between two
syscalls. This skill checks every interleaving of three or four processes
against a TLA+ model of the file-system steps.

**The rule (`MutualExclusion`).** Two processes never hold the lock at the
same time, unless one of them went longer than its 60 s lease without a step
(it stalled or died). This is the promise in lock.ts's header: "only one run
holds the desk at a time, a renewing run is never reclaimed".

**The harm when it breaks.** Two holders run at once. A caller that never
calls the `owned` fence keeps running side by side with the other holder:
the walk's job pass (`src/walk.ts`, `withClaimLock(journal, () => jobPass(...))`)
is one. A caller that does call the fence stops the older holder at its next
fence, but not a write it has already started. The deploy lock
(`src/deploy.ts`) calls the fence once, right before the deploy command, so a
deploy that passed the fence before its lock was deleted still runs.

## Run it

From the repo root:

```sh
.claude/skills/verify-lease-lock/scripts/check.sh
bun test ./.claude/skills/verify-lease-lock/replay/reclaim-unlinks-new-lock.test.ts
```

`check.sh` needs Java 11 or later: `java` on PATH, Homebrew's
`openjdk` (`brew install openjdk`), or `JAVA=/path/to/java`. On the first run
it downloads TLC 1.7.4 (`tla2tools.jar`) to `~/.cache/ranger-tla/` and checks
its sha256 (set `TLA2TOOLS` to use your own copy). The run takes about 20 s.
It runs each config in `model/expected.tsv` with one TLC worker, so the
shortest counterexample is the same on every run, and it compares the
outcome with the expected line:

- `ok` means that the outcome matches.
- `CHANGED` means that a config passed when a break was expected, broke
  when a pass was expected, or broke along a different shortest path. The
  script keeps the TLC output and prints its path. The exit code is 1.
- A `NOTE:` line means that `src/lock.ts` differs from `sync-commit`, so
  you need to confirm that the model still describes the code (see "Keep the
  model in step" below).

The replay test runs the real `src/lock.ts` through the shortest
counterexamples, one model step per syscall. It intercepts `rmSync` on the
lock path to run the other process's step at the exact point that the trace
names. The test asserts that the bug **happens**, so it fails after the bug
is fixed. That failure is the signal to update `expected.tsv` and the
findings below.

## The configs

| Config | Model switches | Expected | Why it is there |
| --- | --- | --- | --- |
| `code` | the code as it is: `AtomicCreate=FALSE`, `AbsentIsStale=TRUE`, `Pauses=TRUE`, 3 processes | breaks (F1, half-written trigger) | the faithful model |
| `pauses-only` | creates atomic, a missing lock not stale, stalls allowed | breaks (F1, stalled-release trigger) | shows that F1 survives both one-line fixes |
| `no-triggers` | atomic, missing not stale, no stalls (crashes still allowed), 3 processes | **passes** (18,549 states) | the regression gate for the rest of the protocol |
| `crashed-reclaimer` | as `no-triggers`, 4 processes | breaks (F2) | the race that lock.ts's own comment documents |

`no-triggers` is the config that catches a new bug. The other three pin the
known findings: if one of them changes, the change either fixed a finding
or made it worse, so read the new path.

`AtomicCreate`, `AbsentIsStale` and `Pauses` describe hypothetical code
(atomic writes, a missing file not treated as stale) and a calmer
environment (no stalls). Only `code` describes the code as it is.

## Findings at sync-commit

**F1: a reclaim unlinks a live lock.** `reclaimDeadLock` reads the lock
(`lockOwnerStale(lockFile)`, line 175) and then unlinks whatever file sits at
that path (`rmSync(lockFile)`, line 178). `tryAcquireLock` does not take the
reclaim marker, so a lock created between those two syscalls is deleted.
Then the reclaimer and the creator both hold the lock. No stall and no crash
are needed. TLC finds three ways in:

1. *A missing lock* (`no-triggers` with `AbsentIsStale=TRUE`, which is the
   code). p1 holds. p2's `tryAcquireLock` gets EEXIST. p1 releases. p2's
   `lockOwnerStale` reads ENOENT, and the catch returns true. p2 takes the
   marker and re-reads the lock: it is still missing, so it counts as stale.
   p3 creates the lock and holds it. p2 unlinks p3's lock and creates its
   own. p2 and p3 both hold. A walk that takes the claim lock several times
   per tick can play p1 and p3 on its own.
2. *A half-written lock* (`code`). `writeFileSync(..., {flag: "wx"})` opens
   with O_EXCL first and writes after. Between the two, the file is empty,
   and `lockOwnerStale` counts an unparseable file as stale. p2 takes the
   marker and re-reads the still-empty lock. p1 finishes its write and
   holds. p2 unlinks p1's lock, and p3 creates and holds. p1 and p3 both
   hold.
3. *A stalled release* (`pauses-only`). p1 reads its own nonce in
   `releaseLease` and then stalls past its lease. p2 reclaims as far as the
   re-read. p1 wakes and unlinks its own lock. p3 creates. p2 unlinks p3's
   lock and creates its own. p2 and p3 both hold, and neither stalled.

The replay test confirms 1 and 2 on the real code.

**F2: two waiters reclaim the same crashed marker** (`crashed-reclaimer`).
p1 holds and crashes, and its lease expires. p2 takes the marker to reclaim
and crashes. p3 and p4 both read the marker as stale (its pid is dead). Each
removes it and creates its own, so both are in the reclaim at once, and both
end up holding. lock.ts's comment above `reclaimDeadLock` accepts this window
("a stale-marker cleanup unlinking a marker re-created in the same instant").
The model shows that it does not need the same instant, only a crashed
reclaimer and two waiters.

Do not "fix" a finding by weakening `MutualExclusion` or the model. A finding
leaves this list only when a code change makes its config's outcome change,
and you have read the new outcome.

## Is this change covered?

| Model action | Code (src/lock.ts at sync-commit) |
| --- | --- |
| `TryCreate`, `TryWrite` | `tryAcquireLock`, the `writeFileSync(lockFile, owner, {flag: "wx"})` at line 33: open with O_EXCL, then write |
| `ChkLock` | `acquireLease`, `if (lockOwnerStale(lockFile))` at line 233; a lock that is not stale sends it back to `try` (the 250 ms sleep) |
| `LockStale`, `MarkerStale` | `lockOwnerStale`, lines 71–113: the lease arm for the lock; the pid and age arm for the marker; a read or parse error counts as stale |
| `MkMarker`, `MkMarkerWrite`, `ChkMarker`, `RmMarker` | `reclaimDeadLock`'s marker loop, lines 146–170, with `attempt >= 2` |
| `Revalidate`, `RmLock`, `MkLock`, `MkLockWrite` | lines 175–180; an EEXIST at line 179 is not caught, so acquire throws (`dropMarkerErr`, then `failed`) |
| `DropMarkerAcq`, `DropMarkerBusy`, `DropMarkerErr` | the `finally` at lines 181–186 |
| `HbRead`, `HbWrite` | `startHeartbeat`'s interval body, lines 261–275, and `writeLockAtomic` (tmp file, then rename) |
| `FenceFails` | `leaseOwnedCheck`, lines 342–369 (`RejectExpired` is the `rejectExpired` option) |
| `Finish`, `RelRead`, `RelRm` | `releaseLease`, lines 289–317 |
| `Crash`, `LeaseExpires`, `MarkerAges` | the environment: a process dies; 60 s pass with no heartbeat (the owner is dead or, with `Pauses`, stalled); a marker passes MARKER_STALE_MS |

One action is one syscall. A JS process runs single-threaded, so its own
heartbeat never fires inside a synchronous function such as
`reclaimDeadLock`, but another process can act between any two of its
syscalls. That is why the model splits `writeFileSync(wx)` into a create step
and a write step: a write lands on the inode that the process opened, even
after another process has unlinked that inode (`fdL` and `fdM`).

A change is covered when it touches one of the functions above, or when it
changes how a caller holds the lock: it starts or stops calling `owned`,
passes `rejectExpired`, or adds a new lock built on `withOwnedLease`. A change
to only what a callback does under the lock is not covered.

## When the check reports CHANGED

1. Read the path in plain words with the `/statechart` skill. Pass it
   `model/LeaseLock.tla`, the config that changed, and the view
   `model/view.ts`, which names each step by process and syscall. When the
   check passes, `/statechart` draws how the system moves between states
   instead. Its TLC is the same 1.7.4 jar. Point it at this skill's cached
   jar and Java as its "Running without mise" section says.
2. Replay the path against the code. Walk it step by step in the coverage
   table. Each step must be a syscall that the code makes in that order. If
   the code cannot take a step (for example, the model lets an action run
   that the code guards), the model is wrong: fix the model, then rerun.
3. If every step is real, it is a bug in the change, or a finding fixed or
   moved. Extend `replay/reclaim-unlinks-new-lock.test.ts` with the new
   path, as its two tests do, so that it runs on the real code.
4. Change `expected.tsv` only for a reason that you can state. A finding was
   fixed, or a finding's path moved for a reason that you traced. Write the
   reason in the commit message.

## Keep the model in step

When `src/lock.ts` changes:

1. Diff it against `sync-commit`: `git diff <sync-commit> -- src/lock.ts`.
2. For each changed syscall or branch, edit the matching action in
   `model/LeaseLock.tla`, and update the line numbers in the coverage table.
   A new file, a new read, or a new unlink is a new action. Two syscalls never
   merge into one action.
3. Run `check.sh` and the replay test.
4. Move `sync-commit` in this file's frontmatter to the commit you checked,
   and only once you have confirmed that every action matches the code at
   that commit.

## What this does not cover

- Three processes in three configs and four in one. A path that needs more
  processes, or more than one tenure per process, is not checked. Each model
  process acquires at most once. The real walk takes the claim lock several
  times per tick, which makes F1 trigger 1 easier to hit than the model's
  three processes suggest.
- Pid reuse, the shared `${lockFile}.tmp` path in `writeLockAtomic`, and
  legacy locks that have no `leaseUntil`.
- Clock skew. Time is abstract: a lease is valid or expired, and a marker is
  fresh or old.
- What a callback does under the lock, and whether each caller calls the
  fence before each write. The rule is about holding the lock, not about the
  writes made while holding it.
- The rule is safety only. Liveness (a waiter that never gets the lock) is
  not checked.
