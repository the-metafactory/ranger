# Findings: node #362, why a reviewed `myelin-integration-v1` job ended `infra_failed` after every check passed

Checkpoint: `cp-clawbox-post-check-infra-failed`
Base: `a86448d` (this branch). Code references are to `src/remote-test/executor.ts` at that base.

## Answer (short)

1. The public receipt fields alone narrow the failing check further than the node's evidence did. The receipt reported `exitCode: null` and `coverage.requiredSkippedTests: null`. A failure in **sidecar inspect or sidecar metrics** leaves `exitCode: 0` and `coverage: 0` in the receipt. A failure in the **test container's terminal-result block** (lines 343–349) leaves both at null. The sidecar is **excluded**. The fault-injection probe below confirms this.
2. The failing check is one of four steps, all in lines 343–349, and all running after `podman start --attach` returned:
   - **F1** the post-exit `podman inspect <test>` failed: non-zero exit, the 30 s per-command cap, or bad JSON (line 343).
   - **F2** `state.Status !== "exited"` (line 349). Candidate under load, see below.
   - **F3** `result.code !== state.ExitCode`: the exit code of `podman start --attach` disagreed with the inspected exit code (line 349).
   - **F4** the wrapper's terminal JSON on attach stdout was empty, truncated or failed the schema (line 347).
   - **F5** (lower prior) the 100 ms ledger fence (`ledger.allowed` throwing, for example SQLite busy past `busy_timeout=5000`) called `interrupt("infra_failed")` after the container exited. The next `command()` then throws `Interrupted`. It produces the same receipt signature.
3. The public repository cannot tell F1–F5 apart: the catch at line 373 drops the error. Only a bounded private stage record can name the failing check. **A code change is warranted, and it is diagnostic only** (see Recommendation). No retry, no widened resources, no change to the outcome mapping.
4. Until that diagnostic exists and a recurrence is classified, this failure stays **bounded but unexplained**. It must keep counting against the promotion checkpoint's reliability criterion.

## Evidence

### E1: How the receipt fields depend on where the throw happens (read)

- The terminal block assigns `status = terminal.status; exitCode = terminal.exitCode;` (line 350) and `coverage = terminal.coverage` (line 354) only **after** parse (347), the consistency check (348) and exit-code/state agreement (349) succeed.
- The sidecar checks (358–371) run **after** those assignments.
- The catch (373–376) rewrites only `status` (and `resources`). It never resets `exitCode` or `coverage`.
- `exitCode` starts as `null` (line 212) and `coverage` as `{ requiredSkippedTests: null }` (line 214).
- The OOM branch (344) would set `exitCode` from the inspected state (0) and then go on to the sidecar `exec`. That `exec` is missing from the event log, so the OOM branch is ruled out. The timeout branch (345) yields `timed_out`, also ruled out.

### E2: Fault-injection probe (run this session, scratch file deleted, not committed)

I reused the fixture from `test/remote-test-executor.test.ts` (lines 1–59): a reviewed profile with a NATS sidecar and a fake launcher. I injected one fault per stage. Output from `bun test` (10 pass):

| Injected fault | status | exitCode | coverage | sidecar exec reached |
| --- | --- | --- | --- | --- |
| none (control) | passed | 0 | 0 | yes |
| empty attach stdout (F4) | infra_failed | **null** | **null** | no |
| truncated terminal JSON (F4) | infra_failed | **null** | **null** | no |
| attach exit 125, valid JSON (F3) | infra_failed | **null** | **null** | no |
| attach exit 125, no stdout (F3/F4) | infra_failed | **null** | **null** | no |
| post-exit test inspect fails (F1) | infra_failed | **null** | **null** | no |
| test state `stopping` instead of `exited` (F2) | infra_failed | **null** | **null** | no |
| sidecar inspect fails | infra_failed | 0 | 0 | no |
| sidecar reports exited | infra_failed | 0 | 0 | no |
| sidecar exec fails | infra_failed | 0 | 0 | (faulted) |

The observed receipt (`infra_failed`, null, null, no `exec`, both containers removed) matches only the rows in the F1–F4 group. Both containers were removed (`rm` order: test, then sidecar) in every row. That matches the event log's "sidecar removal with no `exec`".

### E3: Why F2 and F3 are load-dependent candidates and not a stdout-loss bug in Bun

- Podman's own state model separates **`stopped`** ("the container was running but has exited") from **`exited`** ("the container has stopped and been cleaned up"). Source: `libpod/define/containerstate.go` on podman `main`, fetched this session. Cleanup runs out of band: conmon's exit command calls `podman container cleanup`. If `start --attach` returns, and the immediate `inspect` (line 343) runs before cleanup finishes, `State.Status` is `stopped` and line 349 throws "Incomplete terminal result". A slower host widens that window. This also fits "three later identical jobs passed". **Not verified on the Clawbox's podman version.** Whether `start --attach` can return before cleanup there is a hypothesis.
- F3 (the attach client's exit code disagreeing with inspect) and F4 (attach dropping the tail of stdout) are also races inside the engine/conmon attach path. The earlier host-level probe tested Bun's `console.log` followed by `process.exit` *without* podman attach in between (50/50). It therefore says nothing about F3/F4 in the attach path.
- Private evidence that can separate them now, if retained: the podman event stream for that job. A `died` event with no `cleanup` event before the sidecar `remove` points to F2. The executor log's last bytes contain the wrapper's JSON only if stdout survived, but stdout goes to the launcher, not the log, so the log cannot confirm F4. The retained `test.log` does show that all four checks completed, which the node already states.

## Recommendation

**D1: Code change warranted, diagnostic only.** Add a default-off, bounded, private executor stage record, modelled on `src/remote-test/receiver-diagnostics.ts` (append-only stage/code enums, 1 KiB records, age-bounded retention, operator-local path). It records which check in lines 343–371 threw. Suggested append-only codes:

- `post_exit_inspect` (F1)
- `terminal_parse` (F4)
- `terminal_inconsistent` (line 348)
- `state_not_exited` with the bounded enum of the observed `State.Status` (F2)
- `exit_disagreement` with three small integers: attach code, inspect code, terminal code (F3)
- `coverage_incomplete`
- `sidecar_inspect`
- `sidecar_metrics`
- `fence_error` (F5; also record when `interrupt("infra_failed")` fired from the fence)

It must not change public receipt fields, outcome mapping or recovery authority.

**D2: No behavioral fix yet.** An obvious candidate exists for F2: poll `inspect` briefly until `exited`, within the existing deadline. Ship it only after a D1 record names F2. Shipping it now would fix a guessed cause and hide the others. It also borders on the out-of-scope "retry".

**D3: Reliability accounting.** Count this job as an unexplained `infra_failed` against the promotion reliability criterion. It becomes bounded once D1 is deployed and either (a) a recurrence is classified, or (b) a load reproduction runs N reviewed jobs under induced host CPU contention with D1 on and classifies any failure.

## Reproduction under load (operator-local, not run here)

Load reproduction needs the Clawbox and its private config, so I did not run it from this research session. Procedure once D1 is in: run the reviewed profile repeatedly while a bounded CPU hog runs outside the lane's cgroup. Separately, tally `podman events --filter event=cleanup` timestamps against `start --attach` return times from the D1 record. Keep the results in operator-local evidence only.

## Not established

- Which of F1–F5 actually happened. Only private evidence or D1 can answer that.
- Whether `podman start --attach` on the Clawbox's podman version can return before the container reaches `exited`.
