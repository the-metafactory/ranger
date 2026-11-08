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
    claudeSession:             # optional; a smaller startup on Claude
      settings: ~/work/far-between/shorts/install/daily-short-job.settings.json
      skillsDir: ~/.config/ranger/job-skills   # optional; loads its .claude/skills
```

## Shrink a Claude session

Without `claudeSession`, a session loads the principal's user settings: every user skill, every hook and the auto permission mode. With it, the session runs with `--setting-sources project --settings <file>`, plus `--add-dir <skillsDir>` when set. `substrates.claude.session` takes the same two fields and applies to every node worker on Claude. A job never inherits it: a job without its own `claudeSession` keeps the principal's user settings, so it keeps the user skill it runs. The `ivy-think` Studio job ignores `claudeSession`: its own command already runs with no tools, MCP servers or session persistence, in a scratch directory.

The settings file has to bring back what the session still needs:

- **Guard hooks.** User hooks no longer run, so declare each guard hook the session must keep.
- **Permission mode.** Claude Code ignores `permissions.defaultMode: auto` in a project's settings, but honours it in this file.
- **Rule exclusions.** `~/.claude/rules` still loads when the session's cwd is under the home directory. Use `claudeMdExcludes` to leave rules out.
- **Skills.** User skills no longer load. Put the job's skill in the project's `.claude/skills`, or in `skillsDir`'s.

A map's `claudeSession` replaces `substrates.claude.session` for that map's node workers on Claude. The two are not merged, so the map's settings file and `skillsDir` have to bring back everything its workers need.

A worker can only find a skill that its session lists. For a single node that needs a skill outside the list, name the skill's path in the node's brief: "Read `~/.soma/skills/writer/SKILL.md` and follow it." Give a map its own `claudeSession` when its workers need a skill without being told.

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
