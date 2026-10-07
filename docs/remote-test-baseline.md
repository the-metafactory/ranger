# Private capacity baseline

`bun src/cli.ts remote-test baseline --profile <operator-json> --output <new-report-json>` inspects the local host. Add `--ssh <configured-alias>` to inspect a configured remote host. Only `--run` grants execution of the reviewed profile commands. Normal Ranger verification still uses its existing local backend.

Both configuration and output must be outside git repositories, including through symlinks. The report is created exclusively with owner-only permissions before probes run. Existing reports are never overwritten. Measurements and command output are not printed to stdout. Do not commit these files: they contain private configuration and deployment evidence.

The operator JSON has exactly these fields:

- `profile`: the V1 manifest from `src/remote-test/contract.ts`, including its binding digests and ordered command argv vectors. Operator approval, digest authentication, source staging and runtime image provisioning are prerequisites; this reporter does not authenticate those claims or promote results to merge gates.
- `cwd`: an absolute path on the target to the reviewed workload.
- `runtime`: an argv vector for a read-only runtime version probe, such as `["bun", "--version"]`.
- `cgroupRoot`: an existing delegated non-root directory below `/sys/fs/cgroup/`, with CPU and memory controllers already enabled for children. Provisioning is a separate operator checkpoint.
- `timeoutSeconds`: an integer from 1 to 3600.
- `health`: an explicit array of `{ "name": "service-name", "command": ["read-only-health-tool"] }` entries. Empty means no configured service checks, not proof of resident service health. Use exit zero only for healthy states; stdout is discarded. Never use service mutation commands for these probes.

V1 workloads require Linux ARM64, cgroup v2 aggregate CPU accounting, `memory.peak`, `memory.swap.max`, `cgroup.kill`, a writable delegated directory and standard Linux `sh`, `awk`, `grep`, `date`, `stat` utilities. Unsupported hosts or missing runtime/metric/health probes receive explicit failed/unavailable entries and exit nonzero. All preflight checks must pass before execution; available memory below the 1.5 GiB job cap yields rather than starting a job. Available memory is the minimum of host `MemAvailable` and remaining memory headroom in the delegated root and each constrained ancestor.

Each run exclusively creates `ranger-baseline` below the delegated root: an existing lane causes refusal, never force-start or removal. It applies a two-core CPU quota, 1.5 GiB aggregate memory limit, zero swap allowance and group OOM handling before moving the workload shell into the child. Commands run in order and include descendants in CPU seconds and peak memory. A target-side watchdog bounds execution even if SSH disconnects. Any surviving sidecar causes failure and is killed in this newly-created group; resident services are never moved or paused. The group is removed on exit; failed cleanup is a failed measurement and a retained lane requires operator inspection.

Reports contain the complete configuration and profile, generation time, observed platform/runtime, fixed limits, preflight available memory and health, and (for attempted runs) aggregate CPU seconds, peak memory, target wall duration, workload exit, and post-run available memory/health. Exit zero requires every required measurement and workload to succeed. Capacity-only reports explicitly mark workload metrics unavailable because no execution was granted. Fixture tests use injected command/metric adapters and a temporary fake cgroup filesystem; they do not contact live hosts or establish deployment readiness. A private live pilot remains required before promotion.
