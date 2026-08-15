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

Design phase. The design document lives in [`design/ranger-design.md`](design/ranger-design.md).
The effort's own orienteer map (dogfooding) lives on this repo's issues — find it via
the `orienteer:map` label.

## Doctrine anchors

- The seven `soma graph` verbs are the only graph API ranger uses — never raw tracker writes.
- No autonomous ticking under the principal's credentials; headless work runs under the
  machine account.
- HITL nodes (`propose`/`approve`) route to the principal; ranger never stands in for
  the human's side of a decision.
