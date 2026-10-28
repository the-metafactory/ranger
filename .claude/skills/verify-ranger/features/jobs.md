# Scheduled jobs

Jobs declared in `ranger.yaml` `jobs` (daily-short, field-notes, abacus-friday)
are queued by Reflex with `ranger job enqueue`, started by the tick on their
lane, and reported to the run ledger. The principal reads their runs with
`ranger job list` and sees lane holders on the dashboard.

## Sub-features

- `jobs-list` `job list` prints every job run oldest first: `name`, `lane`, `status`, `queuedAt`, `startedAt`, `finishedAt`, `log`.
- `jobs-lane` the dashboard's `#next` shows `visual lane · free` or its holder; a running job on the `visual` or `headless` lane holds it as `held by #job:<name> (ranger:job#<runId>)`. `#current` lists running workers only, never a job.
- `jobs-enqueue` `job enqueue <name>` queues one run (not driven: see Gotchas).

## How to get to it (user POV)

- `ranger job list`.
- Dashboard "Next in queue" (a job never shows under "Current job").

## Driving it with the CLI and drive.ts

Preconditions: baseline.

- **List.** `source "$RUN/state/env.sh" && bun src/cli.ts job list --config "$RUN/state/ranger.yaml" > "$RUN/evidence/jobs.json"; echo $?`. Exit 0; a JSON array; the newest entries match the job names in `ranger.yaml`.
- **Lanes.** `bun scripts/drive.ts "$RUN"`, then read `gates.laneHolders` in `<stamp>-state.json` and `#next` in `<stamp>-dashboard.png`. A null holder shows "free".
- **Enqueue.** Allowed on the snapshot only: `source "$RUN/state/env.sh" && bun src/cli.ts job enqueue daily-short --config "$RUN/state/ranger.yaml"` prints `{"name":"daily-short","runId":N,"lane":"none","queued":true}`; a second call prints the same `runId` with `"queued":false`, exit 0 both times. Then `source "$RUN/state/env.sh" && bun src/cli.ts job list --config "$RUN/state/ranger.yaml"` lists run N, and `journal` reports `journalPath` = `$RUN/state/state.sqlite`: the write went to the copy. Never open the live journal to compare; its id sequence is shared, so an equal id proves nothing. Nothing starts the run, since no tick reads the snapshot.

## Gotchas

- Never enqueue against the live config without `env.sh`: the live tick would start the job and upload a video.
- `daily-short` is `lane: none` (node #393): its enqueue reports `"lane":"none"`, so do not expect it under a lane in `#next`.
