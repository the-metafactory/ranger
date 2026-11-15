# Reviewed Bun profiles

`createReviewedProfile(input)` in `src/remote-test/profiles.ts` expands a reviewed recipe into a V1 manifest with named commands and a canonical SHA-256 digest. Start with [the placeholder input](examples/remote-test-myelin-profile.json), replace every placeholder privately, generate the manifest and review it before adding it to both executor and SSH allow-lists. Runtime `imageReference` still belongs in the private executor config and must match `imageDigest`. No live allow-list is enabled by this change.

The first recipe is `myelin-v1`, bound to `github:github.com/the-metafactory/myelin` and Linux ARM64. Its commands and dependencies were inspected at Myelin commit `c67e64fe2f4c6be749f5eeea4b1d565a91dde2d9`. Unit checks include `src`, `scripts`, `tools` and the package export smoke test; integration checks include `tests/integration`; typecheck and lint invoke the installed TypeScript and ESLint entrypoints through Bun. Every check a recipe declares is mandatory, without duplicate names, and a name the selected recipe does not declare is refused. Arbitrary argv, graphical/platform-specific commands, endpoints, credentials, extra services and mutable sidecar image tags are rejected. Each recipe also pins its repository's package name, every package script its commands call and the source roots a test file may live in; a changed value refuses execution pending renewed recipe review. Additional repositories need a code-reviewed recipe; this is not a generic script runner. Legacy approved V1 manifests remain supported with their existing operator-owned approval boundary.

The pinned Bun image must contain a self-contained Linux ARM64 dependency snapshot at `/opt/ranger-dependencies/node_modules` and its original `bun.lock` alongside it. The wrapper verifies the image lock digest, refuses source-owned `node_modules`, copies the snapshot into this job's checkout without hardlinks, then runs `bun install --frozen-lockfile --offline --ignore-scripts --backend=copyfile --cache-dir=/tmp/ranger-install`. Bun configuration and automatic env-file loading are disabled. There is no reusable writable dependency cache or shared `node_modules`; install scratch is private and destroyed with the container. Missing dependencies fail offline rather than downloading packages or a runtime. The reviewed recipe explicitly binds `runtime: bun-1.3.14` and refuses any other Bun version before installation; CI uses the same fixed version. Runtime images are inspected locally at their manifest digests and never pulled.

The NATS image must be a reviewed Linux ARM64 image containing `/nats-server`, `/bin/sh`, `id` and `cat`, supporting JetStream and execution as the operator's non-root UID/GID. It receives no configuration file or inherited credentials. Its fixed startup checks actual cgroup CPU, memory, swap and PID limits before launching NATS on loopback port 4222 with JetStream storage in a disposable, bounded `/data` tmpfs volume. NATS owns a `network=none` namespace; the test container joins only that container's namespace. No host port is published, no external network is created and no control-plane connection or leaf configuration exists. When the recipe declares a sidecar, the wrapper waits for its NATS PONG; a recipe that declares none starts no broker and skips that wait. Every reviewed command gets only PATH, HOME and the fixed job-private `NATS_URL`. Job `.env` files cannot override it.

| Container | CPU ceiling | Memory ceiling | PID ceiling |
| --- | ---: | ---: | ---: |
| Tests and install | 1.75 cores | 1,280 MiB | 224 |
| NATS | 0.25 cores | 256 MiB | 32 |
| Aggregate | 2 cores | 1,536 MiB | 256 |

Each container has its own enforced cgroup ceiling; their sums bound aggregate use. NATS `/data` is 128 MiB and each container's `/tmp` is 64 MiB, charged within its memory ceiling. Both containers carry this ledger's job/attempt labels and independent conmon timeouts. Teardown removes tests before their namespace-owning sidecar; recovery applies the same ordering even if inventory returns NATS first. Uncertain creation, unknown mounts, missing controller files, sidecar death/OOM, cancellation, incomplete terminal output or failed cleanup cannot return passed. Uncertain allocations retain the lane for fenced operator recovery.

