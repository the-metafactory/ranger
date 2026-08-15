# Research: live cortex review-path state (build, DORMANT canary, two-stack contention)

Resolves ranger node #2 (map #1). Investigated read-only on jc's Mac, 2026-08-15.
All paths are absolute paths on that machine; log line numbers are against the log
files as of this morning (they are append-only but launchd-rotated only by size).

## (a) Is the deployed cortex running a build containing `01f43bb9` (cortex#2516)?

**Yes for the jc/default stack; no for the still-running jc/switch process. Operationally it changes nothing either way (mechanism defaulted to 1).**

Deployment mechanics:

- launchd plists: `~/Library/LaunchAgents/ai.meta-factory.cortex.default.plist` and
  `ai.meta-factory.cortex.switch.plist` (there is **no** `ai.meta-factory.cortex.meta-factory.plist`;
  `~/.config/cortex/default/default.yaml` is the config-split *pointer* file for what was
  once the "meta-factory" stack). Both run `/Users/fischer/.local/bin/cortex start --config …`.
- `/Users/fischer/.local/bin/cortex` is a symlink to
  `/Users/fischer/.local/share/metafactory/arc/repos/cortex/src/cortex.ts` — a bun script,
  so the *running code* is whatever that checkout held at **process start time**.
- That arc-managed checkout is on `main` at **`01f43bb9`** — `fix(bus): stop the
  pull-consumer loop serializing on handler duration (#2515) (#2516)`, committed
  2026-08-12 22:51, pulled `--ff-only` into the deploy checkout 2026-08-12 22:52:11 (reflog).
- `~/work/mf/cortex` `origin/main` HEAD is also `01f43bb9` — deploy checkout == origin/main,
  nothing newer exists upstream.

Process start times vs the pull:

| stack | launchd label | PID | started | runs 01f43bb9? |
|---|---|---|---|---|
| jc/default | ai.meta-factory.cortex.default | 78004 | Thu Aug 13 20:35:33 | **yes** (started after the Aug 12 pull) |
| jc/switch | ai.meta-factory.cortex.switch | 15773 | Thu Aug 6 21:41:04 | **no** (bun loaded sources 6 days before the commit existed) |

Important caveat from the commit itself (verified in the deployed source,
`src/bus/myelin/subscriber.ts` / `src/bus/review-consumer.ts`): #2516 lands the
`maxConcurrent` pull-loop mechanism **defaulted to 1** and does **not** opt the review
lane in — "byte-identical behaviour for every consumer including the review lane."
The opt-in is held in **cortex#2517 (OPEN)**: "Concurrent reviews still don't run:
second dispatch is admitted then stalls before starting." So even the freshly
restarted default stack still serializes reviews.

## (b) Review consumer: ready or DORMANT, and the cheapest programmatic canary

**Both stacks' review consumers are currently `ready` (per their own logs), and the
durable shows a live pull backlog on the broker.**

Logs (from the plists): `/Users/fischer/.local/state/metafactory/cortex/logs/cortex-{default,switch}.log`.

- default log, last consumer-state lines (no later DORMANT):
  - line 284405: `cortex: review consumer ready for agent=sage flavors=[typescript,security,python,rust,go,generic] signed=off engine=sage model=claude`
  - lines 284406–284407: federated (offer/direct) consumers ready, patterns `federated.jc.default.tasks.code-review.*` / `federated.jc.default.tasks.*.code-review.>`
- switch log: one DORMANT episode at line 1243
  (`review consumer DORMANT … cortex MyelinRuntime subscriptions disabled (G-1111 pending…)`),
  later recovered; last state line 3570 is `ready` — note `engine=assistant model=default`,
  i.e. the switch stack's sage is a *different engine* than default's `engine=sage model=claude`.
- Caveat: these log lines carry **no timestamps**, which is exactly why a log grep is a
  weak canary.

No stray non-JetStream nats-server: the only listener on :4222 is
`/opt/homebrew/bin/nats-server -c /Users/fischer/.config/nats/local.conf`
(PID 3180, launchd `ch.invisible.nats-server`, up since Jul 30), and that config **has a
`jetstream {}` block** (store_dir `~/.local/share/nats/jetstream`, domain `leaf-jc`) plus
leafnode remotes to `nats.meta-factory.dev:7422`. Both cortex PIDs (78004, 15773) hold
established TCP connections to it (lsof).

**Cheapest programmatic canary** — ask the broker, not the logs:

