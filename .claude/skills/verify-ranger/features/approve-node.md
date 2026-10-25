# Approve a propose node

The principal approves an approval-gated task or build node from the
dashboard; ranger then walks it through its normal review and merge gates
(node #395). The button runs `ranger approve-node <id> --map <key> --version
<hash>`, which rewrites the node's approval block on GitHub.

## Sub-features

- `approve-button` an approvable decision under `#grill` has an `Approve` button (confirm dialog, then `POST /api/approve`).
- `approve-refusal` a stale version or non-approvable node is refused with 409 ("node changed; refresh before approving").
- `approve-verb` `approve-node --dry-run` validates without writing and prints `{"approved":false,"dryRun":true}`.

## How to get to it (user POV)

- Dashboard: "Needs your decision" → a node tagged `build · approve` or `task · approve` → `Approve`.
- Terminal: `ranger approve-node <id> --map <repo#root> --version <hash> [--dry-run]`.

## Driving it with the CLI dry run

Preconditions: baseline; `$RUN/evidence/*-state.json` from a drive run has a decision with `"approvable": true`. Take its `id`, its map `key` and its `approvalVersion`.

- **Dry run.** `cd "$(cat "$RUN/state/checkout")" && source "$RUN/state/env.sh" && bun src/cli.ts approve-node <id> --map '<key>' --version <approvalVersion> --dry-run --config "$RUN/state/ranger.yaml" | tee "$RUN/evidence/approve-dry-run.json"`. Expect `{"approved":false,"dryRun":true}`, exit 0.
- **Button.** Not driven: the guard blocks `POST /api/approve`, and the server would run `~/bin/ranger` (main checkout, write tokens). Prove the server side with `bun test test/serve.test.ts test/approve-node.test.ts`.

## Gotchas

- `approve-node` uses the principal's own gh keyring login (its env allowlist drops `GH_TOKEN` and `GH_CONFIG_DIR`), so the read-only env does not protect it. Never drop `--dry-run`.

- **Fails as of dae71a8 (2026-10-25):** the dry run prints `0.1.0` and exits 0. `program.version("0.1.0")` in `src/cli.ts` owns `--version`, so `approve-node`'s own `--version <hash>` never reaches the action. `src/serve-approve.ts` builds the same argv, so the dashboard's Approve most likely reports success without writing. The tests stub the runner and never parse the argv. Recheck this journey after a fix.
- The live dashboard's Approve button is real: it edits the GitHub issue under the machine account.
- Approval versions change when the node's spec changes; take the version from the same state dump as the id.
