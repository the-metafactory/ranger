---
name: verify-ranger
description: Drive ranger for real to prove a change works. Starts an isolated `ranger serve` dashboard from this checkout on a snapshot of the live journal, drives it in headless Chromium, and runs read-only CLI verbs (journal, job list, scout, approve-node --dry-run) against the same snapshot. Use when a change touches the dashboard (src/serve*.ts), the journal, or a CLI verb, and tests alone don't show the user-facing result.
---

# verify-ranger

Ranger has two user surfaces: the local dashboard (`ranger serve`, live on
127.0.0.1:7311 under launchd) and the CLI (`src/cli.ts`). The tick
(`walk`/`tick`/`run-node`/`escalate`) claims GitHub issues, pushes and posts to
Discord; it is never driven from this skill. Its proof is `bun test`. The same
holds for the operator-only `remote-test` group (`run`, `status`,
`submit-pr-heads`, `bus-run`, `bus-retry`, `bus-status`), which stages over
SSH and publishes to the signed bus; its proof is `bun test test/remote-test*.test.ts`.

The scripts here never touch the live instance: they copy the live journal
(`~/.config/ranger/state.sqlite`) with SQLite's backup API, copy the live
`ranger.yaml` with `state.journalPath` pinned to the copy, and run this
checkout's `serve` on port 7399. `serve` and the read verbs get the
read-only GitHub tokens only; `env.sh` unsets the write and Discord tokens.
That does not hold for `approve-node` (see Hard rules).

Paths below are relative to this skill's directory. Run from any checkout or
worktree: the scripts serve the checkout they live in (`RANGER_CHECKOUT`
overrides).

## Hard rules

- Never drive 7311, never `launchctl` the `ch.invisible.ranger-*` jobs, never
  open `~/.config/ranger/state.sqlite` except through `launch.sh`'s backup.
