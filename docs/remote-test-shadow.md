# Remote-test shadow reporting

A per-map `testBackend.kind: shadow` runs the existing local gate and compares it
with the reviewed SSH backend. It requires the SSH selector fields (`configFile`,
`stateRoot`, `profileId`, `lockFile`, `deadlineSeconds`) plus `reportRoot`, an
existing operator-owned directory with mode 0700 outside any Git repository.
Keep this configuration private. Omitting `testBackend` retains local execution;
`kind: ssh` retains the separately selected remote backend.

The local result controls push and merge. A passed remote result cannot upgrade a
failed local result; missing, invalid or failed remote evidence is reported.
Source mutation still refuses the current gate. Reporting/storage failure prints
a pending notice without replacing the local test result. The ordinary review,
CI and merge checks still apply.

Each exclusive 0600 comparison file records the local observation, validated
remote receipt and exact immutable identity tuple, outcome/coverage parity,
local and SSH round-trip duration, remote job duration when present, and measured
local test child CPU from POSIX `time` when available (otherwise pending). The
test environment is preserved. Local observations are comparison records,
not authenticated remote receipts. Local required-test skips remain pending unless
a measurement backend supplies them. SSH queue and transfer duration remain
pending because the current transport does not expose them. Round-trip duration
includes staging, transport, execution and retrieval; it is not queue time.

## Private ten-job pilot summary

`ranger remote-test shadow-summary --input <private-json> --output <new-private-json>`
reads measurements and saves a private summary without running jobs or activating
a remote gate. Input and output must be outside Git; output parent must be 0700.
Input is `{ "version": 1, "jobs": [...] }`. Each of at most ten entries has:

| Field | Meaning |
| --- | --- |
| `identity` | Complete V1 job identity; ten distinct job UUIDs |
| `source` | `measured` or `fixture` |
| `baselineLaptopCpuSeconds` | Eligible install + test CPU on the laptop for this source/profile |
| `activatedLaptopCpuSeconds` | Laptop CPU for the corresponding remotely activated install + test work |
| `reservedHostRamBytes` | Minimum available RAM reserved during this job interval |
| `unexpectedServiceRestarts`, `oomEvents` | Observed event deltas across this job interval |
| `queueMs`, `transferMs`, `jobMs` | Measured durations, or null when unavailable |

Every numeric observation accepts null for unavailable data. CPU must be measured
for the same eligible source/profile work with equivalent process accounting;
wall time is not a CPU estimate. The shadow test CPU observation excludes initial
install and is not an activated-run measurement: shadow still runs locally. An
operator separately supplies actual paired baseline/activated measurements after
the provisioning/pilot checkpoint permits activation. These measurements and
private endpoints never belong in repository artifacts.

Targets pass only with ten measured jobs: aggregate CPU reduction at least 80%,
minimum RAM reserve at least 1 GiB, and zero unexpected restarts/OOM. Missing
measurements, fewer jobs, fixture inputs and zero aggregate baseline CPU leave
applicable targets pending. Observed failed targets yield a failed summary and
exit 1. Pending summaries exit 0 with an explicit pending label. No pilot target
is claimed achieved by fixture tests.
