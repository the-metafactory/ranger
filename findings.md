# crisis-simulator on ranger's walker host: install, test, and pre-push gates

Research node #94, map the-metafactory/ranger. Checkpoint: `crisis-simulator-worker-env-surveyed`.

**Sources.** I read the files from `claw/crisis-simulator` `origin/main` in the principal's checkout (`~/work/cyphr/crisis-simulator`) with `git show`. That checkout itself was not changed. `origin/main` moved from `2e41c5f0` to `6e3c059b` while I worked (the principal's fetches), but `git diff --stat` shows no change to any file surveyed here. A re-check at `7174c6aa` found the same: the only changes since `6e3c059b` are one component, its new test file and three locale catalogs. I took measurements in throwaway `git archive` extracts under `/tmp`. Each ran under a worker-like env: `env -i`, ranger's launchd PATH, no `DATABASE_URL`, and no `.env` file. The final run used the exact proposed YAML string through `/bin/sh -c`, as `runShell` does (`src/implement.ts:1249`).

## Answers

| Question | Answer |
|---|---|
| Frozen-lockfile install | `bun install --frozen-lockfile` on **bun 1.4.2**. This is CI's command in every job (`.gitlab-ci.yml:56,93,332,372,392`). Measured 7 s on a warm bun cache; CI's cold install takes 4–6 s (`.gitlab-ci.yml:40-41`). |
| Test command of CI's merge gate | The `test` job (4 shards, `.gitlab-ci.yml:322-350`) runs `bunx drizzle-kit migrate`, then `bun run app/db/verify-schema.ts`, then `./scripts/ci-test-shard.sh <i> 4` against a fresh `postgres:16.15-alpine` service. It does **not** use `bun run test`. `ci-test-shard.sh` with no arguments runs every test file in one process and asserts CI's collection invariant (all `*.test.ts(x)` under app/tests/scripts, at least 280 files). The tree had 359 files and 5361 tests when measured (360 files at `7174c6aa`). |
| External services | **Postgres only.** The tests need no Kusto: only two test files mention it, both in comments (`kqlEmulator.scope.test.ts:127`, `gm-knowledge.server.test.ts:6`). The key-free run passed with no Kusto and no Docker on the host. The Kusto emulator (`kustainer-linux`) is in the compose files only, for the app runtime. No secrets are needed: `.env.test` is committed with test-only credentials, and CI's `.test-db` values are literal (`.gitlab-ci.yml:289-297`). |
| Suite duration | One process on this host: **110–170 s**, 5306 pass, 55 skip, 0 fail. The whole proposed `commands.test` chain (gates + DB resets + suite + mutation + build) took **162–188 s** over two runs, against ranger's 20 min test bound (`src/implement.ts:152`). |
| Gates a worker should run | See the gate table below: typecheck, i18n lint, runtime-path lint, NUL lint, DCO, scenario-lint, mutation, build. **Not** the dependency audit. |

## Host provisioning (walker host = this Mac, arm64, macOS 26.7)

**P1. bun 1.4.2 on the command's PATH (missing today).** Under ranger's PATH (`~/bin/ranger:32` plus the launchd plist), `bun` resolves to `/opt/homebrew/bin/bun`, which is **1.3.14**. `bunx`, though, resolves to `~/.local/bin/bunx`, a symlink to `~/.bun/bin/bun` (1.4.2). Only `~/.bun/bin/bun` is 1.4.2. Three measured consequences of running on 1.3.14:
- `bun scripts/audit-gate.ts --selftest` fails 1 of 75 cases. CONTRIBUTING says the gate needs 1.4.2.
- The test preload prints `WARNING: this is bun 1.3.14, and CI runs bun 1.4.2` (`happydom.ts`, `tests/bun-pin.ts`).
- CI pins 1.4.2 in every job, and `lint-bun-pin` holds it to the Dockerfile builder stage (`.gitlab-ci.yml:27-36,101-107`).

