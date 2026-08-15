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

## Doctrine anchors

- The seven `soma graph` verbs are the only graph API ranger uses — never raw tracker writes.
- No autonomous ticking under the principal's credentials; headless work runs under the
  machine account.
- HITL nodes (`propose`/`approve`) route to the principal; ranger never stands in for
  the human's side of a decision.
