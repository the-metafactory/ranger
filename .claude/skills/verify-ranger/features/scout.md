# Scout digest

`ranger scout` reads every registered map from its forge (GitHub or GitLab)
with the read-only PATs and prints, per map, the frontier by route class
(`ROUTE_LABELS` in `src/route.ts`: escalate, research, implement,
provisioning, ...), the HITL nodes waiting on the principal and the audit. It
writes nothing to the graph. Exit 0 when every map read, 2 when one failed,
1 on a command error such as a bad config.

## Sub-features

- `scout-text` text digest: header `ranger scout — <time>`, `identity: <login> (fine-grained)` (`(classic)` for a read-only classic PAT, `unknown` when no GitHub map passed the gate), then one `map:` block per registered map.
- `scout-json` `--json` emits the same report as JSON.
- `scout-fail` a map that could not be read sets exit 2.

## How to get to it (user POV)

- `ranger scout [--json]`.

## Driving it with the CLI

Preconditions: baseline; the change under test is in scout, digest or routing (scout costs ~4.5 min and GraphQL budget).

- **Digest.** `source "$RUN/state/env.sh" && time bun src/cli.ts scout --config "$RUN/state/ranger.yaml" > "$RUN/evidence/scout.txt" 2>&1; echo $?`. Exit 0; line 2 reads `identity: jcfischer (fine-grained) · read-only surface: audit/frontier/node`; one `map:` block per map in the config.
- **JSON.** `source "$RUN/state/env.sh" && bun src/cli.ts scout --json --config "$RUN/state/ranger.yaml" > "$RUN/evidence/scout.json"`. `maps[].ok` all true.

## Gotchas

- Scout reads only the per-repo read-only variables and refuses a classic token with write scopes, so a missing or wrong token shows as `identity: unknown (fine-grained)` and `✗ FAILED` per map: stop and re-source env.sh. `identity:` naming the machine account means a fine-grained write PAT sits under a read-only variable name.
- Scout reads GitHub now, the dashboard reads the snapshot: counts can differ by whatever the tick changed since launch.
- A secondary rate limit shows as a map error while `/rate_limit` still has budget; wait, don't retry in a loop.
