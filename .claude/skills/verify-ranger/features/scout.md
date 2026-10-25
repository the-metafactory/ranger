# Scout digest

`ranger scout` reads every registered map from GitHub with the read-only PATs
and prints, per map, the frontier by routing (escalate, provisioning, walk),
the HITL nodes waiting on the principal and the audit. It writes nothing to
the graph. Exit 0 when every map read, 2 when one failed.

## Sub-features

- `scout-text` text digest: header `ranger scout — <time>`, `identity: <login> (fine-grained)`, then one `map:` block per registered map.
- `scout-json` `--json` emits the same report as JSON.
- `scout-fail` a map that could not be read sets exit 2.

## How to get to it (user POV)

- `ranger scout [--json]`.

## Driving it with the CLI

Preconditions: baseline; the change under test is in scout, digest or routing (scout costs ~4.5 min and GraphQL budget).

- **Digest.** `time bun src/cli.ts scout --config "$RUN/state/ranger.yaml" > "$RUN/evidence/scout.txt" 2>&1; echo $?`. Exit 0; line 2 reads `identity: jcfischer (fine-grained) · read-only surface: audit/frontier/node`; one `map:` block per map in the config.
- **JSON.** `bun src/cli.ts scout --json --config "$RUN/state/ranger.yaml" > "$RUN/evidence/scout.json"`. `maps[].ok` all true.

## Gotchas

- `identity:` naming the machine account or a classic token means the write token leaked into the env: stop and re-source env.sh.
- Scout reads GitHub now, the dashboard reads the snapshot: counts can differ by whatever the tick changed since launch.
- A secondary rate limit shows as a map error while `/rate_limit` still has budget; wait, don't retry in a loop.
