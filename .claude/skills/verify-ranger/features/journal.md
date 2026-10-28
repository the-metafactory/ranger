# Journal inspection

`ranger journal` prints the journal as JSON: pause state, dead-man count,
spawns today, every worker with its status, escalations and the newest 50
events. `--node <id>` narrows it to one node and adds each worker's log file;
`--repo` narrows it to one map repo.

## Sub-features

- `journal-all` whole journal, JSON with `journalPath`, `paused`, `deadmanCount`, `spawnsToday`, `workers`.
- `journal-node` one node's workers, escalations and events; each worker row gets a `workerLog` path (only with `--node`).
- `journal-repo` one repo's rows.
- `journal-bad-node` a non-numeric `--node` is refused with exit 1.

## How to get to it (user POV)

- `ranger journal [--repo <owner/name>] [--node <id>]`.

## Driving it with the CLI

Preconditions: baseline; pick a node id from `#needsyou` in the latest `<stamp>-state.json`.

- **All.** `source "$RUN/state/env.sh" && bun src/cli.ts journal --config "$RUN/state/ranger.yaml" > "$RUN/evidence/journal.json"; echo $?`. Exit 0; first key `journalPath` equals `$RUN/state/state.sqlite` (proves the snapshot, not the live file).
- **One node.** `source "$RUN/state/env.sh" && bun src/cli.ts journal --node <id> --config "$RUN/state/ranger.yaml" > "$RUN/evidence/journal-<id>.json"`. Every worker row has `"nodeId": "<id>"`.
- **Refusal.** `source "$RUN/state/env.sh" && bun src/cli.ts journal --node abc --config "$RUN/state/ranger.yaml"; echo $?`. stderr `ranger journal: --node must be a numeric id, got abc`, exit 1.

## Gotchas

- The whole journal is ~18k lines; always redirect to a file.
- `workerLog` is built from the journal's own directory, so on the snapshot it points under `$RUN/state/logs/workers/`, which launch does not create. The live log has the same file name under `~/.config/ranger/logs/workers/`; reading it is fine, writing is not.
- `journalPath` showing `~/.config/ranger/state.sqlite` means the config is not the pinned copy: stop and relaunch.
