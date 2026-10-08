# Accepted private shadow pilot

The [private Clawbox pilot decision](https://github.com/the-metafactory/ranger/issues/145)
accepts qualified private evidence and defers authoritative remote promotion.
The [sanitized pilot evidence and hash-only manifest](https://github.com/the-metafactory/ranger/issues/145#issuecomment-6048714132)
link the accepted evidence without exposing deployment bindings or measurements.
Receipt attestation is `unverified`; it does not establish independent credential
separation. Local tests retain gate authority.

The accepted source was a private committed revision with a retained dependency
lock and bounded reservations in three integration fixtures. That acceptance
does not establish canonical-source readiness. Before any separate promotion
checkpoint, resolve [canonical lock/fixture adoption and the eligible map/profile](https://github.com/the-metafactory/ranger/issues/189)
and [bounded private diagnostics for the unexplained pre-admission receiver refusal](https://github.com/the-metafactory/ranger/issues/190).
No cause is inferred for that refusal and no promotion follows from this runbook.

## Private preparation

Keep the substituted Ranger YAML, SSH/executor configuration, approved profile
manifests, source bindings, exact jobs, receipts and measurements in operator-owned
locations outside **all** Git repositories. Pre-create state, staging, executor
jobs and report directories with mode 0700; reports and saved jobs use mode 0600.
Configuration must be operator-owned without group/world write access. Provisioned
endpoints, identities, keys, host paths and measurements belong only there.
Review existing private storage capacity/retention and clock synchronization;
never remove uncertain evidence or the execution ledger to gain admission.

Use only the exact operator-approved repository, profile ID and canonical
profile digest, committed lock filename and SHA-256, runtime image digest and
Linux ARM64 platform. Bind the clean committed HEAD, tree and staged bundle
SHA-256; unpushed committed source is supported. Both SSH and executor allow-lists
must contain the same authenticated approved profile and expected producer.
Changed source/lock/image/commands require the corresponding review; do not
rewrite them or their digests merely to pass admission.

The accepted envelope remains one non-graphical job, two CPU cores, 1.5 GiB
aggregate memory including any disposable sidecar, zero swap and 256 PIDs.
Execution is bounded by ten minutes or the request deadline, whichever is earlier.
Preserve at least 1 GiB host RAM reserve and existing services/workers' capacity.
An occupied lane, insufficient capacity or uncertain cleanup must yield/refuse;
never force a second job, raise caps or interrupt resident services to fit it.
Graphical probes, screenshots, WebGL/audio and other-platform checks keep their
existing local paths.

Implementation contracts remain in [bounded execution and fenced recovery](remote-test-executor.md),
[reviewed profiles and sidecar budgets](remote-test-profiles.md),
[SSH submission and exact receipt lookup](remote-test-ssh.md),
[supervisor backend selection](remote-test-supervisor.md),
[shadow comparisons and pilot summary](remote-test-shadow.md) and
[capacity baselines](remote-test-baseline.md).

## Prepare the shadow selector

Copy the [inert template](examples/remote-test-private-shadow.yaml) into a private
draft and replace every `REPLACE_*` value. Absolute configuration/state/report
paths are required; the profile ID and committed lock filename must match the
approved manifest. Choose the approved request deadline (the selector accepts
1–900 seconds; this does not extend the executor's ten-minute workload bound).
The unchanged template deliberately fails the configuration loader.

The skeleton has `walk: none` and `autoMerge: false` and defines no test command.
It is for offline configuration review, not a complete runnable map. At an
explicitly authorized private adoption, use only its `testBackend` block in the
existing map configuration, retaining the existing commands, walk policy, review,
CI, merge and deployment authority. The approved profile must cover that map's
declared `commands.test`; Ranger does not translate arbitrary shell text into
remote commands. This document does not edit or activate a live map.

Keep `testBackend.kind: shadow`. The existing backend runs the local gate and
compares the reviewed SSH result privately. A remote pass plus local failure
leaves the local gate failed. Missing/invalid remote evidence or a report-storage
failure cannot upgrade a local result. Source mutation still refuses the gate.
Selecting `kind: ssh` would change gate authority and requires a separate
promotion decision; it is never part of adopting this template.

## Built CLI submission, lookup and summary

Use the existing reviewed built `ranger` executable. All angle-bracket arguments
below are private replacement values, not executable host-bootstrap instructions.
These manual commands neither activate a map nor replace its supervisor gate.
Prepare the V1 request privately as specified in the SSH contract: source
commit/tree/bundle digests are derived during staging, not supplied in the request.
Use a fresh job UUID and the operator-admitted correlation/generation and deadline.

```text
ranger remote-test run --config <private-ssh-json> \
  --request <private-request-json> --worktree <clean-committed-source> \
  --staging-root <existing-private-staging-directory> \
  --job-output <new-private-exact-job-json> --output <new-private-receipt-json>

ranger remote-test status --config <private-ssh-json> \
  --job <saved-exact-job-json> --output <new-private-receipt-json>

ranger remote-test shadow-summary --input <private-measurements-json> \
  --output <new-private-summary-json>
```

Submission saves the exact job before its one SSH attempt. Supervisor shadow
attempts likewise retain `job.json` under the private state directory for lookup.
Use a new output filename for each export. `status` only retrieves evidence for
that saved identity; it never restages, launches or resubmits.

The summary consumes the documented private V1 measurements, without launching
jobs. Ten measured jobs must meet at least 80% paired eligible laptop CPU reduction,
at least 1 GiB RAM reserve and zero unexpected service restarts/OOM. Those are
acceptance thresholds, not published deployment measurements. Missing data or
fixture inputs leave targets pending. `pending` summary exits zero with a pending
label; only explicit `passed` is a passed summary. An observed failed target exits
nonzero. A passed summary still grants no gate, merge or deployment authority.

Shadow comparison CPU measures local test children and excludes initial install;
shadow still runs local tests. It is not paired activated-run CPU. Supply actual
equivalent install-and-test baseline/activated CPU accounting only under the
corresponding operator authorization. Wall time is not CPU. Missing peak-memory
telemetry is unavailable/null, never zero; absent optional peak telemetry never
waives mandatory enforcement, OOM, health, reserve or cleanup checks.

## Refusal and uncertain execution

Missing/uncommitted or mismatched lock bytes, dirty source and unapproved profiles
refuse the remote leg before submission. In shadow mode the local result still
controls the gate; source mutation invalidates it independently. Do not add a
lock, alter fixtures, clean away changes or update approval digests solely to
gain admission. Resolve canonical requirements at their own checkpoint.

Absent/interrupted receipts and nonzero SSH exits are pending before the deadline
and `infra_failed` after it. A nonzero exit does not prove admission or refusal.
Typed `receiver_failed`/`invalid_receipt`, stale/wrong-identity receipts, revoked
success and incomplete required coverage cannot establish accepted success.
Retain the original saved job and private evidence; query `status` first and
inspect the operator-owned ledger/active attempt if no terminal receipt is
available. An incomplete attempt directory without a saved job needs private
inspection, not guessed resubmission. Killing local SSH does not prove remote
cancellation. Never automatically retry an uncertain run.

For an explicitly chosen cancellation, run this on the executor host with its
private executor configuration and the original exact job:

```text
ranger remote-test cancel --config <private-executor-json> --job <saved-exact-job-json>
```

This durably fences the original generation, including an unadmitted identity;
verify the fence privately and confirm owned workloads have stopped/cleaned up.
If recovery is needed, first stop the former executor and verify process absence,
then explicitly run on that host:

```text
ranger remote-test recover --config <private-executor-json> --executor-stopped
```

The flag asserts an operator precondition; it does not stop a service. Failed
recovery leaves admission fenced. Do not delete a retained lane/ledger or adopt
loose artifacts as success. Recovery permits at most one infrastructure retry
of an interrupted immutable job; it never schedules that retry automatically.
Only after exact lookup, durable fencing and confirmed cleanup may the operator
authorize a new generation with a new job UUID and the same correlation ID for
the same request. Preserve the uncertain original's evidence and accounting.
These are explicit operator procedures, not new admission or retry mechanisms.