```sh
nats --server 127.0.0.1:4222 consumer info CODE_REVIEW cortex-review-consumer-jc-sage --json \
  | jq '.num_waiting'
```

- `num_waiting > 0` → at least one pull loop is parked on the durable waiting for work
  ⇒ **ready** (a DORMANT consumer issues no pull requests, so this drops to 0 as the
  outstanding pulls expire).
- Bonus fields in the same call: `.delivered.last_active` (last delivery),
  `.num_ack_pending` (reviews in flight), `.num_pending` (backlog).

Observed right now: `num_waiting: 257`, `num_pending: 0`, `num_ack_pending: 0`,
delivered = ack_floor = consumer_seq 94 / stream_seq 799, `last_active
2026-08-14T17:49:15Z` — a healthy, keeping-up consumer. One probe, no shell parsing of
26 MB logs, timestamped by the server.

Two caveats on the canary:
1. It is a **liveness** canary, not a routing canary — with the shared durable (see (c))
   it cannot tell *which* stack's loop is doing the pulling.
2. cortex#1504 (OPEN) — the pull subscription does not rebind after a nats-server
   restart — is a real DORMANT-while-process-alive mode this canary *correctly* catches
   (num_waiting decays to 0) while a process-liveness check would not.

## (c) jc/default vs jc/switch shared-durable contention (`cortex-review-consumer-jc-sage`)

**Still unfixed and currently live: both stacks are running, the durable is still not
stack-scoped, and the "stop the switch bot" workaround is NOT in effect.**

- Durable name construction, deployed source
  `/Users/fischer/.local/share/metafactory/arc/repos/cortex/src/runner/review-consumer-boot.ts:400`:
  `const durable = `cortex-review-consumer-${opts.reviewPrincipalId}-${agent.id}`;`
  — principal + agent only, **no stack/channel component**.
- Both stacks declare `principal.id: jc` and provide sage
  (`~/.config/cortex/default/stacks/default.yaml` stack.id `jc/default`;
  `~/.config/cortex/switch/stacks/switch.yaml` stack.id `jc/switch`) ⇒ both derive the
  same durable `cortex-review-consumer-jc-sage`.
- The live durable (created 2026-08-06T20:34Z, i.e. in the switch-boot window) filters
  `local.jc.default.tasks.code-review.*`; consumer provisioning explicitly does **not**
  drift-check consumer configs in v1 (`src/bus/jetstream/provision.ts` — "Don't
  auto-update on config drift … log + leave alone"), so a second stack binding the
  existing durable just shares it: whichever loop pulls first gets the message. That is
  the wrong-bot misrouting mechanism, and the switch stack's sage runs
  `engine=assistant model=default` — a claimed review lands on the wrong engine, not just
  the wrong process.
- Tracking issue **cortex#1503 (OPEN)**: "bug(review): cortex-review-consumer-jc-sage
  durable is not stack-scoped — jc/default and jc/switch contend." No fix in history:
  deploy checkout == origin/main == `01f43bb9` and the durable template above is what
  that commit ships.
- Current exposure: `launchctl list` shows **both** stacks up (default PID 78004,
  switch PID 15773) and the shared durable has 257 waiting pulls — consistent with more
  than one loop (and/or restart residue) parked on it.

**Implication for ranger's implement lane (design §7):** the wrong-bot-routing
precondition is *not yet met*. Until cortex#1503 is fixed (stack-scoped durable) or the
switch bot is stopped, a review dispatched to jc's default lane can be claimed by the
switch stack's assistant-engine sage. The `num_waiting` canary above proves liveness but
cannot prove correct routing; the only current routing guarantees are operational
(stop `ai.meta-factory.cortex.switch`) or a cortex-side fix.

## Pointers

- Deployed checkout: `/Users/fischer/.local/share/metafactory/arc/repos/cortex` @ `01f43bb9`
- Dev checkout: `/Users/fischer/work/mf/cortex` (origin/main @ `01f43bb9`)
- Logs: `/Users/fischer/.local/state/metafactory/cortex/logs/cortex-{default,switch}.log`
- Broker: `ch.invisible.nats-server` → `/Users/fischer/.config/nats/local.conf` (JetStream, domain leaf-jc)
- Open issues: cortex#2515 (serialization, still open pending #2517), cortex#2517
  (concurrency opt-in held), cortex#1503 (shared durable), cortex#1504 (no rebind after
  broker restart)
