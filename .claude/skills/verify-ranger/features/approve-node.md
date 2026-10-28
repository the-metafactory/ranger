# Approve a propose node

The principal approves an approval-gated task or build node from the
dashboard; ranger then walks it through its normal review and merge gates
(node #395). The button runs `ranger approve-node <id> --map <key>
--approval-version <hash>`, which rewrites an `approve` node's block to
`propose`, or adds an approval marker to a `propose` node (GitHub or GitLab).

## Sub-features

- `approve-button` an approvable decision under `#grill` has an `Approve` button (confirm dialog, then `POST /api/approve`).
- `approve-refusal` a stale version is refused with 409 "node changed; refresh before approving"; a non-approvable node with 409 "only approval-gated task/build nodes on implementation maps can be approved"; a node not awaiting a decision with 404.
- `approve-verb` `approve-node --dry-run` validates without writing and prints `{"approved":false,"dryRun":true}`.

## How to get to it (user POV)

- Dashboard: "Needs your decision" → a node tagged `build · approve`, `task · approve`, `build · propose` or `task · propose` that has an `Approve` button → `Approve`.
- Terminal: `ranger approve-node <id> --map <repo#root> --approval-version <hash> [--dry-run]`.

## Driving it with the CLI dry run

Preconditions: baseline; `$RUN/evidence/*-state.json` from a drive run has a decision with `"approvable": true`. Take its `id`, its map `key` and its `approvalVersion`.

- **Dry run.** `cd "$(cat "$RUN/state/checkout")" && source "$RUN/state/env.sh" && bun src/cli.ts approve-node <id> --map '<key>' --approval-version <approvalVersion> --dry-run --config "$RUN/state/ranger.yaml" | tee "$RUN/evidence/approve-dry-run.json"`. Expect `{"approved":false,"dryRun":true}`, exit 0.
- **Button.** Not driven: the guard blocks `POST /api/approve`, and the server would run `~/bin/ranger` (main checkout, write tokens). Prove the server side with `bun test test/serve.test.ts test/approve-node.test.ts`.

## Gotchas

- `approve-node` uses the principal's own gh keyring login (its env allowlist drops `GH_TOKEN` and `GH_CONFIG_DIR`), so the read-only env does not protect it. Never drop `--dry-run`.

- Before #399 the flag was `--version`, which commander's program `--version` took: the CLI printed `0.1.0`, exit 0, and approved nothing. `test/approve-node.test.ts` now runs the dashboard's argv through the real CLI.
- The live dashboard's Approve button is real: it edits the GitHub issue under the principal's own gh login (keyring), not the machine account.
- Approval versions change when the node's spec changes; take the version from the same state dump as the id.