Reviewed receipts include `coverage.requiredSkippedTests`. A skipped or todo required test produces `infra_failed` even when Bun exits zero, with its skip count retained; missing/empty test summaries cannot pass. Unknown coverage is null. SSH also refuses reviewed passed receipts without explicit zero skips. Logs stay bounded and private. Resource observations sum test/NATS CPU time and their separate peak memory readings; the peak sum is a conservative upper bound, not a simultaneous peak measurement. If aggregate measurements are incomplete they are reported unavailable, never as test-only aggregate evidence. A successfully enumerated sidecar cgroup without optional `memory.peak` preserves the observed test outcome with null aggregate measurements. A listed peak must be readable and valid; failed enumeration, mandatory CPU/OOM reads, malformed telemetry or sidecar OOM still fail closed.

Policy/plan regressions use an injected engine and real immutable Git bundles. The wrapper regression executes a frozen offline install and real Bun tests against disposable files and a local protocol fixture. These checks do not establish ARM64 kernel enforcement. For an operator-prepared Linux ARM64 host, set `RANGER_MYELIN_INTEGRATION_IMAGE` and `RANGER_NATS_INTEGRATION_IMAGE` to already-present pinned images, and `RANGER_MYELIN_INTEGRATION_WORKTREE` to an absolute, clean Myelin checkout; run `bun test test/remote-test-profiles-integration.test.ts`. This explicit opt-in runs the real reviewed suite with disposable NATS, observes aggregate resources and verifies lane/source teardown. It does not provision a host or pull images. Actual ARM64 enforcement, resident-service capacity and live profile promotion remain the separate pilot checkpoint.

