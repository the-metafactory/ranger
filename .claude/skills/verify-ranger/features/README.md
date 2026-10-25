# ranger verification map

The maintained source for verifying ranger's user-facing behavior. Read this
index, then use the matching feature file as the recipe.

## Baseline preconditions

- `RUN=$(scripts/launch.sh | tail -1)` succeeded and `scripts/doctor.sh "$RUN"` exits 0.
- The dashboard is at `http://127.0.0.1:7399` (or `$VERIFY_RANGER_PORT`), serving this checkout on a snapshot of the live journal.
- CLI steps run after `source "$RUN/state/env.sh"` from the checkout doctor printed, with `--config "$RUN/state/ranger.yaml"`.
- Never drive the live dashboard on 7311 or the live journal.

## Driving conventions

- Dashboard: `bun scripts/drive.ts "$RUN"`; extend it with a `check(...)` for a new element instead of reading the screenshot by eye.
- Handles are element ids from `renderPage` in `src/serve.ts` (`#needsyou`, `#grill`, `#refresh`, `#msg`, ...) and the `/api/state` JSON.
- Only GETs and `POST /api/refresh` leave the browser. Every other dashboard action is proven through its CLI verb with `--dry-run`, or through `bun test`.
- The snapshot is frozen at launch: compare the page to `$RUN/evidence/*-state.json`, not to GitHub now.

## Proof and skip reporting

- Cite the `ok`/`FAIL` lines, the evidence paths under `$RUN/evidence/`, and the HEAD doctor printed.
- CLI proof: the command, stdout (redirected into `$RUN/evidence/`), and exit code.
- An entry point you did not drive is reported as not verified, with the reason; it is never covered by a different path.
- When the snapshot lacks a row a journey needs (no approvable node, no failed worker), report the journey failed for that precondition. Do not weaken it.

## Features

- [Dashboard overview](./dashboard-overview.md): the six sections render the journal's state; Refresh.
- [Approve a propose node](./approve-node.md): the dashboard's Approve button and its `approve-node` verb.
- [Journal inspection](./journal.md): `ranger journal`, whole and per node.
- [Scheduled jobs](./jobs.md): `ranger job list` and the dashboard's lane rows.
- [Scout digest](./scout.md): `ranger scout`, the read-only frontier digest.
