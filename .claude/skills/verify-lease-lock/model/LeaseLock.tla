---------------------------- MODULE LeaseLock ----------------------------
(***************************************************************************)
(* The cross-process lease lock in src/lock.ts, as the file system sees    *)
(* it. Every claim, escalate, deploy, intake and fix-node lock goes        *)
(* through withOwnedLease, so this one protocol guards them all.           *)
(*                                                                         *)
(* One step = one file-system syscall. A JS process is single-threaded,    *)
(* so its own heartbeat never runs inside a synchronous function, but      *)
(* another process can act between any two of its syscalls.                *)
(*                                                                         *)
(* Each process acquires at most once (one tenure), holds, and releases.   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Procs,          \* the processes contending for one lock file
    None,           \* "no owner": the file exists but holds no parseable JSON
    AtomicCreate,   \* FALSE = the code: writeFileSync(..., {flag:"wx"}) is open(O_EXCL) THEN write
    Pauses,         \* TRUE = a live process can stall past its lease (sleep, SIGSTOP)
    RejectExpired,  \* the claim and fix-node locks pass rejectExpired: true
    AbsentIsStale   \* TRUE = the code: lockOwnerStale returns true when the file is missing (ENOENT)

VARIABLES
    lock,     \* the lock file   (lockFile)
    marker,   \* the reclaim marker (`${lockFile}.reclaiming`)
    fdL,      \* fdL[p]: p's open wx fd on the lock still names the live file
    fdM,      \* fdM[p]: same for the marker
    pc,       \* where each process is
    att,      \* reclaimDeadLock's `attempt`
    hbOn,     \* the heartbeat interval is still running (not cleared on a nonce mismatch)
    dead,     \* the process crashed: its pid is gone, it takes no more steps
    lapsed    \* the process went longer than its lease without a step (history)

vars == <<lock, marker, fdL, fdM, pc, att, hbOn, dead, lapsed>>

Absent == [ex |-> FALSE, own |-> None, fresh |-> FALSE]
Empty  == [ex |-> TRUE,  own |-> None, fresh |-> FALSE]
Leased(p) == [ex |-> TRUE, own |-> p, fresh |-> TRUE]
MAbsent == [ex |-> FALSE, own |-> None, old |-> FALSE]
MEmpty  == [ex |-> TRUE,  own |-> None, old |-> FALSE]
MOwned(p) == [ex |-> TRUE, own |-> p, old |-> FALSE]

NoFd == [q \in Procs |-> FALSE]
OnlyFd(p) == [q \in Procs |-> q = p]

\* lockOwnerStale(lockFile): a missing or unparseable file throws into the
\* catch and counts as stale; a leased lock is stale once leaseUntil passed.
LockStale == IF lock.ex THEN lock.own = None \/ ~lock.fresh ELSE AbsentIsStale

\* lockOwnerStale(reclaimMarker, MARKER_STALE_MS): the marker has no
\* leaseUntil, so it is stale when unreadable, older than 60 s, or its pid is dead.
MarkerStale == ~marker.ex \/ marker.own = None \/ marker.old \/ marker.own \in dead

Holding(p) == p \notin dead /\ pc[p] \in {"holding", "hbWrite"}

Init ==
    /\ lock = Absent
    /\ marker = MAbsent
    /\ fdL = NoFd
    /\ fdM = NoFd
    /\ pc = [p \in Procs |-> "try"]
    /\ att = [p \in Procs |-> 0]
    /\ hbOn = [p \in Procs |-> TRUE]
    /\ dead = {}
    /\ lapsed = [p \in Procs |-> FALSE]

Live(p) == p \notin dead
Go(p, from, to) == pc[p] = from /\ pc' = [pc EXCEPT ![p] = to]

(* ---- acquireLease: tryAcquireLock(lockFile, leaseOwner()) ---- *)
TryCreate(p) ==
    /\ Live(p) /\ pc[p] = "try"
    /\ IF ~lock.ex
       THEN IF AtomicCreate
            THEN /\ lock' = Leased(p) /\ fdL' = NoFd
                 /\ pc' = [pc EXCEPT ![p] = "holding"]
            ELSE /\ lock' = Empty /\ fdL' = OnlyFd(p)
                 /\ pc' = [pc EXCEPT ![p] = "tryWrite"]
       ELSE /\ pc' = [pc EXCEPT ![p] = "chkLock"]
            /\ UNCHANGED <<lock, fdL>>
    /\ UNCHANGED <<marker, fdM, att, hbOn, dead, lapsed>>

\* the write half of writeFileSync(wx): lands on our inode, which may be unlinked
TryWrite(p) ==
    /\ Live(p) /\ Go(p, "tryWrite", "holding")
    /\ lock' = IF fdL[p] THEN Leased(p) ELSE lock
    /\ UNCHANGED <<marker, fdL, fdM, att, hbOn, dead, lapsed>>

(* ---- acquireLease: if (lockOwnerStale(lockFile)) reclaim, else sleep ---- *)
ChkLock(p) ==
    /\ Live(p) /\ pc[p] = "chkLock"
    /\ pc' = [pc EXCEPT ![p] = IF LockStale THEN "mkMarker" ELSE "try"]
    /\ att' = [att EXCEPT ![p] = 0]
    /\ UNCHANGED <<lock, marker, fdL, fdM, hbOn, dead, lapsed>>

(* ---- reclaimDeadLock: writeFileSync(reclaimMarker, ..., {flag:"wx"}) ---- *)
MkMarker(p) ==
    /\ Live(p) /\ pc[p] = "mkMarker"
    /\ IF ~marker.ex
       THEN IF AtomicCreate
            THEN /\ marker' = MOwned(p) /\ fdM' = NoFd
                 /\ pc' = [pc EXCEPT ![p] = "revalidate"]
            ELSE /\ marker' = MEmpty /\ fdM' = OnlyFd(p)
                 /\ pc' = [pc EXCEPT ![p] = "mkMarkerWrite"]
       ELSE /\ pc' = [pc EXCEPT ![p] = "chkMarker"]
            /\ UNCHANGED <<marker, fdM>>
    /\ UNCHANGED <<lock, fdL, att, hbOn, dead, lapsed>>

MkMarkerWrite(p) ==
    /\ Live(p) /\ Go(p, "mkMarkerWrite", "revalidate")
    /\ marker' = IF fdM[p] THEN MOwned(p) ELSE marker
    /\ UNCHANGED <<lock, fdL, fdM, att, hbOn, dead, lapsed>>

\* if (!lockOwnerStale(reclaimMarker, MARKER_STALE_MS) || attempt >= 2) return "busy"
ChkMarker(p) ==
    /\ Live(p) /\ pc[p] = "chkMarker"
    /\ pc' = [pc EXCEPT ![p] = IF MarkerStale /\ att[p] < 2 THEN "rmMarker" ELSE "try"]
    /\ UNCHANGED <<lock, marker, fdL, fdM, att, hbOn, dead, lapsed>>

\* rmSync(reclaimMarker, {force: true}); then retry the wx create
RmMarker(p) ==
    /\ Live(p) /\ Go(p, "rmMarker", "mkMarker")
    /\ marker' = MAbsent /\ fdM' = NoFd
    /\ att' = [att EXCEPT ![p] = @ + 1]
    /\ UNCHANGED <<lock, fdL, hbOn, dead, lapsed>>

\* if (!lockOwnerStale(lockFile)) return "not-dead"   (the finally drops the marker)
Revalidate(p) ==
    /\ Live(p) /\ pc[p] = "revalidate"
    /\ pc' = [pc EXCEPT ![p] = IF LockStale THEN "rmLock" ELSE "dropMarkerBusy"]
    /\ UNCHANGED <<lock, marker, fdL, fdM, att, hbOn, dead, lapsed>>

\* rmSync(lockFile, {force: true})
RmLock(p) ==
    /\ Live(p) /\ Go(p, "rmLock", "mkLock")
    /\ lock' = Absent /\ fdL' = NoFd
    /\ UNCHANGED <<marker, fdM, att, hbOn, dead, lapsed>>

\* writeFileSync(lockFile, owner, {flag:"wx"}); EEXIST is not caught: acquire throws
MkLock(p) ==
    /\ Live(p) /\ pc[p] = "mkLock"
    /\ IF ~lock.ex
       THEN IF AtomicCreate
            THEN /\ lock' = Leased(p) /\ fdL' = NoFd
                 /\ pc' = [pc EXCEPT ![p] = "dropMarkerAcq"]
            ELSE /\ lock' = Empty /\ fdL' = OnlyFd(p)
                 /\ pc' = [pc EXCEPT ![p] = "mkLockWrite"]
       ELSE /\ pc' = [pc EXCEPT ![p] = "dropMarkerErr"]
            /\ UNCHANGED <<lock, fdL>>
    /\ UNCHANGED <<marker, fdM, att, hbOn, dead, lapsed>>

MkLockWrite(p) ==
    /\ Live(p) /\ Go(p, "mkLockWrite", "dropMarkerAcq")
    /\ lock' = IF fdL[p] THEN Leased(p) ELSE lock
    /\ UNCHANGED <<marker, fdL, fdM, att, hbOn, dead, lapsed>>

\* the finally: rmSync(reclaimMarker, {force: true}) - removes whatever marker is there
DropMarker(p, from, to) ==
    /\ Live(p) /\ Go(p, from, to)
    /\ marker' = MAbsent /\ fdM' = NoFd
    /\ UNCHANGED <<lock, fdL, att, hbOn, dead, lapsed>>

DropMarkerAcq(p)  == DropMarker(p, "dropMarkerAcq", "holding")
DropMarkerBusy(p) == DropMarker(p, "dropMarkerBusy", "try")
DropMarkerErr(p)  == DropMarker(p, "dropMarkerErr", "failed")

(* ---- startHeartbeat: read the lock, renew it only while the nonce is ours ---- *)
HbRead(p) ==
    /\ Live(p) /\ pc[p] = "holding" /\ hbOn[p]
    /\ \/ /\ lock.ex /\ lock.own = p
          /\ pc' = [pc EXCEPT ![p] = "hbWrite"]
          /\ UNCHANGED hbOn
       \/ /\ lock.ex /\ lock.own \notin {p, None}
          /\ hbOn' = [hbOn EXCEPT ![p] = FALSE]
          /\ UNCHANGED pc
    /\ UNCHANGED <<lock, marker, fdL, fdM, att, dead, lapsed>>

\* writeLockAtomic: write the tmp file, rename it over the lock (a new inode)
HbWrite(p) ==
    /\ Live(p) /\ Go(p, "hbWrite", "holding")
    /\ lock' = Leased(p) /\ fdL' = NoFd
    /\ UNCHANGED <<marker, fdM, att, hbOn, dead, lapsed>>

(* ---- leaseOwnedCheck: the owned fence fails, the callback throws ---- *)
FenceFails(p) ==
    /\ Live(p) /\ pc[p] = "holding"
    /\ ~(lock.ex /\ lock.own = p /\ (RejectExpired => lock.fresh))
    /\ pc' = [pc EXCEPT ![p] = "relRead"]
    /\ UNCHANGED <<lock, marker, fdL, fdM, att, hbOn, dead, lapsed>>

\* the callback returns
Finish(p) ==
    /\ Live(p) /\ Go(p, "holding", "relRead")
    /\ UNCHANGED <<lock, marker, fdL, fdM, att, hbOn, dead, lapsed>>

(* ---- releaseLease: read the lock, unlink it only when the nonce is ours ---- *)
RelRead(p) ==
    /\ Live(p) /\ pc[p] = "relRead"
    /\ pc' = [pc EXCEPT ![p] = IF lock.ex /\ lock.own = p THEN "relRm" ELSE "done"]
    /\ UNCHANGED <<lock, marker, fdL, fdM, att, hbOn, dead, lapsed>>

RelRm(p) ==
    /\ Live(p) /\ Go(p, "relRm", "done")
    /\ lock' = Absent /\ fdL' = NoFd
    /\ UNCHANGED <<marker, fdM, att, hbOn, dead, lapsed>>

(* ---- the environment: time passes, processes stall or die ---- *)
Crash(p) ==
    /\ Live(p) /\ pc[p] \notin {"done", "failed"}
    /\ dead' = dead \cup {p}
    /\ UNCHANGED <<lock, marker, fdL, fdM, pc, att, hbOn, lapsed>>

\* leaseUntil passes with no heartbeat: the owner is dead, or (Pauses) stalled
LeaseExpires ==
    /\ lock.ex /\ lock.own # None /\ lock.fresh
    /\ Pauses \/ lock.own \in dead
    /\ lock' = [lock EXCEPT !.fresh = FALSE]
    /\ lapsed' = [lapsed EXCEPT ![lock.own] = TRUE]
    /\ UNCHANGED <<marker, fdL, fdM, pc, att, hbOn, dead>>

\* the marker passes MARKER_STALE_MS while its owner stalls mid-reclaim
MarkerAges ==
    /\ Pauses
    /\ marker.ex /\ marker.own # None /\ ~marker.old
    /\ marker' = [marker EXCEPT !.old = TRUE]
    /\ lapsed' = [lapsed EXCEPT ![marker.own] = TRUE]
    /\ UNCHANGED <<lock, fdL, fdM, pc, att, hbOn, dead>>

Terminated ==
    /\ \A p \in Procs : pc[p] \in {"done", "failed"} \/ p \in dead
    /\ UNCHANGED vars

Next ==
    \/ \E p \in Procs :
        \/ TryCreate(p) \/ TryWrite(p) \/ ChkLock(p)
        \/ MkMarker(p) \/ MkMarkerWrite(p) \/ ChkMarker(p) \/ RmMarker(p)
        \/ Revalidate(p) \/ RmLock(p) \/ MkLock(p) \/ MkLockWrite(p)
        \/ DropMarkerAcq(p) \/ DropMarkerBusy(p) \/ DropMarkerErr(p)
        \/ HbRead(p) \/ HbWrite(p) \/ FenceFails(p) \/ Finish(p)
        \/ RelRead(p) \/ RelRm(p) \/ Crash(p)
    \/ LeaseExpires
    \/ MarkerAges
    \/ Terminated

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* The promise in lock.ts's header: "only one run holds the desk at a      *)
(* time, a renewing run is never reclaimed". Two processes may overlap     *)
(* only when one of them went past its lease (it stalled or died); that    *)
(* overlap is the residual the header and claim-lock.ts accept.            *)
(***************************************************************************)
MutualExclusion ==
    \A p, q \in Procs :
        (p # q /\ Holding(p) /\ Holding(q)) => (lapsed[p] \/ lapsed[q])

TypeOK ==
    /\ pc \in [Procs -> {"try", "tryWrite", "chkLock", "mkMarker", "mkMarkerWrite",
                         "chkMarker", "rmMarker", "revalidate", "rmLock", "mkLock",
                         "mkLockWrite", "dropMarkerAcq", "dropMarkerBusy",
                         "dropMarkerErr", "holding", "hbWrite", "relRead", "relRm",
                         "done", "failed"}]
    /\ att \in [Procs -> 0..2]
    /\ dead \subseteq Procs
=============================================================================