Flag semantics: [Podman create](https://docs.podman.io/en/latest/markdown/podman-create.1.html) and [Bun frozen/offline installs](https://bun.sh/docs/pm/cli/install).

Repository command verification at the inspected Myelin revision passed 1,769 unit tests and 36 integration tests across all 11 integration files, each with zero failures, zero skips and zero todos, plus typecheck and lint (two lint warnings, no errors). The integration run used a disposable native NATS 2.14.0 process bound to an OS-selected loopback port, with fresh temporary JetStream storage and an explicit environment without bus/domain credentials; that process and storage were removed afterward. Copying the dependency snapshot and installing with an empty private cache also passed under Bun 1.3.14. These native checks establish recipe compatibility and real broker behavior; they do not establish Linux ARM64 container startup, kernel enforcement or service capacity. The operator-prepared container fixture above remains unrun in this delivery.

Both complete captured native Bun outputs were also replayed through the executor-generated wrapper with disposable controller/readiness fixtures: the real summaries decoded as 1,769/36 executed tests and zero skipped/todo tests; the wrapper returned `passed`, exit zero and `coverage.requiredSkippedTests: 0`. The controller/resource values in this replay are fixtures, not kernel measurements. This verifies summary compatibility without claiming a container run. Local Ranger `bun test` now requires Bun 1.3.14 for the reviewed-wrapper regression, and the entire CI suite is pinned to that version.

## `ranger-v1`

`ranger-v1` is bound to `github:github.com/the-metafactory/ranger`, needs no sidecar, and runs three checks after the frozen offline install: `unit`, `typecheck`, `lint`. They match the map's `commands.test` (`bun run test`, `tsc --noEmit`, `bun run lint`), with these named differences:

- `unit` runs `bun test` with `--preload=./test/preload.ts`, `--randomize`, `--timeout=60000` and `--parallel=2`. Bun configuration is disabled in the container (`--config=/dev/null`), so the settings `bunfig.toml` carries are passed as flags. `--parallel=2` fits the two-core budget; the local script uses 4.
- `lint` runs ESLint directly. `eslint/suppressions-guard.ts` is not run: it compares the suppression baseline with `origin/main`, which an immutable source bundle does not contain. The merge gates still run it locally and in CI.
- Four test files are excluded by name (`RANGER_OPT_IN_TEST_FILES` in `src/remote-test/recipes.ts`), because they skip unless an operator supplies a Podman image, an SSH fixture or a `nats-server` binary, and a skipped required test makes a receipt `infra_failed`: `remote-test-executor-integration`, `remote-test-profiles-integration`, `remote-test-ssh-integration` and `remote-test-bus-worker-transport`. Any other exclusion needs a reviewed change to that list.

### Runtime image requirements

The image needs everything the Myelin image needs (pinned Bun 1.3.14, `/opt/ranger-dependencies/node_modules` with its `bun.lock`), plus:

- `git` and `git-lfs`. The suite drives real git repositories. `git-lfs` must be exactly 3.8.1, or `git-lfs-hook-stubs` skips its real filter-process test and the receipt fails.
- A non-root user: `remote-test-baseline-peak` skips its unwritable-root test as uid 0.
- A writable temporary directory that accepts non-UTF-8 file names, or two `git-ops` and one implement end-to-end test skip.
- `sh`, `tar` and coreutils for the fixtures that spawn them.

### Tests that need network, macOS or a real home directory

Nothing in the suite reaches a real network: the GitHub and GitLab tests use fixtures and local servers, and the container has no network. Tests that read `HOME`, `homedir()` or `process.platform` build a temporary home in the test. The four opt-in files above are the only deliberate exclusions.

### Unverified here

This recipe has not been run in the container. The 2026-11-15 trial on a 2-vCPU x86 VM took 324 s with 56 of 3778 tests failing (git-lfs, cgroup timing, canonical-clone bootstrap, remote supervisor). If the container run fails beyond that list or exceeds two cores, 1.5 GiB or ten minutes, escalate with the failing tests instead of widening the recipe. Whether Bun 1.3.14 accepts `--path-ignore-patterns` and `--parallel` is also unchecked here; the local Bun is 1.4.4.

## `cortex-v1`

`cortex-v1` is bound to `github:github.com/the-metafactory/cortex`, needs no sidecar, and declares one check per `scripts/check.ts` gate at cortex commit `4b79b01a`, except `up-to-date` (marked `localOnly` because it needs `origin/main`, which an immutable bundle does not carry). The `test` gate's five steps are separate checks because only its last step takes the reviewed exclusions:

| Check | Runs |
| --- | --- |
| `lint` | `scripts/check.ts lint` (`suppressions-guard.ts` + ESLint) |
| `duplication` | `scripts/check.ts duplication` (jscpd ratchet) |
| `unused-exports` | `scripts/check.ts unused-exports` (knip ratchet) |
| `typecheck` | `scripts/check.ts typecheck` (`bunx tsc --noEmit`) |
| `vocab` | `scripts/check.ts vocab` (`check-carveouts.sh` + `check-wire-vocab.ts`) |
| `sdk` | `scripts/check.ts sdk` (`sdk:dts:check`, release pins, desk SDK, conformance export) |
| `shippable` | `scripts/check.ts shippable` (`check-shippable-hygiene.ts`) |
| `xdg` | `scripts/check.ts xdg` (`xdg-audit.ts --repos .`) |
| `test-wake` | `scripts/build-desk-wake.ts` |
| `test-wake-cache` | `scripts/desk-wake/probe-build-cache.ts` |
| `test-desk-probes` | `scripts/check-desk-probes.ts` |
| `test-conversation-tools` | `scripts/probe-conversation-tools.ts` |
| `test` | `bun run test --parallel=2` with the reviewed exclusions, the disabled checkout config and cortex's preload below |

### Base refs

The immutable bundle carries the submitted commit's full ancestry but no remote refs. Three ratchets read `origin/main` through `resolveBaseRef` and exit 2 when it is absent: the suppression baseline in the `lint` gate, and the release-pin and desk-SDK drift checks in the `sdk` gate. The recipe sets their documented overrides (`LINT_BASE_REF`, `RELEASE_PINS_BASE_REF`, `DESK_SDK_BASE_REF`) to `HEAD^`, the newest commit the bundle contains. The comparison base is therefore the submitted commit's parent, not the merge base with `origin/main`: for a single-commit head they are the same, and for a multi-commit head the drift check is narrower. `bun run check` locally still uses `origin/main`, so this is a remote-lane difference, recorded rather than silent.

### Bun configuration

Every check starts with `bun --config=/dev/null --no-env-file`, the prefix `myelin-v1` and `ranger-v1` share, so the checkout's `bunfig.toml` and `.env` never reach the process the recipe launches. Two cortex scripts spawn Bun children that read `/work/bunfig.toml` again: `scripts/check.ts` runs each gate step as its own `bun`/`bunx` command, and `scripts/test.ts` spawns `bun test` once it has built a temporary `HOME` and `TMPDIR`. At cortex `4b79b01a` that file holds one key, `[test] preload = ["./scripts/test-preload.ts"]`, which only the suite uses.

The test check therefore forwards `--config=/dev/null` to the spawned suite and passes `--preload=./scripts/test-preload.ts` itself, so the suite loads that preload because the reviewed recipe declares it. The preload refuses a run against the real `HOME` or a temp directory that outlives the run, and fails a test that leaks a non-zero `process.exitCode`. The gate steps that `scripts/check.ts` spawns keep reading the checkout's `bunfig.toml`, because that script builds their argv and no flag reaches them; this recipe does not claim config isolation for those children, only for the commands it launches.

### Network and sidecar

- The only network use is `scripts/build-desk-wake.ts`, which downloads three sha256-pinned archives from `registry.npmjs.org` and the sherpa-onnx GitHub release. The image seeds the dependency snapshot's `node_modules/.cache/desk-wake/<sha256>` with them; the script verifies each sha256 before extraction, so the build stays offline. `probe-build-cache.ts` then reuses those archives. A missing or altered archive fails the check instead of fetching.
- No gate talks to a shared broker. Cortex's suites start their own disposable `nats-server` on loopback, so the recipe declares no NATS sidecar and the test container runs with `--network=none`.
- `check-wire-vocab` resolves the Myelin RFC pack through `MYELIN_RFC_DIR`, a `../myelin` checkout or `gh api`. With none present it prints a non-blocking `SKIPPING` line and exits zero.

### Runtime image requirements

Everything the Myelin image needs (pinned Bun 1.3.14, `/opt/ranger-dependencies/node_modules` with its `bun.lock`), plus:

- `git`, `bash` and `grep`: `shippable` and `xdg` call `git`, and `vocab` runs `check-carveouts.sh`.
- `tar`: `build-desk-wake` and `probe-build-cache` extract the pinned archives.
- `nats-server` 2.14.0 on `PATH`: six suites skip without it, and a skipped test fails the receipt.
- `node` on `PATH` (any current LTS): the cc-events mTLS wire test starts a Node TLS server.
- `/usr/bin/env`: the base-ref overrides are passed as an argv prefix.
- The three wake archives at `node_modules/.cache/desk-wake/031b235001fb41cc20ad405abe48e07891094047d6f462c9bdbb5a57434d2d54`, `.../74ad6965c6f8cb61d17b1798d48095c3238eca5707b517640a12150f17b8f93d` and `.../f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a`.
- A non-root user and a writable `/tmp` that a full run's temporary homes and repositories fit in.

### Excluded tests

A skipped or todo test makes a receipt `infra_failed`, so `CORTEX_EXCLUDED_TESTS` in `src/remote-test/recipes.ts` excludes whole files that gate themselves on a capability this lane does not provide: the three macOS `sandbox-exec` files, the three `claude`-binary files, the two `SYSTEMD_E2E` files, the `scan-deploy-surface` engine-pack cases, the built-dashboard case and the five `pi`-binary files. Each entry carries its reason; any other exclusion needs renewed review. The bluntness costs coverage: a file with one gated test loses its ungated tests too, and `bun test` cannot filter a `describe.skip` block by name. `src/bus/nats/__tests__/connection.test.ts` is kept because only its empty `test.skip` placeholder is gated; `--test-name-pattern` drops that one test by name. `scripts/test.ts` forwards its own argv to `bun test`, so every reviewed flag and exclusion reaches the suite.

### Unverified here

This recipe has not been run in a container. Cortex's CI `Test` job (`bun scripts/check.ts test`) took 5 m 48 s on an `ubuntu-latest` runner with Bun latest; the profile pins Bun 1.3.14, and cortex warns that Bun before 1.4.3 can hang in `Bun.spawnSync` once a child exits. Two cores, 1.5 GiB, ten minutes and the 64 MiB `/tmp` tmpfs are not measured against this suite. `scripts/test.ts` at `4b79b01a` forwards `process.argv.slice(2)` to `bun test`, so the reviewed flags reach the suite; a local Bun 1.4.4 probe of the reviewed command shape ran `scripts/__tests__/check-unused-exports.test.ts` green through `scripts/test.ts`, `--config`, `--preload` and `--test-name-pattern` included. Whether Bun 1.3.14 accepts `--parallel`, `--path-ignore-patterns`, `--test-name-pattern`, `--config` and `--preload` as the recipe passes them is unchecked (as with `ranger-v1`; the local Bun is 1.4.4). If the container run fails or does not fit, escalate with the failing tests and the measurement instead of widening the recipe.
