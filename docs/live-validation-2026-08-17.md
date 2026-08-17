# Live validation — claim+research lane + escalation desk (2026-08-17)

Operational evidence for the node #18 (walker live validation) and node #20
(escalation desk) increments. Everything below was executed against the live
soma graph under the machine account `ivy-agent` on 2026-08-17; the message
ids are Discord snowflakes from the ranger (`#soma`) and Seekolous threads.

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

- First run: 7 cards posted (announce-once). Second run: 0 posted, 7 edited
  (edit-not-repost — journal-cached message ids).
- Digests: `digest.the-metafactory/ranger` = `2026-08-17:1538840582615728139`,
  `digest.jcfischer/seekolous` = `2026-08-17:1538840628891230208` (same-day
  re-run edits instead of reposting).

## launchd schedule (versioned as templates in ops/launchd)

The live plists at `~/Library/LaunchAgents/` embed the principal's home path
and machine-account wrapper, so the repo versions them as `.plist.example`
templates with `/Users/__USER__` placeholders (`ops/launchd/*.plist.example`);
install by substituting the real home path.

- `ch.invisible.ranger-tick` — walk pass every 900s via `~/bin/ranger` wrapper
  (injects keychain `ivy-agent` write PAT + grove Discord bot token into the
  tick env). `launchctl list` exit 0.
- `ch.invisible.ranger-escalate` — daily digest at 07:30 Europe/Zurich.
  `launchctl list` exit 0.
