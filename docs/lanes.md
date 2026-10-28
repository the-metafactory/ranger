# Lanes and the resume queue

Implement workers share the machine through two resource lanes: one visual and one headless, across all maps (node #57). This page covers how maps take turns on a lane, how to drain a lane, how host load holds work back, and how parked nodes come back through the resume queue.

## How maps share the lanes

`workers.laneSlots` sets how many implement workers each lane runs at once. The default is one visual and one headless. The daily spawn cap and the dead-man pause apply across both lanes.

A map with `commands.probe` takes the visual lane by default. Any other map takes the headless lane. A map's `lane` key overrides that choice.

Within a lane, maps take turns. The journal keeps the map of the last implement start (node #47), and the walk skips maps that are empty or gated. Claims, operator resumes, sweep respawns, and merge-desk send-backs record a start. Runs that only close a node leave the turn where it was. A PR that waits for a merge frees its lane slot. A worker whose map is unknown or ambiguous holds both lanes, to be safe. The dashboard shows the holder of each lane and the same next choices the walk would make.

## Drain a lane

`ranger drain` stops new claims without stopping work in flight (node #165).

- `ranger drain --lane visual` stops new implement claims on every visual-lane map. The machine has one visual lane, so one switch drains it. Research on a visual map still claims.
- `ranger drain --map owner/name#root` drains one headless map, which then claims nothing new. A visual map has no drain of its own.
- `--off` lifts either drain.

Sweeps, merge desks and their send-backs, and queued resumes keep running under a drain. The walk reads the drain while it holds the claim lock, and the dashboard shows the drain from the same check.

## Host load

The host is busy while its 1-minute load average is at or above `workers.busyLoad`. The default is the number of cores. `workers.laneBusyLoad` sets the threshold per lane, in the same shape as `laneSlots` (for example, `{ headless: 30 }`). A lane without an entry uses `busyLoad`, and each check reads the value for the lane it guards (node #312).

On a busy host:

- The walk claims nothing on that lane's maps.
- Every queued resume on that lane waits, whether ranger or an operator queued it. A wait is neither a start nor a failed start. It records one `reviewed` event per tick, and it does not hold back the entries behind it.
- `resume-node --when-free` queues instead of starting. A plain `resume-node` still starts at once.

Supervisor and adoption test runs wait up to 20 minutes for a quiet host, then run anyway, as the probe tier does. On 2026-10-14, soma's 6-minute suite ran past the 20-minute test timeout at a load of 45 to 55 on 10 cores.

When the supervisor's tests fail, ranger queues a resume of the node instead of failing it (node #297) in two cases:

- The one retry for a busy host also ran on a busy host, because the wait for a quiet host ran out first.
- The test timeout killed the run with no failing test while the host was busy. A hanging suite's own load can look like a busy host, so a kill parks the node once per 24 hours. A second kill counts as the node's failure.

This applies to adoption and to the tests after a worker pass. No worker session starts and no fix pass runs. The row ends `failed`, with an outcome that starts with "waiting for a quiet host: load X on N cores" and names up to three failing tests. The failure does not count toward the dead-man switch. A retry that started on a quiet host and named a failing test is the branch's failure, as before.

## Resume a node

`ranger resume-node <id>` puts a parked or failed node back in motion. Its row returns to `claimed`, and a detached `run-node` resumes it. The implement lane resumes from its PR. Use `--map owner/name#root` when the id is ambiguous.

`ranger resume-node <id> --when-free` resumes at once when the node's lane is free and no other resume waits in that lane. Otherwise, it adds a lasting first-in, first-out entry to the queue. Research resumes, and resumes that only close a node, start at once.

On each walk tick, queued resumes run after the merge desks and before new claims. An implement resume that starts reserves its lane for that tick. An entry in the queue never reserves a lane. If the head of a lane's queue cannot start, fresh claims stay eligible that tick, and later entries in that lane wait.

`ranger resume-node <id> --cancel` removes an entry, and exits non-zero when there is none. Cancelling still works after the map is deregistered. It uses the queued repo's write token and the same machine-account identity check.

### What happens to a queued entry

- The dead-man pause and the daily spawn cap keep entries in the queue.
- Ranger removes an entry, with a reason, when the node is closed, the row is released or already active, the PR is merged or closed, or the map is set to `walk: none`.
- Moving a PR's head keeps the entry valid.
- A transient graph or GitHub read error defers the head without counting a failure.
- A spawn error, a null PID (including under `RANGER_NO_SPAWN=1`), and a refusal from the identity check each count as a failed start. After three failed starts in a row, ranger drops the entry with an event that names the last error.
- A successful start removes the entry. If you queue the node again, its failure count starts from zero.
- Starts made by the walk count toward the daily spawn cap. Immediate operator resumes do not.

Plain and immediate operator resumes keep the manual mode, in which a row is claimed without a worker starting. That mode cannot start a queued resume.

## Requeue failed infrastructure probes

On the next `walk`, ranger requeues a node that parked on a failed infrastructure probe when its lane is free. The oldest goes first, across all maps. These requeues come before crash respawns, merge-desk send-backs, and fresh implement claims. Ranger never interrupts a running worker.

`workers.probeRequeues` caps the automatic requeues per node and head (default 2, and 0 turns them off). The count survives restarts. A failed spawn keeps its place and does not spend a retry. The pause, vetoes, walk mode, the map's `skip` and `nodes` lists, and the existing review and merge gates still apply.

Failures from an assertion, a page error, or an unknown cause stay parked for a person to investigate. A timeout cannot erase an assertion from the probe attempt before it. Older parks without a failure class retry only when their outcome records a signal or a timeout and no named probe failure. An operator can still run `resume-node` afterwards.
