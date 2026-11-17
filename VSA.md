---
task: "Ranger moves confirmed criteria from failing to passing, and every result it reports names the checks and the commit behind it"
slug: ranger-product-vsa
effort: E3
phase: observe
started: 2026-11-16T00:00:00.000Z
updated: 2026-11-16T00:00:00.000Z
---

## Problem

Ranger is very productive and is aimed at nothing it can check. Evidence read on 2026-11-16 (read-only, from the repo at 8185b76 and public GitHub data):

- No node, brief or claim refers to a criterion: `grep -rn "VSA\|ISC-" src` finds nothing, and the repo has no `VSA.md`. Ranger can claim and merge many nodes in a week without any of them moving a stated criterion.
- A close is journaled `attestation: unverified` when other credentials are reachable from the session and nothing ratified the close. Nothing drives that share down.
- A job's `succeeded` means its process exited cleanly, not that its goal moved. A job can succeed in seconds and produce nothing.
- A job result is one reference string. It names no check and no commit (`src/jobs.ts:34-38`, `result` and `reason` columns in `job_runs`).
- Jobs run from whatever their `cwd` holds. `src/jobs.ts` has no dirty-tree or pushed-HEAD check, so a scheduled job can run uncommitted, unreviewed code for weeks.
- Escalations have no expiry; one can stay `open` indefinitely.
- The weekly retro counts failures but not progress, and nothing tracks whether its proposals are filed.
- Ranger's own tracker has 38 open issues and 30 PRs merged since 2026-11-09 (`gh issue list`, `gh pr list -R the-metafactory/ranger`).

## Vision

- **Level 1 — Life outcome.** An operator sees their goals move each week because ranger worked on them, and touches ranger only at gates they chose: approving a decision, or a merge they asked to see. They never learn about a stopped job from its silence.
- **Level 2 — System behavior.** Ranger works only on failing criteria of a product VSA its maintainers confirmed. Each claim, job and close reports which criterion it serves, which checks passed, and the commit it ran. Ranger runs scheduled jobs only from committed, pushed code, and a job counts as succeeded only when its declared success check passes. Its weekly report counts criteria flipped, not PRs merged.
- **Level 3 — Mechanism.** A claim gate reads the repo's `VSA.md` and refuses a node that cites no failing ISC, and journals why. The worker brief carries the full ISC text. A close requires the cited ISC to be checked on the base. Jobs pass a clean-tree and pushed-HEAD preflight, run a declared success probe, and write a receipt row with checks and SHA. The retro and digest read flipped ISCs from git history.

Euphoric surprise: the Monday retro says "9 criteria flipped across four products, 0 jobs failed silently, 12 escalations open", and the PR count is not in the headline.

## Out of Scope

- Replacing the orienteer map, `soma graph` verbs or the walk. This VSA changes what ranger accepts as work, not how it walks.
- Sage's review logic, including the check that a PR flips its ISC. That lives in Sage.
- The scheduler itself. Triggers come from Reflex and cortex.
- Vigil's alert routing. Ranger emits the event; Vigil decides how it reaches the operator.
- Writing the product VSAs of other repos. Ranger reads them.
- An operator's own jobs and goals. They live in that operator's config, not in this repo.
- Remote test execution (`docs/remote-test-*.md`) and GitLab lanes, unless a criterion here needs them.

## Principles

- Throughput is not progress. Only a criterion flipping from failing to passing counts.
- The builder never grades its own work. A worker does not check its own ISC box; the merged PR and its review do.
- A refusal is a result. Every refusal is journaled with the reason, so a silent skip cannot exist.
- What ran is what was reviewed. Unattended code is committed and pushed before it runs.
- Misses become checks, not prompt lines (AGENTS.md "Prefer a check over a line here").

## Constraints

