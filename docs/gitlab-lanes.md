# GitLab lanes (node #131)

The walk, implement and research lanes run a `gitlab:` map end to end.
Each lane takes its forge pieces from the map's `ForgeRef.forge`
(`src/forge-lanes.ts`, ranger issue #97 ruling Q8). Nothing branches on a
repo name.

- **Port.** `lanePort` returns GitHub's `github.ts` module, or a fresh
  `gitlabForgePort` for a GitLab map. The walk makes one per map per tick;
  run-node, the merge desk and the closure sweep make one per run or pass.
- **Read gate.** Graph reads (frontier, node, closure checks) run under
  `graphReadToken`. On GitHub that is the machine write token, as before.
  On GitLab it is the read-only PAT after the read gate (node #122). The
  walk checks it once per map per tick.
- **Write gate and git transport.** `assertWriteIdentity` and
  `gitCredential` already follow the repo (nodes #123, #127).
- **Credentials.** `laneCredentialRefusal` refuses a GitLab map whose read
  or write token is unmapped or unset. It reads only config and env. The
  walk, `build-now`, `run-node`, `sweep`, `merge-desk` and queued resumes
  check it first, so such a map claims nothing and makes no forge or graph
  call. It replaces the old `executionRefusal`.

The implement lane opens a draft MR, reviews it, readies it, and hands it
to the merge desk (node #126). After the merge it closes with
`--ci <pipelineId>@<sha>`. A `propose` node instead records a `tested`
evidence pointer at the pipeline's `/-/pipelines/<id>` URL. The research
lane cites its draft MR's pipeline the same way, and never merges it.

## The review hold

GitLab has no review gate yet. *Settle the review gate a ranger-built
GitLab MR must pass before ranger merges it* (ranger#96) settles it. Until
that node's build lands, the review step on a GitLab map does three things:

- It parks the node with phase `awaiting-review`.
- It leaves the MR a draft.
- Its park outcome, and so its escalation card, names that node.

The row is never on the merge desk, so ranger never merges an unreviewed
MR. A resume holds it again. A GitHub map keeps its sage review.

## Tests

`test/gitlab-lanes.test.ts` drives the lane entry points against a fake
GitLab port, the real read gate over a fake glab, the fake soma, and real
git. It covers these paths:

- the walk's claim
- implement through the merge desk to the close, for `auto` and `propose`
- the review hold
- the research close
- the tick's refusal without credentials

The scripted reviewer in the full implement path stands in for the gate
ranger#96 will build.
