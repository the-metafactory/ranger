# Configuration

Ranger reads one YAML file, `ranger.yaml`. [`ranger.example.yaml`](../ranger.example.yaml) is the annotated template and the full list of keys with their defaults. This page describes how ranger finds the file, what each section is for, the credentials it names, and the tick run ledger.

## Config path

Every command that reads `ranger.yaml` picks the path in this order:

1. `--config <path>` (or `-c <path>`).
2. `$RANGER_CONFIG`.
3. `~/.config/ranger/ranger.yaml`.

A relative path from the flag or the environment resolves against the caller's working directory. Under an arc shim, which runs ranger from its install directory, that directory comes from `ARC_INVOCATION_CWD`. A missing file at the chosen path is an error, and ranger does not try another location. Ranger never reads `./ranger.yaml` on its own.

```bash
export RANGER_CONFIG=/absolute/path/to/another/ranger.yaml
ranger job list
```

Ranger passes the chosen path, made absolute, to every ranger process it starts, through `--config`. The private JSON files that the `remote-test` commands take with their own `--config` option are separate from `ranger.yaml`.

## Sections

| Section | Purpose |
| --- | --- |
| `maps` | The maps ranger knows. Each entry has `repo`, `root`, and `walk` (`none`, `research-only`, or `full`), plus optional `lane`, `canonical`, `commands`, `nodes`, `skip`, `autoMerge`, `base`, `discord`, `localCheckout`, and `testBackend`. Two maps can share a repo. Select one with `--map owner/name#root`. |
| `bot` | The machine account. `identity` pins the GitHub bot login. |
| `principal` | The principal's `login` and, for intake, `discordId`. No tick that changes the graph runs under this identity. |
| `state` | `journalPath` (default `~/.config/ranger/state.sqlite`), `canonicalRoot` (where canonical checkouts live), and the migration-only `legacyMapRoots`. |
| `workers` | Spawn cap, lane slots, wall clock, attempts, dead-man threshold, review rounds, base drift, CI grace, host load, and probe requeues. |
| `auth` | `readOnlyTokens` and `writeTokens`: environment variable names by repo prefix. The longest matching prefix wins. |
| `budget` | GitHub GraphQL floor, the cooldown after a secondary rate limit, and the frontier's maximum age. |
| `substrates` | Quota thresholds and the Claude, Codex, and Pi worker models. |
| `ratify`, `intake` | Proposal reads per tick, and the intake drafter's model. See [the walk](walk.md) and [observation intake](intake.md). |
| `serve` | The dashboard's `port` (default 7311, bound to 127.0.0.1), `refreshSec`, and `extraMaps`, which the dashboard shows and nothing else reads. See [the dashboard](serve.md). |
| `jobs` | Scheduled jobs. See [scheduled jobs](jobs.md). |
| `bus` | The tick run ledger. See [Tick run ledger](#tick-run-ledger). |
| `checkReporter`, `prHeadSubmitter` | The ci-test check reporter (node #351) and PR head submitter. See [the remote-test bus](remote-test-bus.md). |

## Credentials

`ranger.yaml` holds only the names of environment variables, never a token. The wrapper `ops/bin/ranger.example` fills these variables from the macOS keychain and from grove's `bot.env`:

| Variable | Token | Keychain service |
| --- | --- | --- |
| `GH_TOKEN`, `RANGER_WRITE_GH_TOKEN_METAFACTORY`, `RANGER_WRITE_GH_TOKEN_PERSONAL` | The machine account's classic PAT with `repo` scope (node #11, node #18) | `ivy-agent` |
| `RANGER_READONLY_GH_TOKEN_METAFACTORY` | Fine-grained read-only PAT for `the-metafactory/*`: Issues read, Contents read (node #8) | `ranger-ro-metafactory` |
| `RANGER_READONLY_GH_TOKEN_PERSONAL` | Fine-grained read-only PAT for `jcfischer/*`: Issues read, Contents read | `ranger-ro-personal` |
| `RANGER_WRITE_GL_TOKEN_GEANT` | GitLab project access token bot: `api` scope, Maintainer (node #123) | `ranger-write-gl-geant` |
| `RANGER_READONLY_GL_TOKEN_GEANT` | GitLab `read_api` PAT | `ranger-readonly-gl-geant` |
| `RANGER_DISCORD_TOKEN` | The grove Discord bot token, reused | `DISCORD_BOT_TOKEN` in `~/.config/grove/bot.env` |

To store a token in the keychain:

```bash
security add-generic-password -s ranger-ro-metafactory -a token -w <pat>
```

The write credential is a classic PAT for a reason. A fine-grained PAT cannot reach an organization's repos as an outside collaborator, and it can never be scoped to another account's personal repos. The Discord bot must be a member of the guild of each map's channel.

The wrapper also clears the caller's environment, pins `PATH`, `HOME`, and the `bun` binary, and starts bun with ranger's own `bunfig.toml` and no `.env` file. A worker session runs as the same user and can call the wrapper, so the wrapper never runs a program the caller chose with the tokens in its environment (node #66). The comments in `ops/bin/ranger.example` list every rule.

## Tick run ledger

An optional `bus` section makes each `ranger tick` publish one `execution.run.finished` envelope. The envelope has producer `ranger`, `ran: {kind: job, ref: "ranger:tick"}`, a new run UUID, the start and end times of the pass, and the journal path as `detail_ref`. Exit 0 reports `succeeded`. Exits 1 and 2 report `failed`. A tick that fails to load its config or context publishes nothing.

```yaml
bus:
  principal: jc
  stack: default
  url: nats://127.0.0.1:4222
  creds: ~/.config/nats/creds/ranger.creds
```

`principal` is required. `stack` defaults to `default`, and `url` defaults to `nats://127.0.0.1:4222`. `principal` and `stack` must each be one subject token (`[A-Za-z0-9_-]+`). A host other than loopback needs `creds`. On loopback (`localhost`, `127.0.0.1`, `::1`) the bus can be unauthenticated.

| Variable | Effect |
| --- | --- |
| `MF_CORRELATION_ID` | Passed through unchanged when not empty, even when it is not a UUID. Unset or empty generates one. |
| `MF_SERVES_GOAL`, `MF_SERVES_NODE` | Add `serves.goal` and `serves.node`. Use IDs only, never the goal's wording. Empty values are left out. With both empty or unset, the envelope has no `serves`. |

Tick envelopes have no `state`.

Delivery goes through myelin's outbox at `<journal directory>/run-ledger/outbox.jsonl`. Each emit writes the envelope to the spool first, replays any pending records, sends the current run, and closes its NATS connection. The whole emit stops after two seconds. A failed delivery does not change the tick's output or exit status. It records one `ledger-failed` journal event, and the next tick with `bus` set replays the spooled envelopes. Without `bus`, ranger builds no envelope, opens no connection, and touches no spool. The ledger covers only `tick`. [Scheduled jobs](jobs.md) report their runs the same way.

## Journal migrations

`openJournal` runs the journal's migrations. Before it applies them, it seeds the root inputs that `drizzle/0009_worker-root.sql` requires. A legacy repo with one registered map takes that map's root. For a repo with more than one map, or one that is no longer registered, set `state.legacyMapRoots` to its original root. That root does not need to be registered now. The same applies to repos that only have legacy digest or escalation cursor entries. Remove the migration-only override after the cutover. A caller that runs the Drizzle migrations on its own must seed `ranger_legacy_roots(repo, root)` for every legacy repo first.

When code from another branch has already migrated the live journal, follow [repairing a journal migrated by foreign code](journal-repair.md).