- Never click Approve, Resume, Queue resume, Merge, Open session, Build now or
  Drain. Each POST runs `~/bin/ranger` (the **main** checkout, with the
  principal's write tokens from the keychain) and acts on GitHub, iTerm2 or the
  journal. `drive.ts` aborts every POST except `/api/refresh` and proves the
  block on each run. Verify those actions with `bun test test/serve*.test.ts`
  and the CLI dry runs in `features/`.
- `approve-node` runs `gh` with an allowlisted env that drops `GH_TOKEN` and
  `GH_CONFIG_DIR`, so it uses the principal's own write-capable gh keyring
  whatever `env.sh` sets, and it refuses any other login. Run it only with
  `--dry-run`; without it, it edits the GitHub issue.
- The Bash tool does not keep env vars between calls. Write every CLI step as
  one command, `source "$RUN/state/env.sh" && bun src/cli.ts ...`. The pinned
  config keeps the journal on the copy even when env.sh is lost, but not the
  tokens.
- `scout` and Refresh spend the principal's read-only GraphQL budget; scout
  takes ~4.5 min over 26 maps. Run it only when the change is in scout.

## Launch

```bash
RUN=$(scripts/launch.sh | tail -1)    # prints "ready: http://127.0.0.1:7399 ..." then the run dir
scripts/doctor.sh "$RUN"              # exit 0 is the launch's success signal
```

The pipe drops launch's exit code and `$RUN` is set on failure too, so only
doctor's exit code says the instance is usable.

Ready means `/api/state` answers and at least one map was read without error,
not just that the port is open. Launch also opens the snapshot once with this
checkout's code (`job list`), so a branch's new migration is applied to the
copy before serve starts. Env: `VERIFY_RANGER_PORT` (default 7399; 7311 is
refused), `VERIFY_RANGER_RUN` (run dir; default
`~/.cache/verify-ranger/runs/<timestamp>`). A second run needs a different port.

The run dir is the last line on failure too, so cleanup always has its
argument. On failure launch prints the log that explains it: `migrate.log`
when this checkout could not open the snapshot (a `ForeignMigrationError`
there means the live journal carries a migration this checkout lacks: rebase
onto main), otherwise `serve.log`.

## Doctor

```bash
scripts/doctor.sh "$RUN"
```

Read-only. Checks: port is not 7311; our serve is up; it owns the port; its
cwd is the checkout (prints HEAD); its `RANGER_JOURNAL_PATH` and the copied config's `state.journalPath` are
the snapshot; `/api/state` reads maps. Registered maps render from the
snapshot's frontier cache without a token, so `maps read: 0/N` means the
snapshot cached no frontier. Missing read-only PATs
(`ranger-ro-metafactory`, `ranger-ro-personal` keychain items) stop serve at
startup instead: launch prints the refusal from `serve.log`.
Run it first whenever anything looks off.

## Drive

Dashboard (Playwright from the global bun install,
`~/.bun/install/global/node_modules/playwright`; override with
`VERIFY_RANGER_PLAYWRIGHT`):

```bash
bun scripts/drive.ts "$RUN"            # load, screenshot, cross-check DOM vs /api/state
bun scripts/drive.ts "$RUN" --refresh  # also click #refresh and expect 202 + "Refreshing" in #msg
```

Stable handles (`renderPage` in `src/serve.ts`): `#meta` (leaves "loading…"
once state is read), `#msg` (toasts and errors), `#refresh`, `#needsyou`
(one child per `state.needsYou` row, plus a leading notice when
`state.needsYouUnchecked` is non-empty), `#grill`, `#auto`, `#next`, `#current`,
`#substrates`. `/api/state` is the page's only data source; diff a change's
expected rows against it. To check a new element, extend `drive.ts` with a
`check(...)` on its id or text rather than eyeballing the screenshot.

CLI (same snapshot, read-only tokens):

```bash
cd "$(cat "$RUN/state/checkout")"
source "$RUN/state/env.sh" && bun src/cli.ts journal --config "$RUN/state/ranger.yaml" > "$RUN/evidence/journal.json"
source "$RUN/state/env.sh" && bun src/cli.ts journal --node <id> --config "$RUN/state/ranger.yaml"
source "$RUN/state/env.sh" && bun src/cli.ts job list --config "$RUN/state/ranger.yaml"
```

Per-feature journeys: [`features/README.md`](features/README.md).

## Evidence

Everything goes to `$RUN/evidence/` and survives cleanup. `drive.ts` writes,
per run, `<stamp>-dashboard.png` (full page), `<stamp>-state.json` (what the
server said), `<stamp>-dom.json` (what the page rendered), `<stamp>-network.log`
(every `/api` request, `sent` or `BLOCKED`) and with `--refresh`
`<stamp>-after-refresh.png`. Redirect CLI output there too. A proof cites the
`ok`/`FAIL` lines, the evidence paths and the HEAD doctor printed.

What the snapshot proves: rendering and reads over real live data, from this
checkout's code. What it cannot prove: anything the tick does after the
snapshot, and any outward action.

## Cleanup

```bash
scripts/cleanup.sh "$RUN"
```

Kills only processes started with this run's config path
(`src/cli.ts serve --config $RUN/state/ranger.yaml`), so the live serve and
other runs survive; then deletes `$RUN/state` (journal copy, config copy,
env.sh). `$RUN/evidence` stays. Run it after every failed attempt too: launch
refuses a busy port. Stranded runs:
`ls ~/.cache/verify-ranger/runs/*/state` lists runs not yet cleaned.

## Helpers

| Script | Use |
| --- | --- |
| `scripts/launch.sh` | snapshot + start isolated serve; last line is the run dir |
| `scripts/doctor.sh <run>` | read-only health check, exit 1 on any FAIL |
| `scripts/drive.ts <run> [--refresh]` | headless dashboard journey with POST guard |
| `scripts/pin-journal.ts <yaml> <sqlite>` | launch's step: set `state.journalPath` in the copied config |
| `scripts/state-summary.ts <state.json>` | array counts and map read errors of a `/api/state` dump |
| `scripts/cleanup.sh <run>` | stop our serve, drop scratch state, keep evidence |
