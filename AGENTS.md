# Agent rules

Rules an agent working in this repo keeps getting wrong, and what stops it.
Prefer a check over a line here; a rule marked "docs only" has nothing that fails.

| Rule | Enforced by | Proven on |
| --- | --- | --- |
| The operator's `ranger.yaml` lives in `~/.config/ranger/`, never in the repo; a test builds its own config. | `.gitignore` (`/ranger.yaml`); `test/forge-ref.test.ts` reads a fixture | `5023b75`: the old pinned-registry test fails |
| Only `src/journal-guard.ts` reads test mode (`underTest`, `RANGER_UNDER_TEST`, `NODE_ENV`); inject the dependency instead. | `no-restricted-syntax` in `eslint.config.ts` | `55eaf38` (`src/host-load.ts:21`) |
| Code says it; comments don't. | `ranger/no-comments` + `eslint/suppressions-guard.ts` | `619568f` (#245, fixed by #318) |
| A second copy of logic becomes one helper both sites call. | docs only: `jscpd` missed #234, #235, #304 and #311 at 15–50 tokens, and saw #282 only at 15–20 tokens among 45–60 existing clones | — |
| A PR body or doc claims only what a test or probe shows. | docs only (sage review) | — |

## Exceptions

| Where | Rule | Why | Until |
| --- | --- | --- | --- |
| `src/host-load.ts:21` | test mode | CLIs a test spawns read a quiet host; contexts default to the real reader | #324, 2026-11-16 |
| `src/intake.ts:14` | test mode | a spawned tick under test must not call `claude -p` | #324, 2026-11-16 |
