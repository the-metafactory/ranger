# Live validation — claim+research lane + escalation desk (2026-08-17)

Operator-recorded evidence for the node #18 (walker live validation) and node `#20` (escalation desk) increments. The assertions below were logged by the
operator (the machine account `ivy-agent`) against the live soma graph on
2026-08-17. They are **records of what ran, not independently verifiable audit
artifacts** — the snowflake ids are the Discord message identifiers, and the
section at the end gives the exact commands to re-verify each claim on a live
host.

## Claim + research lane under the machine account

- Node **#19** (operational-readiness inventory) on the ranger map was charted
  and walked end-to-end under `ivy-agent`: announce → `soma graph claim
  --identity ivy-agent` → run-node → `claude -p` worker → gated close →
  `decisions --write`. Closed at checkpoint `walker-readiness-surveyed`;
  findings branch `research/walker-readiness-inventory` = `ae8139da`.
- Two real defects surfaced and were fixed (regression-tested in
  `test/walk.e2e.test.ts`): the close gate refused a legitimate close because
  `git-ref-exists` probes resolved against the supervisor's cwd instead of the
  canonical checkout; and `bootstrapWorktree` failed on an orphaned worktree
  branch (`-b` on an existing ref).

## Escalation desk — live cards (Discord snowflakes)

| map | node | route | message id |
| ----- | ------ | ------- | ------------ |
| the-metafactory/ranger | #21 | escalate-hitl (grilling) | `1538840391300677723` |
| jcfischer/seekolous | #29 | escalate-hitl | `1538840438578880553` |
| jcfischer/seekolous | #31 | escalate-hitl | `1538840439568994414` |
| jcfischer/seekolous | #32 | escalate-hitl | `1538840440684675192` |
| jcfischer/seekolous | #54 | escalate-hitl | `1538840441670344704` |
| jcfischer/seekolous | #99 | escalate-hitl | `1538840442777501776` |
| jcfischer/seekolous | #100 | escalate-hitl | `1538840443662372924` |

- First run: 7 cards posted (announce-once). Subsequent runs against
  unchanged state: 0 posted, 0 edited — edit-on-change skips cards whose
  rendered content is identical, so the desk converges to a full no-op
  (verified live across many 900s ticks). Edits happen only when content
  actually changes (e.g. an age-band bump, or a node title/body edit).
- Card destinations are persisted (`escalations.channel_id`, drizzle 0004)
  and indexed by repo (0005). Each card's message id is also tracked per
  destination channel (`escalation_destinations`, 0006), so a map that moves
  A→B→A RECOVERS its original A message on return instead of posting a
  duplicate (one card per node). A PATCH that 404s (legacy row or deleted
  card) reposts fresh. Absent-card reconciliation is bounded by a `noted_at`
  marker (drizzle 0007): a noted card drops out of the scan; closing
  resolved cards (which shrinks the open set) is the write-side (node #21).
- An unchanged same-day digest verifies its cached message still exists (GET)
  and reposts if deleted — the daily summary never silently vanishes.
- Digests: `digest.the-metafactory/ranger` = `2026-08-17:1538840582615728139`,
  `digest.jcfischer/seekolous` = `2026-08-17:1538840628891230208` (same local
  day re-runs edit only when the digest content changed; otherwise no-op).

## launchd schedule (versioned as templates in ops/launchd)

The live plists at `~/Library/LaunchAgents/` embed the principal's home path
and machine-account wrapper, so the repo versions them as `.plist.example`
templates with `/Users/__USER__` placeholders (`ops/launchd/*.plist.example`);
install by substituting the real home path. `launchctl list` on this host
reported both jobs loaded with exit status 0 at record time.

- `ch.invisible.ranger-tick` — walk pass every 900s via `~/bin/ranger` wrapper
  (injects keychain `ivy-agent` write PAT + grove Discord bot token into the
  tick env).
- `ch.invisible.ranger-escalate` — daily digest at 07:30 **in the host's local
  time** (this host runs Europe/Zurich; launchd `StartCalendarInterval` cannot
  encode a timezone, so the instant is local-time-relative).

## Re-verifying these claims

Scope of the commands below (each verifies only the escalation-desk claims it
can observe):

- Re-running the cards pass is **concurrency-safe** (a cross-process lock
  serializes overlapping runs so the second observes the first's rows as
  already-posted (no duplicate cards) — not crash-atomic: between Discord's POST response and the journal write
  there is a tiny window where a crash/SQLite failure leaves no cached id, and
  the next run posts a duplicate card (visible and deletable in the thread).
  The journal's `escalations` rows and the cards in the threads are the
  record; a duplicate is the recoverable consequence, not corruption.
- The reclaim path is crash-safe for the common crash: a run that dies while
  holding the lock (or the `.reclaiming` marker) is cleaned up on the next
  run — a dead-owner marker is removed before reclaim, and the main lock is
  deleted only after re-validating its owner is still dead. One residual
  window remains, disclosed honestly: if a process dies mid-reclaim at the
  exact instant another run re-creates the marker, a stale-cleanup could
  unlink a just-created marker and, under a pathological ≥3-contender
  thundering herd, two runs could both reclaim and post one duplicate card
  (visible and deletable in the thread) — the same recoverable class as the
  POST→journal window above. It has never been observed; the revalidation
  makes it require three concurrent reclaimers in one instant.
- The **#19 walk** claims (claim/close identity, `claude -p` worker execution,
  the historical decisions write, findings-branch revision at close time) are
  operator-recorded here — the commands below can only confirm the *current*
  graph state and branch ref, not reconstruct who ran the worker or what was
  decided months ago. The #19-specific facts remain assertions recorded by the
  operator, not independently re-derivable from these commands.

```bash
# 1. Re-run the cards pass + digest and inspect the reports (idempotent across
#    overlapping runs via the lock; still safe to run on the live host).
~/bin/ranger escalate --config ~/work/mf/ranger/ranger.yaml --json
~/bin/ranger escalate --config ~/work/mf/ranger/ranger.yaml --digest --json

# 2. The journal is the record of message ids and digests.
sqlite3 ~/.config/ranger/state.sqlite \
  "SELECT repo, node_id, status, message_id FROM escalations;"
sqlite3 ~/.config/ranger/state.sqlite \
  "SELECT key, value FROM health WHERE key LIKE 'digest.%';"

# 3. The scheduled jobs and their last exit.
launchctl list | grep ranger

# 4. The #19 walk claims against the live graph (status, close checkpoint,
#    decisions) and the findings branch revision.
soma graph node --repo the-metafactory/ranger --id 19 --json
soma graph audit --repo the-metafactory/ranger --root 1 --json
git -C ~/work/ranger-repos/the-metafactory/ranger rev-parse research/walker-readiness-inventory
```
