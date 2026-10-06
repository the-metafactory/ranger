# crisis-simulator's map root on GÉANT — not charted yet (node #98, 2026-10-06)

Record for node #98 on the ranger map: chart crisis-simulator's map root on
`gitlab.software.geant.org/claw/crisis-simulator` (home project
`claw/crisis-simulator`), then bring its open typed build nodes under it: #60,
#61, #62 and #33.

**Status: the checkpoint `crisis-simulator-map-charted` is NOT met.** No root
was charted and no node was moved. Every path to either one goes through
`soma graph`, and on this instance soma 0.23.1 cannot do either. Node #98 waits
on soma #707. Do not close node #98 on the strength of this document.

## Resolution records

| Record | Value |
| ------ | ----- |
| Map root ref | none. `soma graph chart` fails on `claw` (below). |
| Nodes under the root | none. No verb adopts an existing Issue, and CE does not allow it (below). |
| Root id for `ranger.yaml` | none yet. No `ranger.yaml` entry was added. |

## Sources

- Research node #93 (closed 2026-10-06, checkpoint
  `soma-gitlab-backend-surveyed`). Its live probes ran read-only against
  `gitlab.software.geant.org` that day. Its findings are cited as F1–F9 and its
  options as O1–O5.
- soma 0.23.1 is still the installed version today, and it is the build
  #93 surveyed (`origin/main` at `1e6e5d4`). No soma PR merged since then
  touches the GitLab store (`gh pr list -R the-metafactory/soma --state merged
  --search gitlab`: the newest are #702 and #704, both before 0.23.1).
- soma #706 (map: GitLab CE as a work-graph backend) and soma #707 (decision:
  what is a map on GitLab CE), both open.

This session made no GitLab calls, reads included. Nothing in it holds a
GÉANT token (the `RANGER_*_GL_TOKEN_GEANT` names from node #95 are not
exported here). soma's glab transport would therefore have fallen through to
the principal's default glab config. The map rules out both a write under the
principal's GÉANT credential and a read through glab config fallback.

## Why there is no root

- The instance is GitLab CE 19.4.1. `claw` and `claw/crisis-simulator` offer
  Issue, Task, Incident and Ticket, and no Epic (#93 F1).
- A GitLab `chart` always creates an Epic in the home project's group. The type
  lookup throws `GitLab namespace <group> has no Epic work-item type`
  (`soma/src/work-graph-gitlab.ts:255`, `:279`; #93 F2). No other root shape
  exists in 0.23.1.
- Getting Epics needs a paid licence, which is an instance-admin change. The
  map rules that out.

## Why #60, #61, #62 and #33 cannot sit under a root

- **No verb does it.** The verbs are `frontier`, `node`, `claim`, `release`,
  `add`, `chart`, `close`, `audit` and `decisions`
  (`soma/src/cli/graph.ts:90`). Only `add` and `chart` create membership, and
  both create new work items. The store has no adopt or reparent method (#93 §4).
- **CE would refuse it anyway.** On this instance an Issue's allowed parent
  types are `[]`. Only Issue/Incident/Ticket → Task exists, and a Task takes no
  children (#93 F4, §2). The four nodes are typed Issues, so a raw tracker
  write could not parent them either. The map forbids such a write in any case.
- **Re-filing through `add` is not available yet.** `add` needs a parent, and
  there is no root to add under.

State of the four nodes on 2026-10-06 (from #93 §4): each is a typed `Issue`
with a `soma:work-graph-node` block, `parent: null` and no children. #61 and
#33 are assigned to the principal. #33 has a `relates_to` link to #32.

## Chosen workaround: the soma path, through soma #707

The node allows either a soma issue or a re-file through `soma graph add`.
The re-file needs a root, and the root needs soma, so the soma path comes
first.

1. **Root shape: soma #707 already covers it.** Its proposal is an Issue root
   in the home project with the typed map block, Tasks as native children,
   and blockers in the typed block. That is #93 O1. Once it ships,
   `soma graph chart --home-project claw/crisis-simulator` produces the root
   ref `gitlab:gitlab.software.geant.org/claw/crisis-simulator#<iid>`, and
   `<iid>` is the root id for `ranger.yaml`.
2. **Adopting existing Issues: soma #707 does not cover it yet.** Its proposal
   only lets an Issue-typed build ticket link to its node with `relates_to`;
   it gives no way to make an existing Issue a member. That gap still needs
   a soma decision. Proposed text, for the principal to add to soma #707 or
   file as a sibling node under soma #706:

   > **Adopting an existing typed Issue into a CE map.** On GitLab CE an
   > Issue has no allowed parent type, so an existing typed node (an Issue
   > with a `soma:work-graph-node` block) cannot join an Issue-rooted map.
   > Should soma grow a verb that converts it to a Task under the root
   > (`workItemConvert`, then set the parent), keeping its iid, history and
   > block? Or does adoption mean re-filing through `add` and superseding
   > the original? First consumer: `claw/crisis-simulator` #60, #61, #62
   > and #33 (ranger node #98). Not yet tested on CE: whether
   > `workItemConvert` keeps the iid and notes, and which role it needs.

3. **Fallbacks, if soma declines to adopt.** These are the principal's call,
   not ranger's:
   - O3: once the root exists, re-file each node with `soma graph add` under
     it, using its body, checkpoint and autonomy. Then supersede the original
     Issue. This loses the original iid, its history and its assignee. Closing
     an original is a `soma graph close`, so it has to pass that node.s own
     checkpoint gate.
   - O5: register each existing Issue as its own one-node map. This needs
     nothing new in soma. But a root's frontier is its children, and these
     have none, so ranger would find nothing to walk. It also needs the
     registry to hold several crisis-simulator roots.

## What re-running node #98 looks like once soma ships the CE root

Under ranger's GÉANT write identity (the project-token bot from node #95),
with its `GLAB_CONFIG_DIR` pinned, never the principal's glab login:

```sh
soma graph chart --home-project claw/crisis-simulator ...   # Issue root (soma #707 shape)
# then, depending on the soma ruling on adoption:
#   adopt verb:  convert #60, #61, #62 and #33 into Tasks under the root
#   O3 re-file:  soma graph add <root-ref> ... once per node, then supersede the originals
soma graph frontier gitlab:gitlab.software.geant.org/claw/crisis-simulator#<iid>   # expect the four nodes
```

The `ranger.yaml` entry for the root is a separate, not-yet-specified slice.
Today `REPO_PATTERN` (`src/config.ts`) accepts only a bare `owner/name`, and
`somaRepo()` (`src/graph.ts:35`) turns a bare repo into a `github:` ref. A
`gitlab:` entry would fail to parse until the forge-seam config slice lands.
