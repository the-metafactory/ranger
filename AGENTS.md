# Agent rules

Rules an agent working in this repo keeps getting wrong, and what stops it.
Prefer a check over a line here; a rule marked "docs only" has nothing that fails.

| Rule | Enforced by | Proven on |
| --- | --- | --- |
| The operator's `ranger.yaml` lives in `~/.config/ranger/`, never in the repo; a test builds its own config. | `.gitignore` (`/ranger.yaml`); `test/forge-ref.test.ts` reads a fixture | `5023b75`: the old pinned-registry test fails |
| Only `src/journal-guard.ts` reads test mode (`underTest`, `RANGER_UNDER_TEST`, `NODE_ENV`); inject the dependency instead. | `no-restricted-syntax` in `eslint.config.ts` | `55eaf38` (`src/host-load.ts:21`) |
| Code says it; comments don't. | `ranger/no-comments` + `eslint/suppressions-guard.ts` | `619568f` (#245, fixed by #318) |
| Ask `src/liveness.ts` whether a worker row is live; never compare `status` with `"claimed"` inline. | `no-restricted-syntax` (`LIVENESS`) in `eslint.config.ts`; `test/liveness-lint.test.ts` | #65 `33fe01f` (`src/sweep.ts:73`), #481 `1655814` (`src/node-ownership.ts:33`) |
| A caught failure never comes back as `null`, `false`, `[]` or `{}`: rethrow, return a failed result, or test the error first. | `ranger/no-silent-catch` (`eslint/no-silent-catch.ts`), ratcheted by `eslint-suppressions.json`; `test/no-silent-catch-rule.test.ts` | #515 `0f768c2` (`src/scribe.ts:590`), #221 `68d3d4f~1` (`src/remote-test/bus-source.ts:183`) |
| A node stuck on a failure that never clears goes quiet within a bounded number of ticks (parked, dropped or escalated). A new wait or requeue path adds its scenario to the soak test. | `test/no-endless-wait.e2e.test.ts` | #504 (`c2a7bf3~1`, `src/closure-sweep.ts`); the resume queue's 3-start drop removed |
| A second copy of logic becomes one helper both sites call. | docs only: `jscpd` missed #234, #235, #304 and #311 at 15–50 tokens, and saw #282 only at 15–20 tokens among 45–60 existing clones | — |
| A PR body or doc claims only what a test or probe shows. | docs only (sage review) | — |
| After merging a PR here, deploy it: `arc upgrade ranger --force`, then restart `ranger serve` (README, "Deploy a merged change"). Live ranger runs the arc install, never this checkout. | docs only | — |

## Exceptions

| Where | Rule | Why | Until |
| --- | --- | --- | --- |
| `src/host-load.ts:21` | test mode | CLIs a test spawns read a quiet host; contexts default to the real reader | #324, 2026-11-16 |
| `src/intake.ts:14` | test mode | a spawned tick under test must not call `claude -p` | #324, 2026-11-16 |
