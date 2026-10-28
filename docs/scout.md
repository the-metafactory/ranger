# Scout

`ranger scout` reads every registered map and prints a digest of its frontier, its audit, and the nodes that wait for the principal. It writes nothing to the graph. Scout was the first piece of ranger to ship (build-path step 1, node #12).

```bash
ranger scout                       # text report
ranger scout --json                # machine-readable report
ranger scout -c /path/ranger.yaml  # explicit config
```

## Read-only token gate

Each map runs under a fine-grained read-only PAT that `auth.readOnlyTokens` names (node #8). Scout stops working on a map when that token is unset or can write. It never falls back to the `gh` keyring, because the keyring token can write. Scout also checks that the token can read the map's repo.

## Fixed verbs

Scout calls only `soma graph audit`, `soma graph frontier`, and `soma graph node`, each with `--json`. Ranger checks that a verb is in this read-only set before it starts the subprocess.

## Route classes

Scout sorts each frontier node into one route class (design §3):

- HITL escalate: a `propose` or `approve` node, a node of a HITL kind marked `auto`, or a node that needs typing.
- Research: an `auto` research node.
- Implement: a task or build node on a `walk: full` map.
- Provisioning: a node whose probes are missing from the probe registry.

The report also lists the HITL nodes waiting, stale claims (the audit's `openClaimed`, both in flight and stale), and closes without a receipt.
