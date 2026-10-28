# Scheduled jobs

A job is a skill that ranger runs headless on a resource lane, outside the graph (node #301). A job opens no PR, claims no node, and writes nothing to the graph.

## Declare a job

Declare each job under `jobs` in `ranger.yaml`:

```yaml
jobs:
  - name: daily-short          # what `ranger job enqueue` takes; the ledger's ran.ref
    skill: daily-short         # `/daily-short` on Claude; "Use the … skill." elsewhere
    prompt: ""                 # optional text after the skill
    lane: visual               # visual | headless
    wallClockMin: 90           # past it, the session's process group is killed
    cwd: ~/work/far-between/shorts
    substrates: [claude]       # optional; default all three, picked by quota
    requireResult: true        # optional; a clean exit with no result fails
```

## Queue and run a job

`ranger job enqueue <name>` queues one run. A Reflex fire runs this command through a cortex process spec. A second enqueue while that run is still queued does nothing. An unknown name exits 1 and queues nothing. `ranger job list` prints the runs.

The tick's job pass runs after the merge desks and the queued resumes, and before fresh claims. A queued run starts when its lane is free. It waits while the walk is paused, the visual lane is drained, the daily spawn cap is spent, or the lane is held. A running job holds its lane as an implement session does (`laneHolder`), so a visual job never runs beside a visual implement session.

The tick starts a detached `ranger job run <id>`. That process picks the substrate by quota from the job's `substrates`, and takes the first one when the pick falls outside that list. It runs the session in `cwd` under the worker host environment: no ranger credentials and a journal for that session only. It logs to `<journal dir>/logs/jobs/<name>-<id>.log`. A visual job runs at normal CPU priority. A headless job runs at `workers.niceness`.

## Report a run

Each finished run is reported as an `execution.run.finished` envelope with `ran: {kind: job, ref: <name>}`, `succeeded` or `failed`, the session log as `detail_ref`, and a `run_id` fixed when the run was queued. The reason a run failed (`budget`, `exit <n>`, `no result`, `crashed`, or `spawn`) stays in the journal row, because the envelope carries no free text.

The run is marked as reported once its envelope reaches the ledger. The next tick's sweep reports a process that stopped before that point. A crash between the hand-off and the mark sends the envelope again with the same `run_id`. As with the tick and `run-node`, a failed hand-off does not stop the run: a failed ledger write records a `ledger-failed` journal event and is not retried.

## Return a result

A session reports what it produced by writing one line to `$RANGER_JOB_RESULT_FILE`. On a succeeded run, a relative `soma:` path goes into the envelope as `result_ref` (myelin v0.10.0). Anything else, such as a URL, stays in the journal row only. To surface a URL, write a small soma file that holds it and report that file's `soma:` path.

With `requireResult: true`, a session that exits 0 without writing a result fails as `no result`. A skill that a gate stopped cleanly is not reported as a success.

## Crashed runs

The next tick marks a running row whose supervisor died as failed, with the reason `crashed`. Ranger kills the session's process group once `ps` confirms that the group still runs the job's skill.
