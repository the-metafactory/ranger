# ranger

Ranger walks an orienteer map until the work is done. A map is a `soma graph` work graph kept on a repo's issues. On each tick, ranger claims the decided nodes on the map's frontier, runs each one in a detached worker session, and closes it through the node's checkpoint gate. Research nodes end in a findings commit. Task and build nodes end in a reviewed pull request. Ranger files new work it finds back onto the graph, and it sends only real decisions to the principal.

Ranger implements the walk that soma's `docs/work-graph.md` §5 Phase 2 specifies: the headless tick, the claim announcement, and the close auditor. It adds routing by node kind and the PR review and merge steps that turn a walked graph into merged software. The design lives in [the ranger design document](design/ranger-design.md). Ranger's own map is on this repo's issues, under the `orienteer:map` label.

## Install ranger

Ranger runs on [Bun](https://bun.sh) 1.3 or later and calls `git`, `gh`, and `soma`. It is built for macOS: the scheduled tick and the dashboard run under launchd.

To install a release with [arc](https://github.com/the-metafactory/arc):

```bash
arc install https://github.com/the-metafactory/ranger --pin v0.1.1
```

Arc clones the release, runs `bun install`, and puts a `ranger` shim in its bin directory (`arc config get bin-dir`). Releases are listed on [the releases page](https://github.com/the-metafactory/ranger/releases).

To run ranger from a checkout instead:

```bash
git clone https://github.com/the-metafactory/ranger.git
cd ranger
bun install
bun src/cli.ts --help
```

## Configure ranger

Ranger reads `~/.config/ranger/ranger.yaml`. That file is private to each operator and is never committed. Start from the annotated template:

```bash
mkdir -p ~/.config/ranger
cp ranger.example.yaml ~/.config/ranger/ranger.yaml
```

The config names the maps to walk, the machine account, the principal, and the environment variables that hold each token. It never holds a token itself. [Configuration](docs/configuration.md) lists every section, the credentials ranger needs, and how ranger picks a config path.

## Check a map with scout

`ranger scout` is read-only. It reports each registered map's frontier, its stale claims, and the nodes waiting for the principal, and it writes nothing to the graph:

```bash
ranger scout
ranger scout --json
```

Scout needs a read-only token for every map. It refuses a map whose token is unset or can write. [Scout](docs/scout.md) describes the checks.

## Run ranger on a schedule

Autonomous work runs under the machine account, never under the principal's credentials. Two pieces set that up:

- `ops/bin/ranger.example` is the wrapper that every scheduled run goes through. It reads the tokens from the macOS keychain, clears the caller's environment, and starts ranger. Copy it to `~/bin/ranger`, replace `__USER__`, and make it executable. Set `RANGER_DIR` in it to the directory that holds ranger: your checkout, or the arc install directory.
- `ops/launchd/` holds the launchd jobs. `ch.invisible.ranger-tick` runs `ranger tick` every 10 minutes. `ch.invisible.ranger-serve` keeps the dashboard running. `ch.invisible.ranger-escalate` sends the daily digest at 07:30 local time. Copy each one to `~/Library/LaunchAgents/`, replace `__USER__`, and load it with `launchctl load`.

Each tick posts escalation cards, then claims frontier nodes and starts their workers, then sweeps for crashed workers. [The walk](docs/walk.md) covers what a tick claims and how each lane ends.

## Commands

| Command | What it does |
| --- | --- |
| `scout` | Reports every map's frontier, audit, and waiting nodes. Writes nothing. |
| `tick` | Runs one bounded pass: escalation cards, then the walk. The launchd job runs this. |
| `walk` | Claims frontier nodes, starts detached `run-node` workers, then sweeps. |
| `run-node <id>` | Supervises one node's worker session and then runs the node kind's steps to its close. |
| `sweep` | Reconciles the journal with crashed workers and stale claims. |
| `escalate` | Posts and edits the decision cards in each map's Discord thread. `--digest` sends the daily digest. |
| `serve` | Runs the local dashboard. |
| `job` | Queues, runs, and lists scheduled jobs. |
| `journal` | Shows the journal's workers, events, and health. |
| `merge-gate <id>` | Checks one node's PR against the merge desk's gate. Exits 0 only when the gate passes. |
| `merge-desk` | Runs one map's merge desk now. |
| `approve-node <id>` | Approves an `approve` node at the version its approval card shows. |
| `build-now <id>` | Claims one walkable node and starts its worker now. |
| `resume-node <id>` | Puts a parked or failed node back in motion. `--when-free` queues it for a free lane. |
| `resume-run` | Clears the dead-man pause. |
| `drain` | Stops new claims on the visual lane or on one headless map. `--off` lifts it. |
| `trust-git` | Lists changes to a canonical checkout's git config and hooks, and records a known-good state. |
| `remote-test` | Operator tooling for the private remote test executor. |

`ranger <command> --help` lists each command's options.

## Documentation

[The docs index](docs/README.md) lists every document. Start with these:

- [Configuration](docs/configuration.md): `ranger.yaml`, credentials, and the tick run ledger.
- [The walk](docs/walk.md): claims, the research and implement lanes, and proposals.
- [Lanes and the resume queue](docs/lanes.md): resource lanes, drains, host load, and queued resumes.
- [Observation intake](docs/intake.md): turning the principal's Discord mentions into graph nodes.
- [Scheduled jobs](docs/jobs.md): skills that ranger runs on a lane, outside the graph.
- [The dashboard](docs/serve.md): `ranger serve` and the verbs it runs.

## Rules ranger keeps

- Ranger changes the graph only through the `soma graph` verbs, never with raw tracker writes.
- Autonomous ticks run under the machine account. A tick refuses to change the graph when its identity resolves to the principal.
- `propose` and `approve` nodes go to the principal. Ranger never takes the principal's side of a decision.
- Claims start without a veto window. Anything blocked waits for the principal (node #7).

## Develop ranger

```bash
bun run test        # unit and end-to-end tests, four files at a time
bun run typecheck
bun run lint
```

The tests run against fake `soma`, `gh`, and worker fixtures. [AGENTS.md](AGENTS.md) lists the rules that agents working in this repo most often break, and the check that enforces each one.

## License

MIT. See [LICENSE](LICENSE).
