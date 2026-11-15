# Findings: who spends the shared GitHub budget (node #536)

Measured 2026-11-15 between 08:50 and 09:15 UTC from three sources:

- ranger's own GitHub usage record (`~/.config/ranger/github-usage/*.jsonl`, #493/#497). It holds every call ranger makes with the rate-limit headers GitHub returned, every soma or sage subprocess run, and a free `/rate_limit` gauge each tick.
- the live journal (`~/.config/ranger/state.sqlite`, read only).
- a live five-minute process sample of every `gh` process on the Mini, with its parent chain (script described under "Method").

## Answer in one paragraph

Two GitHub accounts are involved, and only one runs out. The machine account (ivy-agent, ranger's `write-token`) spends about 1,300 of its 5,000 calls an hour and never ran out overnight. The principal's account (user 3088) is shared by ranger's two read-only PATs, Sage's reviews in the ranger lane, every keyring `gh` and the cortex default stack. It ran dry in every window from 02:36 to 09:36 UTC, each time 13 to 22 minutes after the reset. Ranger accounts for only 2–7 % of what that account spends before it hits zero. The largest spender is the cortex default stack's mission-control desk. It reads issue bodies one at a time with keyring `gh`, measured at 1,510 processes in five minutes, about 300 a minute. It re-reads the same issues within two minutes although its cache is meant to keep them for 30. Sage stalls because it shares that account, and the lane then fills with new claims because a rate-limited queued resume does not hold its lane.

## Findings

### F1. Two budgets; only the principal's runs out

| Account | Token sources in ranger's record | Peak use overnight | Exhausted |
| --- | --- | --- | --- |
| ivy-agent (machine) | `write-token` | 1,304 / 5,000 (window resetting 04:50:46) | never |
| principal (user 3088) | `RANGER_READONLY_GH_TOKEN_METAFACTORY`, `RANGER_READONLY_GH_TOKEN_PERSONAL`, keyring `gh` | 5,000 / 5,000 | 02:31, 02:58, 03:50, 04:56, 05:49, 06:50, 07:53, 08:49 |

Proof that the read-only PATs and the keyring share one budget: `gh api rate_limit` in this worker (keyring, user 3088) reported core `remaining 0, reset 1794735419` (09:36:59Z). That is the same reset the record shows for both read-only PATs (09:36:58–59Z). All refusals in the record are on the two read-only sources. None is on `write-token`.

Window reconstruction from the record's own readings (`windows.ts`, under "Method"). "Ranger" is the recorded calls in the window plus each soma or sage run at its measured median cost (F4):

| Window resets (UTC) | Budget hit 0 at | Ranger, estimated | Everything else |
| --- | --- | --- | --- |
| 02:36:30 | 02:31:14 | ≈ 658 (13 %) | ≈ 4,342 |
| 03:36:50 | 02:58:51 | ≈ 333 (7 %) | ≈ 4,667 |
| 04:36:55 | 03:50:39 | ≈ 191 (4 %) | ≈ 4,809 |
| 05:36:55 | 04:56:02 | ≈ 201 (4 %) | ≈ 4,799 |
| 06:36:55 | 05:49:33 | ≈ 272 (5 %) | ≈ 4,728 |
| 07:36:55 | 06:50:53 | ≈ 90 (2 %) | ≈ 4,910 |
| 08:36:55 | 07:53:47 | ≈ 303 (6 %) | ≈ 4,697 |
| 09:37:00 | 08:49:19 | ≈ 242 (5 %) | ≈ 4,758 |

The evening before (18:32–00:34 windows) the account never ran dry. Ranger then spent 820–1,210 an hour, and the rest 430–3,180.

### F2. Calls per hour by caller, from one real hour

**Principal account, window 05:36:55–06:36:55.** The budget was gone at 05:49:33, 12.6 minutes in.

| Caller | Calls until exhaustion | Basis |
| --- | --- | --- |
| ranger `token-gate` (`GET user`, `GET repos/:repo` per process) | 82 | recorded |
| ranger walk sentinel (`frontier-sentinel`) | 70 | recorded |
| ranger `serve` dashboard reads | 38 | recorded |
| ranger walk graph reads (`soma graph node/frontier/audit`, 20 runs) | ≈ 44 | runs × measured median |
| Sage review in the ranger lane (1 run) | ≈ 38 | runs × measured median |
| merge desk, card sync, workers | 0 on this account | merge desk, card sync and `forge-port` run under `write-token` |
| **everything outside ranger** | **≈ 4,728** | gauge drop minus the rows above |

After exhaustion ranger's `token-gate` kept asking: 188 further `GET user` calls were refused with 403 in that hour (F7).

**Machine account, window 06:00:33–07:00:33.** Used 1,293 / 5,000.

| Caller | Calls | Basis |
| --- | --- | --- |
| walk sentinel (`GET issues` + `GET issues/events`, per map per tick) | 660 | recorded |
| `write-identity` (`GET user`) | 175 | recorded |
| merge desk / card sync / PR reads (`forge-port`) | 110 | recorded |
| walk node reads (`soma graph node`, 173 runs) | ≈ 350 | runs × median 2 |
| frontier and audit reads (39 + 34 runs) | ≈ 140 | runs × medians 1 and 3 |
| other on this token | 94 | report's `outsideRanger` |

**Live process sample, 09:03:41–09:08:41 UTC.** Every `gh` process on the host, grouped by its parent chain (`ghsample.ts`). This covers both accounts. Each `gh api` without `--paginate` is one request.

| Parent | `gh` processes in 5 min |
| --- | --- |
| cortex default stack (`cortex start --config ~/.config/cortex/default/default.yaml`, launchd) | **1,510** |
| ranger tick and run-node `soma graph …` (frontier 153, node 110, audit 31, decisions 26, close 19) | ≈ 339 |
| ranger other (`forge-port`, sweep) | 255 |
| interactive Claude sessions | 2 |

Codex worker sessions tonight issued 6–42 `gh` commands per session (count over `~/.codex/sessions/2026/11/15`). They are not the bulk.

### F3. The dominant spender is the cortex mission-control desk, through the keyring

- Cortex's launchd job sets no `GH_TOKEN` (`ai.meta-factory.cortex.default.plist`: `CORTEX_CHANNEL`, `CORTEX_SURFACE_SECRETS`, `HOME`, `PATH`). Its `gh` therefore runs as the principal.
- All 406 cortex `gh` calls in a 120-second sample were `GET /repos/:r/issues/:n`. They covered 260 distinct issues across 14 repos (seelite 127, soma 36, cortex 36, ranger 27, …), and **103 of them were read 2 or 3 times within the two minutes**.
- The reader is `WaitingTasks` in `src/surface/mc/desk/sources/waiting.ts` of the installed cortex (`~/.local/share/metafactory/arc/repos/cortex`, `c861c1f4`). It keeps a successful read for 30 minutes (`FRESH_MS`) and a failed read for 5 (`RETRY_MS`). Neither explains re-reads within 2 minutes.
- Its only per-ref eviction is in `read(refs)`: every cached ref missing from the current call is deleted. The ref list is rebuilt on each desk compose (`compose.ts:235-240`) from Vigil subjects plus the ranger state fetched over HTTP from `ranger serve` (`readRangerState`). When that read fails or returns a smaller set, the cache empties and the next compose re-reads every waiting node.
- **Inferred, not proven:** the re-reads come from that eviction, probably because the ranger read flaps on a loaded host (load 21–33 on 18 cores overnight, per the journal). The measured rate alone would empty the principal's budget in about 17 minutes, which matches the 13–22 minutes observed.
- Caveat: the sample was taken while the principal's budget was at zero, so many of these calls were refused, and failures may raise the read rate. The overnight windows exhausted just as fast, and the eviction path reads every ref again whether or not reads fail.

### F4. Cost of one run

Spend measured between the record's gauge readings around runs that overlapped no other soma or sage run, 2026-11-13 to 11-15. These are upper bounds, because other callers on the account spend in the same interval.

| Run | Account | Isolated runs | Median calls | Median duration |
| --- | --- | --- | --- | --- |
| `sage-review` | principal | 102 | 38 (p25 18) | 31 s |
| `soma graph node` | principal / machine | 1,438 / 3,002 | 3 / 2 | 1.4 s |
| `soma graph frontier` | principal / machine | 1,579 / 967 | 1 / 1 | 1.6–2.2 s |
| `soma graph audit` | principal / machine | 68 / 1,591 | 3 / 3 | 3.6–4.1 s |
| `soma graph close` / `decisions` | machine | 7 / 6 | 15 / 15 | 9 s |

Sage spends 1–6 reviews an hour, so roughly 40–230 calls an hour. Sage is the victim of the shared budget, not its cause.

### F5. Question 2: does the walk re-read unchanged nodes?

- The frontier is already change-gated. `src/frontier-cache.ts` reads a two-call sentinel per map per tick and reuses the cached frontier while the sentinel is unchanged. That sentinel is now the largest single item on the machine account (660 calls an hour, about half its use). Almost every reading finds the map unchanged, which is the case where a conditional request answers 304 and, per GitHub's documentation, does not count against the primary limit. An ETag on the two sentinel calls would therefore remove most of those 660. This is untested here: `gh api`'s handling of a 304 must be checked first.
- The closure sweep's `soma graph node` reads (`src/sweep.ts:151`) run about 130–170 times an hour on the machine account, with no change gate. The record does not keep node ids, so it cannot show how many of them hit an unchanged node.
- On the principal's account the walk's reads come to about 110–150 an hour (sentinel 70, graph runs ≈ 44), plus `token-gate` checks (82). A per-tick cache would save at most about 200 calls an hour there, against the ≈ 4,700 spent elsewhere. **The walk is not what exhausts the shared budget**, so question 2 does not fix the incident.

### F6. Question 4: a rate-limited queued resume releases its lane

`src/resume.ts:233-237` handles the review throttle like this: when `reviewThrottle()` is active, the queued resume logs "waits until …" and hits `continue`. The other deferrals in that loop call `defer()`, which, per its own comment, "holds its lane". The throttle branch does not, and neither does the recovery-hold branch just above it (`:228-231`). The walk then sees a free lane. `src/walk.ts` does not consult `reviewThrottle` before it claims.

The journal shows the effect on seelite four times:

| Sage throttled, resume queued | New claim on the same visual lane |
| --- | --- |
| #1232 at 02:31:05 | #1195 at 02:32:50 |
| #1195 at 05:07:04 | #1228 at 05:09:59 |
| #1228 at 07:15:55 | #1236 at 07:17:34 |
| #1236 at 07:55:53 | #1265 at 07:58:08 |

After each reset the queued resumes then logged "deferred: implement lane is occupied" for hours. #1232 deferred 13 times between 02:59 and 04:56. Each new claim ran into the next exhaustion at its own Sage round.

### F7. Smaller items seen on the way

- Ranger's `token-gate` sends `GET user` + `GET repos/:repo` once per process for each read-only token, about 80–270 calls an hour on the principal's account. It keeps doing so while the account is at zero (188 refusals in one hour). GitHub warns that requests sent while limited can extend the limit. `write-identity` spends another 175 `GET user` an hour on the machine account.
- `ranger budget` splits one budget window into two rows whose reset times differ by one second (for example 08:36:57 and 08:36:58). The duplicate row carries `recordedCalls: 0` and a different `used`. It is a display artifact, but it makes the report harder to read.
- `ranger budget` from inside a worker reports "no GitHub use" because the supervisor points `RANGER_JOURNAL_PATH` at a temporary session journal. Run it with `RANGER_JOURNAL_PATH=~/.config/ranger/state.sqlite`.

## Recommendation

| Question | Build? | Why |
| --- | --- | --- |
| 2: ETag or per-tick cache for walk reads | **Not now** | The walk spends 2–7 % of the exhausted account. ETag on the machine-account sentinel is a cheap later saving (≈ 660 calls an hour) and fixes nothing tonight. |
| 3: Sage under its own identity | **Yes** | Sage is the step that stalls the lane. A GitHub App installation token has its own rate limit, and ranger already mints installation tokens (`createInstallationToken` in `src/github.ts`, used by `checkReporter`). Ruling #8 already allows reads under any identity with an explicit read-only credential. |
| 4: hold the lane for a rate-limited queued resume | **Yes, first** | A small change at a known site (`src/resume.ts:228-237`) that stops the half-done pile-up whatever spends the budget. |
| New: the cortex desk's keyring reads | **Yes, highest effect** | It is about 72 % of all `gh` processes on the host and the only caller large enough to empty the account by itself. |

### Proposed build nodes (for the supervisor to file)

**B1. A rate-limited queued resume keeps its lane, and the walk claims no new work behind it.** Repo: the-metafactory/ranger.
In `src/resume.ts`, the review-throttle branch (`:233-237`) and the recovery-hold branch (`:228-231`) defer through `defer()` and so hold the lane until the throttle's `until`. No new frontier claim takes the lane while a queued resume holds it.
Checkpoint: a test where a resume is queued under an active `reviewThrottle` and a walkable visual node exists. One tick claims nothing on that lane and logs the queued resume as holding it. After `until` passes, the resume starts before any claim.

**B2. The cortex desk reads waiting nodes without thrashing the principal's budget.** Repo: the-metafactory/cortex (cross-repo; file as a cortex issue, or as a node here that links it).
1. Confirm the eviction cause with a test: `WaitingTasks.read()` called with alternating ref sets must not re-read a ref read less than 30 minutes ago.
2. Stop deleting cached refs that are missing from one compose. Expire by age only, or evict only after a ref has been absent for its whole freshness window.
3. When the ranger state read fails, reuse the last good ref set instead of shrinking it.
4. Give the desk an explicit read-only token and a budget floor instead of the keyring, for the reasons behind ruling #8.

Checkpoint: in a ten-minute live sample, cortex `gh` issue reads fall from about 300 a minute to fewer than the count of waiting nodes per 30 minutes.

**B3. Sage reviews in the ranger lane run on a read-only GitHub App installation token.** Repo: the-metafactory/ranger, propose.
- Mint an installation token scoped down to `contents:read`, `pull_requests:read` and `issues:read`, using the existing App machinery, and pass it to `sage-review` in place of the read-only PAT.
- Record it in the usage record under its own source label.
- Keep the PAT path as a fallback only when no App is configured, never the keyring.

Provisioning, which is the principal's step: an App installed on `jcfischer` and `the-metafactory` with those read permissions (the checks App may be reused if its permissions allow).
Checkpoint: a review runs while the principal's core budget is at 0 and records a non-zero `remaining` on the App source.

**B4 (later, optional). Conditional requests for the walk sentinel, and a cooldown-aware token gate.** Repo: the-metafactory/ranger.
- Send `If-None-Match` on the two sentinel calls and treat 304 as "unchanged".
- Have `token-gate` and `write-identity` validate once per tick and make no call while the scope's cooldown is active.

Do this only once the cortex fix (B2) lands and the machine account matters.

## Method

Scripts were run from `/tmp/n536-scripts/`. None were committed, because the research SOP allows only `findings.md` on this branch.

- `ranger budget --since 2026-11-15T00:00:00Z --until 2026-11-15T08:50:00Z --json` with `RANGER_JOURNAL_PATH` pointed at the live journal.
- `windows.ts`: groups the read-only sources' rate-limit readings by reset time, finds the first `remaining: 0`, and counts recorded calls and soma/sage runs in the span before it.
- `runs.ts`: for each soma or sage run that overlapped no other run, the drop in `remaining` between the readings just before and just after it, within one window.
- `ghsample.ts`: `ps` every 150 ms for 300 s, each new `gh` PID classified by its parent chain.
- `cortexpaths.ts`: the same for children of the cortex PID for 120 s, with the request paths.
- Journal: `events` for `jcfischer/seelite` between 00:00 and 08:50 UTC, and `workers` rows.

**Limits.**
- Calls made inside soma and sage are estimated from gauge drops, not counted.
- The live samples ran while the principal's account was at zero. Cortex's rate may differ when its reads succeed.
- The cortex eviction cause is inferred from the code and the re-read pattern, and B2's first step tests it.
- I did not separately measure the in-process cortex Sage engine (bus reviews) or other `fetch`-based callers. Neither shows up as `gh` processes.