- TypeScript and Bun 1.3+, SQLite journal through drizzle (`drizzle/`), macOS launchd.
- Sage reviews every ranger PR, and the merge gate keeps `ci-green` and `review-clean` (`src/merge-gate.ts:15-21`).
- Deploys, merges on maps without `autoMerge`, `propose` and `approve` nodes, money and outbound messages keep needing the operator's yes. Nothing here loosens a gate.
- Autonomous work runs under the machine account; a tick refuses to write the graph as the principal (README, "Rules ranger keeps").
- Live ranger runs the arc install, never a working checkout (README, "Run ranger on a schedule").
- ISC IDs in product VSAs are stable; ranger matches them by ID, never by text.
- The repo is public and shared; this file names no person and no private goal.
- Each change lands as its own PR in this repo.

## Goal

Ranger claims only nodes that cite a failing ISC from their repo's confirmed `VSA.md`, briefs workers with that ISC's text, and closes a node only when the ISC is checked on the base. Every job runs from a clean, pushed commit and leaves a receipt with its checks and SHA. The weekly retro reports criteria flipped per product.

## Checkpoints

### Gate
- [x] ISC-1: The maintainers confirm Levels 1 and 2 of this Vision, recorded with a date in Decisions.

### Claims aim at criteria
- [ ] ISC-2: In a repo with a `VSA.md`, ranger refuses to claim an implement node (`task` or `build`) created on or after `VSA.md` was added to the base branch whose body cites no ISC ID from that file, and journals a `refused` event naming the node and the missing citation. A body line `ISC: none (<reason>)` with a non-empty reason exempts the node, and the waiver is journaled with its reason. Other kinds and older nodes are exempt; a repo without `VSA.md` allows every claim.
- [ ] ISC-3: Ranger refuses to claim a node whose cited ISC is already `[x]` in the base branch's `VSA.md`, and journals the refusal.
- [ ] ISC-4: The worker brief for a claimed node contains the full text of each ISC the node cites, copied from the base branch's `VSA.md`.
- [ ] ISC-5: Ranger closes a node only when each ISC it cites is `[x]` in `VSA.md` on the base after the merge; otherwise it parks the node with that reason.

### Jobs run from known code
- [ ] ISC-6: Ranger refuses to start a job whose `cwd` repo has uncommitted tracked changes, and journals a refusal naming the dirty paths.
- [ ] ISC-7: Ranger refuses to start a job whose HEAD is not contained in a remote branch, and journals the refusal.
- [ ] ISC-8: Every `job_runs` row started in the last 7 days records the commit SHA its job ran.
- [ ] ISC-9: Every finished job run in the last 7 days records a receipt listing the checks it passed by name.
- [ ] ISC-10: A job may declare a success probe in its config; its run is `succeeded` only when the probe passes.
- [ ] ISC-11: A job that declares a goal (`serves: <goal id>`) and fails twice in a row emits one `goal-job-failing` event within one tick of the second failure.

### Closes and escalations
- [ ] ISC-12: No node close journaled in the last 7 days carries `attestation: unverified`.
- [ ] ISC-13: No escalation stays `open` longer than 14 days; it is answered, withdrawn, or its node is dropped.
- [ ] ISC-14: Every merge ranger closes on a map with `commands.deploy` is followed by exactly one `deployed` or `deploy-failed` event for that PR.

### Reporting counts progress
- [ ] ISC-15: The weekly retro report has a section listing each ISC that flipped to `[x]` that week, per product, with the PR that flipped it.
- [ ] ISC-16: The daily digest's first line states ISCs flipped in the last 24 hours before any count of PRs or nodes.
- [ ] ISC-17: Each retro proposal is filed as an issue or declined in Decisions within 7 days of the retro that made it.

### Anti-criteria
- [x] ISC-18: Anti: `autoMerge` defaults to `false` in the config schema.
- [x] ISC-19: Anti: The merge gate never passes without both the `ci-green` and `review-clean` checks.
- [ ] ISC-20: Anti: No commit by the machine account changes a `[ ]` to `[x]` in any `VSA.md` outside a PR that Sage reviewed.
- [ ] ISC-21: Anti: Ranger never claims a `propose` or `approve` node's principal side; an `approve` node closes only through `approve-node`.