The fix goes in the map's commands (`PATH="$HOME/.bun/bin:$PATH"`), **not** in the host PATH. It relies on `HOME` reaching the command, which `workerHostEnv` passes through (`src/worker-env.ts:24`). Without it the prefix would be `/.bun/bin`, `bun` would fall back to 1.3.14, and the chain would still pass, since no step in `commands.test` fails on 1.3.14; only the preload warning would show it. Moving ranger's own PATH would switch ranger's own `bun test` and the other maps to a different bun, and GitHub maps must not regress. When crisis-simulator bumps bun, `~/.bun/bin/bun` has to follow (`bun upgrade` to the pinned version). The pin is in the Dockerfile's `FROM oven/bun:<v> AS builder` line.

**P2. Local Postgres with role `cyphrsec` (present today).**
- Homebrew `postgresql@17` 17.7 runs as a launchd service on `localhost:5432`.
- Role `cyphrsec` exists with `CREATEDB` (not superuser), and the password in `.env.test` works: the migrations connected with it.
- `scripts/db-setup.ts` is the repo's way to create that role on a fresh host: `PG_ADMIN_URL=… bun scripts/db-setup.ts test`.
- **Version gap:** the host runs 17, CI and the deploy hosts run 16.15 (`.gitlab-ci.yml:304-306`). The full suite and the migrations pass on 17, but a 16-vs-17 behaviour difference would only show in CI.

**P3. A dedicated test database for ranger, not the principal's `cyphrsec_test`.** Every checkout points at the same `cyphrsec_test` (`.env.test`), including the principal's own (on a feature branch today). A ranger run on that database would collide with the principal's runs. Drizzle only migrates forward, so a branch's migration would also leave the schema ahead of `main` for everyone else.

The test guard only checks that the URL *contains* `/cyphrsec_test` (`app/db/test-utils.ts:29`, `app/db/env.ts:103`), so a separate name passes. The proposal therefore uses **`cyphrsec_test_ranger_test`**:
- The command derives its URL from `.env.test` by `sed`, so `ranger.yaml` carries no password.
- The command recreates and migrates the database (`DROP … WITH (FORCE)` / `CREATE` as `cyphrsec`) at the start of every run, as CI's fresh service does.
- Every `commands.install`/`commands.test` run happens inside `runImplement` (`src/implement.ts:581`, called only from the worker session, `src/worker.ts:29`). That session holds its resource lane while it is claimed or running (`holdsImplementLane`, `src/lanes.ts:32`), and ranger runs one session per lane (`implementLaneBusy`, `src/walk.ts:135`). An awaiting-merge PR frees the lane but runs no further commands. crisis-simulator has no `probe`, so it is `headless` (`src/lanes.ts:14`) and never runs two of these tests at once. `views.ts:318` also runs `install`, but crisis-simulator declares no `views`.
- A second walker host, or a `views`/probe tier added later, would need a per-worktree name instead. Any `cyphrsec_test_<x>_test` works.

Probe: with a name that lacks `/cyphrsec_test` (`cyphrsec_r94_test`), shard 1 failed 228 tests on `DATABASE_URL must point to test database`. With `cyphrsec_test_ranger_test` the suite was green. I dropped the database after measuring.

**P4. Nothing else.**
- No Docker (none on the host, and none needed).
- No Kusto.
- No GÉANT network or VPN.
- No secrets beyond what `.env.test` and CI already publish in the repo.

The npm registry is needed for install, as it is in CI.

## Environment findings

**E1. LLM keys reach the test command.** `workerHostEnv` passes `ANTHROPIC_*`, `OPENAI_*`, `AZURE_*` and `GOOGLE_*` through (`src/worker-env.ts:45-60`). Seven app modules read `process.env.ANTHROPIC_API_KEY` in code (e.g. `aar-generator.server.ts:402`, `reactive/generate.server.ts:157`). CI has no key, so the suite is written for a keyless run: at least one test deletes the key to stay hermetic (`reactive/generate.server.test.ts:33-41`). Whether a test would call the live API when a key is present was **not** probed: the `unset` runs first. The `unset ANTHROPIC_API_KEY OPENAI_API_KEY` in the proposed command is a precaution that keeps the run keyless, as CI's is. The final runs set a dummy `ANTHROPIC_API_KEY` and passed.

