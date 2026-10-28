# The walk

`ranger walk` is one headless tick. It claims the decided nodes on each map's frontier, starts a detached `ranger run-node` worker for each claim, and then sweeps. `ranger tick` runs the escalation desk first and then the same walk. Every graph write goes through a `soma graph` verb with `--identity <bot>`. A tick refuses to run when its write identity resolves to the principal (design §2, node #11).

```bash
ranger walk                         # announce, claim, spawn, sweep
ranger run-node <id> --map <repo>   # the detached worker supervisor
ranger sweep                        # reconcile the journal with crashed workers
ranger journal                      # inspect workers, events, and health
```

Ranger has two lanes of work. The research lane shipped first (build-path step 3, node #13). The implement lane followed (build-path step 4, node #23). The [lanes and the resume queue](lanes.md) page covers how the two implement resource lanes share the machine.

## Which nodes a tick claims

- Walk mode (node #9). A map's `walk` sets what ranger claims there. `none` registers the map for scout only. `research-only` claims `auto` research nodes. `full` also claims `auto` task and build nodes, and `propose` task and build nodes.
- Announce first (node #7). There is no veto window. Ranger claims a node only after Discord confirms the announcement with a message id. A missing bot token or a post that does not return 2xx refuses the claim.
- Race-safe claims. `soma graph claim` reads the node again and breaks ties. Ranger skips a claim it lost and never fights for it.
- Build briefs (node #154). A build node that `soma graph audit` lists under `buildBriefNotReady` routes as `brief-not-ready`. The tick does not take it, and the escalation desk posts one card that names what is missing. Ranger reads the audit with each fresh frontier read and caches it beside the frontier. A fixed body changes the issue's `updated_at`, so the next tick checks it again. An audit without that field (soma before soma#753) holds nothing back. An audit that cannot be read or parsed holds back every build node, and the next tick runs only the audit again until it reads. A verdict change that the sentinel cannot see, such as a soma upgrade or a changed readiness rule, arrives within `budget.frontierMaxAgeMin`. `ranger build-now` refuses a held node the same way.
- Dead-man switch and spend bound (design §7). After `workers.deadmanThreshold` worker failures in a row, ranger stops claiming until `ranger resume-run` clears the pause. `workers.spawnCapPerDay` caps worker starts per day. `RANGER_NO_SPAWN=1` claims without starting workers, as a simulation.

## The journal

The journal is a SQLite file at `~/.config/ranger/state.sqlite` (design §8). It holds only what the graph cannot: worker liveness and outcomes, the veto cache, and the dead-man and spawn ledgers. If you delete it, ranger announces again and retries once.

## Research lane

A research worker writes `findings.md`. The supervisor then closes the node through its gate (node #25):

1. The supervisor refuses a commit that changes any path other than `findings.md`, compared with the base from before the worker ran. It checks this before it pushes and before it cites CI on a retry.
2. After it pushes the findings, the supervisor opens a draft PR against the map's base.
3. The supervisor waits up to 15 minutes for CI on the findings head. Registered check runs, Actions workflow runs, and external commit statuses must all finish without a failure. Workflows that are queued but have no jobs yet count too.
4. The finished set of checks must stay the same for 30 seconds and hold at least one successful check run. The close cites that run as `soma graph close --ci <checkRunId>@<headSha>`.

Polling backs off from 10 to 60 seconds while CI is pending, and drops back to 10 seconds while the checks settle. The wait sees CI that registers during it. It cannot rule out an external provider that registers more CI later.

CI evidence that is missing, pending, failed, or from an old head parks the node. A retry reuses the open draft and the committed findings. Failed CI needs an operator to rerun or repair it, because a retry on the same head gets the same verdict. CI parks do not count toward the dead-man switch. The journal keeps the base SHA from before the worker across retries. A draft without that base parks for the operator, and so does a closed draft. The PR stays a draft and is never merged.

## Implement lane

On a `walk: full` map, task and build nodes take the implement lane (node #23). Its live acceptance target was seelite #550.

1. The worker implements the node and commits.
2. The supervisor runs `commands.test`, pushes, and opens a draft PR.
3. The supervisor runs offline sage review rounds, at most `workers.reviewRounds` (default 2), with a fix pass after each round that finds something.
4. The supervisor marks the PR ready, and the tick posts a one-tap merge card.
5. After the principal merges, ranger closes the node through the gate and cites the PR's CI run.

With `autoMerge: true`, ranger squash-merges a PR that passes the gate, except for nodes labelled `ranger:needs-eye`, which keep the merge card. A `propose` task or build node takes the same lane, and the principal's merge is its ratification.

Each `run-node` is a fenced occupant. It checks its generation before every outward action, and a kill stops its whole process group. A restarted `run-node` reads its phase back from GitHub. The approver-bot identity, and the branch protection pinned to it, are not provisioned yet (node #16).

## Propose research

The walk also takes a `propose` research node when all of these hold (node #246, #21 rulings D6, D8, and D10, and D18):

- The map is a GitHub map on `walk: research-only` or `walk: full`.
- The principal (`principal.login`) wrote the map's root. Ranger reads the root's author once per map and keeps it in the journal.
- The machine account did not file the node.

Otherwise, the node escalates as `propose-approve`.

The work runs the research steps above: findings branch, draft, and CI. Instead of a close, it ends with `soma graph close --propose --body-file …`. The body holds the findings, a link to the findings branch and draft, and `<!-- ranger:proposal node=N -->`. Ranger takes the comment id from soma's `--json` payload when it has one, and otherwise from the `Posted proposal comment <id>` line. When neither names it, the row keeps no id and the card says so.

The row becomes `proposed`. The claim stays, no worker runs, and no lane slot is held. `run-node`, `resume-node`, and `build-now` refuse the node. The escalation desk posts a card that links the proposal comment and asks for a 👍 there.

## Ratify a proposal

Each walk tick reads the reactions on every open proposal (node #250, #21 rulings D4, D6, D8, and D9). That is one `GET issues/comments/{id}/reactions` call, all pages, under the machine write token. A tick reads at most `ratify.readsPerTick` proposals (default 10): the least recently read first, then the oldest.

Soma counts a 👍 from anyone but the proposer, so ranger narrows it. Only a `+1` from the principal's login on the map's forge host ratifies, and only when that login has no `-1` on the comment. Ranger ignores every other reaction.

A ratified proposal resumes at the close. A detached `run-node` runs `soma graph close N --proposal-comment <id>` from the canonical checkout, where the probes run. No LLM session starts, and soma records the `approved` evidence. The worker writes the decisions and closes the card. A failed read closes nothing, and the next tick reads again.

A row with no comment id takes the newest comment on the node that the bot wrote and that carries the marker. Without one, nothing closes, the card says the proposal comment is missing, and ranger does not read the row again. A write identity that resolves to the principal closes nothing.

## Veto a proposal

A `-1` from the principal on a proposal comment vetoes the node for good, with or without a `+1` (node #240, #21 rulings D1 and D7). Ranger then:

1. Posts a veto comment on the node that ends with `<!-- ranger:veto node=N proposal=<id> -->`.
2. Records the veto by repo and node.
3. Releases the claim.
4. Edits the card to "refused, yours to take".

Ranger never closes a vetoed node and never claims it again. The desk shows the same card while the node stays on the frontier.

The journal is only a cache of vetoes. Before the walk claims a `propose` research node, it reads the node's comments and rebuilds a veto from any bot comment whose last line is the marker. The tick reads only the `propose` nodes it can claim: those within the spawn cap's room, and at most `ratify.readsPerTick`. An unread node waits for the next tick. A failed read means no `propose` research node on that map is claimed that tick.

If a lost journal took a proposal's row with it, ranger finds the proposal among the bot's open claims in the last cached audit (`openClaimed` in `soma graph audit --json`). An audit cached without that field is reported until the walk caches a new one. Ranger recovers the comment id, or the veto, from the node's comments. A write identity that resolves to the principal posts no veto and releases nothing. Migration 0028 keys the veto cache by repo.

## End-to-end test

The end-to-end test walks an `auto` research node against fake `soma`, `gh`, and worker fixtures: claim, worktree, findings branch pushed, draft PR, successful CI citation, gated close, and `decisions --write`. A live close for node #25 is the supervisor's check after a deployment.