## Test Strategy

| ISC | Probe |
| --- | --- |
| 1 | `grep -n "confirmed: levels 1-2" VSA.md`, dated. |
| 2, 3 | Unit test on the claim planner (`src/candidates.ts`) with a fixture `VSA.md`: no citation, cited-and-checked, cited-and-failing. Then one live tick on a planted node and `ranger journal` showing the `refused` row. |
| 4 | Unit test on `assembleImplementPrompt` (`src/prompt.ts:307`); `grep` a live worker log for the ISC text. |
| 5 | Close-path test: a merged PR that leaves the ISC `[ ]` parks the node; one that flips it closes. |
| 6, 7 | Unit test on job preflight: dirty tree refused, unpushed HEAD refused, clean pushed HEAD runs. |
| 8, 9 | A read-only query on the journal: `select count(*) from job_runs where coalesce(finished_at, started_at) >= date('now','-7 day') and <sha or receipt column> is null` returns 0 (ISC-9 counts by `finished_at`, since a queued run can finish without ever starting). |
| 10 | Config test for the probe field; a fixture job whose probe fails ends `failed` despite exit 0. |
| 11 | Two-failure fixture in the job pass test; live check by `events.kind='goal-job-failing'`. |
| 12 | `select count(*) from events where kind='closed' and at >= date('now','-7 day') and detail like '%attestation: unverified%'` returns 0. |
| 13 | `select count(*) from escalations where status='open' and created_at < date('now','-14 day')` returns 0. |
| 14 | Join `merged` events to `deployed`/`deploy-failed` events by PR for maps with a deploy command. |
| 15, 17 | `grep` the latest retro report for the flipped-ISC section; cross-check its proposals against `gh issue list` and Decisions. |
| 16 | Read the latest digest's first line. |
| 18 | Verified 2026-11-16: `src/config.ts:169` at 8185b76 reads `autoMerge: z.boolean().default(false)`. |
| 19 | Verified 2026-11-16 by reading `src/merge-gate.ts`: `GateCheck` lists both (lines 17, 20), CI must be `pass` (line 76) and the review check fails on blockers (lines 98, 109). A regression test should pin it. |
| 20 | `git log --author=<machine account> -p -- VSA.md` in each map repo, each hit matched to a reviewed PR. |
| 21 | Route test over `src/route.ts` classes; `ranger journal` shows no `worker-start` on an `approve` node. |

## Features

| Feature | Satisfies |
| --- | --- |
| F-claim-gate: read `VSA.md`, refuse and journal, brief with ISC text, close on flipped ISC | ISC-2–5 |
| F-job-preflight: clean tree, pushed HEAD, SHA and receipt columns (drizzle migration) | ISC-6–9 |
| F-job-probe: declared success probe and goal tag | ISC-10, 11 |
| F-close-hygiene: attested closes, escalation expiry, deploy pairing | ISC-12–14 |
| F-progress-report: retro and digest count flipped ISCs | ISC-15–17 |

Order: F-job-preflight first, because it protects the jobs already running unattended. F-claim-gate waits on ISC-1 here and on confirmed VSAs in the map repos, or it would refuse all work.

## Decisions

- 2026-11-16: Drafted read-only from the repo at 8185b76 and public `gh` counts. ISC-18 and ISC-19 pass on that evidence; the rest are unverified or failing.
- 2026-11-16: confirmed: levels 1-2 (jcfischer). Level 3 stays the builders' to change.
- 2026-11-16: ISC-12 and ISC-13 set ideal-state targets of zero. The maintainers may prefer a threshold; that is open.
- 2026-11-17: ISC-2 narrowed: only task/build nodes created on or after VSA.md was added to the base branch need a citation; repos without VSA.md allow every claim (jcfischer, O1+O2).
- 2026-11-17: ISC-2 accepts an explicit "ISC: none (<reason>)" line; ranger's scribe and fix-node filers write citations or that line; intake files without one when the source cites none, so the gate refuses it (jcfischer, D1/D2).