**E2. CI's test env must be set for scenario-lint.** `scenario-lint-all.ts` threw `OPERATOR_ORG_SLUG is not set` without CI's `.test-db` variables. The command exports `NODE_ENV=test`, `OPERATOR_ORG_SLUG=switch` and `SESSION_SECRET=ci-test-session-secret`, which are CI's literal values (`.gitlab-ci.yml:289-297`). `bun test` itself auto-loads `.env.test`, and a shell-set variable wins over the file (both probed on bun 1.4.2).

**E3. DCO will block every MR unless the worker signs off.** The `dco` job (`.gitlab-ci.yml:265-277`) requires, on every non-merge commit in `origin/main..HEAD`, a `Signed-off-by` whose address equals the commit author's (`scripts/dco-check.sh:10,65-71`). Ranger's worker env sets author and committer to `<identity>@users.noreply.github.com` (`src/worker-env.ts:105-112`). `git commit -s` under that env produces a matching trailer: probed, `dco-check.sh origin/main` printed `OK`. So the mechanics work, provided the worker commits with `-s`. Ranger's implement prompt does not ask for that today, and neither does any non-merge commit the supervisor makes itself. Two items belong to the forge-seam/build slices, not here:
- The worker prompt has to ask for `-s` on a GitLab map.
- The GitHub-noreply address fits a GitLab map poorly. CONTRIBUTING asks for an address "you can be reached at", and the GitLab write identity is a project-access-token bot user (map constraint).

The check needs a non-shallow clone with `origin/main` present. It exits 2 on a shallow clone (`.gitlab-ci.yml:258-264`).

**E4. Outputs stay out of the tree.** `build/`, `reports/`, `.stryker-tmp`, `*.tsbuildinfo` and `node_modules` are all in `.gitignore`. After the full chain, `git status --short` was empty, which matters because the implement lane refuses a dirty worktree.

## CI gates: which ones the worker runs before pushing

Each measured on this host, bun 1.4.2.

| CI job | Blocking in MR? | Runs on host? | Time | In `commands.test`? |
|---|---|---|---|---|
| `typecheck` (`bunx tsc --noEmit`) | yes | yes | 25 s | **yes** |
| `lint-i18n-catalogs` (`i18n-lint.ts --selftest` + run) | yes | yes | 1 s | **yes** |
| `lint-runtime-paths` (`--selftest` + run) | yes | yes | <1 s | **yes** |
| `lint-no-nul-bytes` | yes | yes | 1 s | **yes** |
| `dco` (`dco-check.sh origin/main`) | yes (branches) | yes, needs git + `origin/main` | <1 s (selftest 6 s) | **yes** |
| `test` (migrate, verify-schema, `ci-test-shard.sh`) | yes | yes, with P1–P3 | 110–170 s | **yes** |
| `scenario-lint` (`scenario-lint-all.ts` on a fresh DB) | yes | yes, with E2 env | <1 s + 3 s migrate | **yes** |
| `test:mutation` (Stryker on authz policy, threshold 100) | yes (no `allow_failure`) | yes; `ps` exists on macOS | 20 s | **yes** |
| `docker-build` (Kaniko runs `bun run build` in the Dockerfile) | yes | `bun run build` only | 17–24 s | **yes** (the build half, with `NODE_ENV` unset as in the Dockerfile builder stage) |
| `lint-bun-pin`, `lint-compose-pins` | yes | yes | <1 s | no: they change only with Dockerfile/compose edits; CI catches them |
| `test-audit-gate` (`audit-gate.ts --selftest`) | yes | yes, on 1.4.2 only | 31 s | no: tests the gate script, not the change |
| `dependency-audit` (`audit-gate.ts`) | yes for a finding | yes, network | <1 s, passed today | **no**: registry advisories drift independently of the change; exit 75 = registry down. Leave it to CI. |
| `test-deploy-script` | yes | yes (sh + git) | 123 s | no: 2/3 of the chain's time for `deploy/claw/` changes only; CI catches them |
| `image-startup`, `drop-ci-image`, `image-audit`, `tag-latest`, `deploy:claw-test`, `deploy:claw-stage`, weekly `dev-dependency-audit`/`node-pin-audit` | — | **GÉANT CI only** | — | no |

