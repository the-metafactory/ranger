# ranger

Autonomous orienteer work-graph walker for the metafactory ecosystem.

Ranger points at an orienteer map (a `soma graph` work graph on a repo's issues) and
walks it to completion: it claims decided frontier nodes, executes AFK-capable work
through the standard SOP (pre-PR working-tree review, pilot/sage review loop, merge),
files newly-discovered work back onto the graph as typed nodes, and escalates only
genuine decisions to the principal.

Ranger is the implementation of the walk specified in soma `docs/work-graph.md` §5
Phase 2 — the headless tick, the claim announcement with veto window, and the close
auditor — extended with the node-kind routing and SOP integration that turn a walked
graph into merged software.

## Status

Design + early build. The design document lives in
[`design/ranger-design.md`](design/ranger-design.md). The effort's own orienteer
map (dogfooding) lives on this repo's issues — find it via the `orienteer:map`
label.

Shipped build-path steps:

- **Step 1 — `ranger scout`** (node #12): read-only frontier/audit/HITL digest.
- **Step 3 — claim + research lane** (node #13): the smallest full
  claim→execute→close loop on the safest kind — `ranger walk` (headless tick:
  announce → claim → spawn), `ranger run-node` (detached worker supervisor with
  the research SOP tail), `ranger sweep`, `ranger journal`.
- **Step 4 — implement lane** (node #23; built, live acceptance on seelite #550
  pending): `walk: full` maps get the task/build
  SOP — worker implements and commits; the supervisor tests, pushes, opens a
  draft PR, runs offline sage rounds (cap 2) with fix passes, marks it ready, and
  the tick posts a one-tap merge card. Ranger never merges; after the
  principal's merge it closes the node through the gate, citing the PR's CI
  run. `propose` task/build nodes take the same lane, with the merge as the
  ratification. Each run-node is a fenced occupant (generation check before every
  outward action, process-group kill) and resumes its phase from GitHub. The
  approver bot (node #16) remains.

Implement capacity is split into **visual** and **headless** lanes (node #57):
maps with `commands.probe` use visual; other maps use headless. An optional
map `lane: visual | headless` overrides that default. Walk, resume and merge-desk
send-backs check the map's own lane; each lane holds one claimed/running
implement node. The daily spawn cap and dead-man pause remain global; research
selection is unchanged. The dashboard shows both holders and groups queues by
lane. Existing worker rows resolve their lane from current config; an unknown
or ambiguous map conservatively holds both lanes.

## Scout (build-path step 1)

`ranger scout` is the first shipped component: a read-only tick that digests every
registered map's frontier, audit, and HITL queue to a CLI report (Discord digest
comes once the bot exists — design §9). It performs **zero graph writes**.

```bash
bun src/cli.ts scout                      # text report (ranger.yaml in cwd)
bun src/cli.ts scout --json               # machine-readable report
bun src/cli.ts scout -c /path/ranger.yaml # explicit config
```

- **Read-only token gate (node #8):** every map runs under an explicit read-only
  fine-grained PAT resolved from `auth.readOnlyTokens` (env var names, never
  inline tokens). Scout aborts a map whose token is unset (no `gh` keyring
  fallback — the keyring token is write-capable) or whose scopes are
  write-capable, and verifies the token can read the map's repo.
- **Fixed verb surface:** scout only ever invokes `soma graph audit/frontier/node
  --json`; the read-only set is enforced in code before a subprocess spawns.
- **Route classes (design §3):** each frontier node is classified — HITL
  escalate (propose/approve, HITL-kind-as-auto, needs-typing), research,
  implement (walkable per `walk: full`), provisioning (probe-registry
  preflight).
- **Acceptance:** run against this map (root 1) and a Seekolous map (root 26);
  correctly reports frontier by route class, HITL nodes waiting, stale claims
  (audit `openClaimed` — in-flight or stale), and receipt-less closes.

```bash
bun test       # unit + e2e (fake soma/gh fixtures)
bunx tsc --noEmit
```

## Walker — claim + research lane (build-path step 3, node #13)

The smallest full claim→execute→close loop, on the safest kind (research),
under the machine account. Every graph write goes through the `soma graph`
verbs with `--identity <bot>`; the tick refuses to run under the principal's
identity (design §2, node #11).

```bash
bun src/cli.ts walk                       # headless tick: announce → claim → spawn → sweep
bun src/cli.ts run-node <id> --map <repo> # detached worker supervisor (research SOP tail)
bun src/cli.ts sweep                      # reconcile journal vs reality (crashed workers)
bun src/cli.ts journal                    # inspect workers/events/health
```

- **Walk-mode opt-in (node #9):** a map is claimed only when its `walk` is
  `research-only` or `full`; `none` registers it for scout only. `auto`
  research nodes are the lane's candidates.
- **Announce-fail-closed (node #7):** no veto window — but no confirmed
  Discord message id, no claim. A missing bot token or a non-2xx post refuses
  the claim.
- **Race-safe claim:** `soma graph claim` re-reads and tie-breaks; a lost race
  is skipped, never fought.
- **Dead-man + spend bound (design §7):** N consecutive worker failures pause
  claiming; a daily spawn cap bounds spend. `RANGER_NO_SPAWN=1` claims without
  spawning (simulation).
- **Journal (design §8):** SQLite at `~/.config/ranger/state.sqlite` holds only
  what the graph cannot — worker liveness/outcomes, vetoes cache, dead-man and
  spawn ledgers. Deleting it degrades to re-announce + retry once.
- **Research CI (node #25):** the supervisor refuses a commit whose tree differs
  from the pre-worker base in any path other than `findings.md`, before pushing
  or citing CI on a retry. After the findings push, the supervisor opens a
  draft PR against the map's base and waits up to 15 minutes for CI on the
  findings head. Registered check runs, Actions workflow runs (including queued
  workflows whose jobs have not registered) and external commit statuses must
  finish without failure. The completed snapshot must stay unchanged for 30
  seconds, with at least one successful check run for
  `soma graph close --ci <checkRunId>@<headSha>`. Polling backs off from 10 to
  60 seconds. This observes CI registered during the wait; it cannot guarantee
  that an external provider will never register more CI afterward. Missing,
  pending, failed, or stale-head evidence parks the node; a retry reuses the
  open draft and committed findings. Failed CI needs an operator to rerun or
  repair CI; retrying alone does not change the verdict on the same head.
  A closed draft needs operator intervention.
  The PR stays draft and unmerged.
- **Acceptance (e2e):** an auto research node walked end-to-end against fake
  soma/gh/worker fixtures — claim → worktree → findings branch pushed → draft
  PR → successful CI citation → gated close → `decisions --write`. Live close
  validation for node #25 remains a supervisor action after deployment.

## Doctrine anchors

- The seven `soma graph` verbs are the only graph API ranger uses — never raw tracker writes.
- No autonomous ticking under the principal's credentials; headless work runs under the
  machine account.
- HITL nodes (`propose`/`approve`) route to the principal; ranger never stands in for
  the human's side of a decision.
- Claims proceed automatically (no veto window); blocking items wait indefinitely
  for the principal (node #7).
