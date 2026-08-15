# DevConsumer proof — findings (node #14)

**Date:** 2026-08-15 · **Branch:** `research/devconsumer-proof` · **Verdict: NOT PROVEN — the lane is dormant and the proof is blocked on enablement/provisioning, not on code.**

This records the live-state investigation for ranger node #14 ("Prove cortex
DevConsumer live before it may become the executor lane"). The checkpoint
(`devconsumer-proven-live`) is **not** met: no real node has been walked through
`dev.implement` end-to-end. What follows is the evidence for *why*, and the exact
recipe that unblocks it. The finding feeds the later decision on whether to
switch the executor lane; it does not itself switch anything (per the node body).

## Live state (all checks run on the principal's machine, 2026-08-15)

| Layer | Check | Result |
| --- | --- | --- |
| Bus / stream | `nats stream ls` | `DEV_IMPLEMENT` **exists** (created 2026-06-10, provisioned up-front per cortex#1203), 0 messages, never a delivery. `CODE_REVIEW` (the live precedent) has 17 messages. |
| Bus / consumer | `nats consumer ls DEV_IMPLEMENT` | **No Consumers defined** — nothing binds. `CODE_REVIEW` has 5 bound consumers incl. the live `cortex-review-consumer-jc-sage`. |
| Config | `jc/default` stack | capabilities: `code-review.*`, `code-write.*`, `code-fix.*`, `github-pr-open` — **no `dev.implement*`, no `dev.orchestrate`**. Agents: fern, pilot, sage, cedar. |
| Config | `jc/switch` stack | capabilities: `chat`, `code-review.*`, `soc.compose.flow`, `chat.local` — **no `dev.*`**. Agents: sage, spark, yarrow. No `vega`-style orchestrator on either stack. |
| Identity | `~/.config/metafactory/github-apps/apps.yaml` | **Absent.** No GitHub App identity registry. |
| Identity | `CORTEX_DEV_GH_TOKEN` in launchd env | **Absent** (neither `ai.meta-factory.cortex.default` nor `.switch` plist sets it). |
| Daemon logs | `cortex-switch.log` | `DEV_IMPLEMENT` stream binding present; **no** `dev.implement consumer using forge identity …` / `NOT wired` line — consistent with zero dev-capable agents (the silent dormancy path: `wireDevConsumers` returns `[]` without touching anything). |
| Upstream | cortex `docs/iteration-dev-loop.md` | Dev-loop "built + released but **not enabled on any stack** … and **not running**". Make-it-live path explicitly dependency-sequenced and **blocked**. |
| Repo | ranger remote | No `research/devconsumer-proof` branch existed before this one — no prior proof attempt. |

## Why the proof could not be performed

Walking a real node through `DevConsumer` requires four conditions, of which
**three are unmet today**, and every unmet one is provisioning/enablement, not
researchable code:

1. **A stack that declares a `dev.implement`-capable agent (+ `dev.orchestrate`
   orchestrator).** No live stack declares either. Activating it means either
   editing a live production stack config (jc/default, jc/switch — the
   principal's live review/soc stacks) or creating an isolated `dev-loop` stack.
2. **A forge identity.** Per cortex#2436/#2438, `wireDevConsumers` **fails
   closed**: no `agents[].github.identityName` (no `apps.yaml` → no GitHub App
   identity exists) and no `CORTEX_DEV_GH_TOKEN` → **zero consumers wired**,
   "the dev loop is INERT on this stack". This is the decisive blocker: even with
   a dev-capable agent added, the lane would refuse to wire.
3. **A real dispatch.** The in-process entry is the principal posting
   `implement {repo}#{N}` to the orchestrator agent (cortex#1206 S1) — a
   principal-gated human action — or a hand-published `tasks.dev.implement`
   envelope.
4. The `DEV_IMPLEMENT` stream — the one condition already met (cortex#1203).

Both unmet config/identity conditions are the principal's hand by the map's own
HITL discipline: credential provisioning is charted as provisioning (`#11`,
`#16`), and the HITL invariant says the agent never stands in for the human's
side of a provisioning decision. Autonomous activation on a live stack would
also run head-on into the map's constraint "no autonomous graph-mutation under
the principal's credentials" in spirit (here: mutating live stack config +
provisioning credentials under the principal's identity).

## Upstream blocker (cortex), independently confirmed

The cortex dev-loop iteration doc is explicit and was verified against the live
bus:

- **W5.1a / cortex#1009** — harden the scaffolded `dev`/`release` agents into
  deployable packages: **BLOCKED, the current critical path.** "a stack can't
  declare the dev-loop capabilities until the bundle's `dev`/`release`/`approver`
  agents are real `agents[]` entries (verified — the config-merge dry-run fails
  `CortexConfigSchema` on unresolved `provided_by`)".
- **W5.1 / cortex#925** — enable on an isolated `cortex stack create dev-loop`:
  blocked on #1009.
- **W5.5 / cortex#929** — first live dogfood (dispatch → implement → review →
  fix → **HOLD at merge**): blocked on #1009 + W5.1; has never run.
- **cortex#995** — approver credential (principal action) gates the final merge.

So the "first live dogfood run" that would constitute this proof is an upstream
cortex milestone that no stack has reached. Node #14 cannot be proven before
that upstream work + local forge-identity provisioning land.

## Implication for the executor decision

- Decision #4's v1 stands: ranger-owned **direct `claude -p` spawn** remains the
  executor for now. DevConsumer is **not** ready to be the lane.
- `DevConsumer` stays dormant-by-default, which is the correct posture — no
  stack enables it, nothing binds, nothing pushes. The fail-closed identity gate
  (cortex#2436/#2438) is verified working as designed.
- Re-run this proof when, and only when, all four hold: (1) cortex#1009 lands,
  (2) an isolated `dev-loop` stack is enabled (W5.1, cortex#925), (3) a forge
  identity is provisioned (GitHub App `apps.yaml` or `CORTEX_DEV_GH_TOKEN`), and
  (4) W5.5's first live dogfood walk completes. Then the proof is a repeatable
  checklist, not a research question.

## Second-order notes for whoever enables it

- **Durable-name contention is latent for DevConsumer too.** `devDurableName`
  is `cortex-dev-consumer-{principal}-{agent}` (dev-consumer-boot.ts), so two
  stacks sharing one agent id on one JetStream would contend exactly like the
  `cortex-review-consumer-jc-sage` shared-durable contention (cortex#1503). The
  upstream plan's "isolated `cortex stack create dev-loop`" already dodges this;
  keep the dev agent id per-stack distinct if ever co-hosted.
- **Stream provisioning is already shipped** (cortex#1203 provisions
  `DEV_IMPLEMENT` up-front), so the boot-wiring "FLAG" noted in
  `dev-consumer-boot.ts` is resolved in practice — the stream exists and binds on
  both stacks today.
- The upstream recommended first-run shape is exactly the map's own boundary:
  dispatch a **real** ranger-map task (e.g. a small task node from this map) as
  the dogfood, and **hold at merge** for the human until the approver credential
  (cortex#995) exists.