**Cannot run outside GÉANT CI.** These are the jobs that need `CI_REGISTRY_*` credentials, the GÉANT container registry, the `gn-generic-docker-1` / `claw-test` / `claw-stage` runners, or the VPN-only hosts:
- the Kaniko image build and push,
- `image-startup` (the built image on Node 22 against its own postgres service),
- the registry cleanup and retag jobs,
- the Trivy image audit,
- both deploys.

The worker covers the parts of these that it can: the image's build step via `bun run build`. The Node-22 runtime boot (`image-startup`, the F-040 class of `scripts/lint-runtime-paths.sh`) is only partly covered, by the runtime-path lint. A Node-only boot crash first shows in the MR pipeline.

## Proposed `ranger.yaml` values

Measured end to end: the exact string below was parsed from YAML (ranger's `yaml` package and Bun's parser give the same 1089-character, single-line string) and run as `/bin/sh -c` in an extract with a signed-off worker commit on top of `origin/main`. It exited 0 in **162 s**: tsc, lints, DCO `OK`, scenario-lint PASS, 5306 pass / 0 fail, mutation score 100, build OK. The install command took **7 s**.

Notes on the proposal:
- **Order.** The cheap, DB-free gates run first, so a type or lint error fails in about 30 s. scenario-lint and the suite each get a freshly migrated database, as their CI jobs do.
- **Build env.** The chain exports `NODE_ENV=test` for the suite. The build runs under `env -u NODE_ENV`, because the Dockerfile builder stage sets no `NODE_ENV` before `bun run build` (`Dockerfile:10-25`).
- **No password in `ranger.yaml`.** `DATABASE_URL` is `.env.test`'s URL with the database renamed. `test -n` stops the chain if `.env.test`'s format ever changes.
- **Recommended follow-up (crisis-simulator's own node, not ranger's).** Move this chain into the repo as a script (e.g. `scripts/pre-push.sh`), next to the "Before you push" list in CONTRIBUTING.md, which today names `bun run test` without the migrate step. `commands.test` then shrinks to `sh scripts/pre-push.sh`. The repo would then own its gate list, and ranger's config would hold no crisis-simulator knowledge beyond one path. That fits the "generic forge, no repo-specific hard-wiring" constraint better than a 1 KB YAML string that duplicates CI.
- **Prerequisites before this entry can walk.** P1 is already met: `~/.bun/bin/bun` is 1.4.2. P2 is met. P3 needs no setup, since the command creates its own database. E3 (worker sign-off) is the one open dependency, and it belongs to the forge-seam build slices.

The proposed values:

```yaml
    commands:
      install: PATH="$HOME/.bun/bin:$PATH" bun install --frozen-lockfile
      test: >-
        export PATH="$HOME/.bun/bin:$PATH" NODE_ENV=test OPERATOR_ORG_SLUG=switch SESSION_SECRET=ci-test-session-secret &&
        unset ANTHROPIC_API_KEY OPENAI_API_KEY &&
        export DATABASE_URL="$(sed -n 's#^DATABASE_URL=\(.*/cyphrsec_test\)$#\1_ranger_test#p' .env.test)" &&
        test -n "$DATABASE_URL" &&
        reset_db() { bun -e 'import postgres from "postgres"; const u = new URL(process.env.DATABASE_URL); const db = u.pathname.slice(1); u.pathname = "/postgres"; const s = postgres(u.href, { max: 1, onnotice: () => {} }); await s.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); await s.unsafe(`CREATE DATABASE "${db}"`); await s.end();' && bunx drizzle-kit migrate && bun run app/db/verify-schema.ts; } &&
        bunx tsc --noEmit &&
        bun scripts/i18n-lint.ts --selftest && bun scripts/i18n-lint.ts &&
        bash scripts/lint-runtime-paths.sh --selftest && bash scripts/lint-runtime-paths.sh &&
        bun scripts/lint-no-nul-bytes.ts &&
        sh scripts/dco-check.sh origin/main &&
        reset_db && bun scripts/scenario-lint-all.ts &&
        reset_db && ./scripts/ci-test-shard.sh &&
        bun run test:mutation &&
        env -u NODE_ENV bun run build
```
