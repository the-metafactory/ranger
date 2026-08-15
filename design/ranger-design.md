# Ranger — autonomous orienteer work-graph walker

**Status:** design, 2026-08-15 · **Repo:** `the-metafactory/ranger` · **Stack:** TypeScript / Bun / SQLite
**Method:** synthesized from a grounded design panel — seven subsystem grounding digests (orienteer skill, soma work-graph implementation, cortex dispatch, pilot SOP, pulse, the live Seekolous corpus, ecosystem prior art), three independent architecture drafts (stateless-tick, bus-native, pilot-evolution), and an adversarial critique of each. Every capability claim below is grounded in those digests; anything that does not exist today is tagged **NEW-BUILD**, **NEW-CONFIG**, **UPSTREAM** (PR to another repo), or **PROVISIONING** (a human's hand).

---

## 0. Mission and honest value model

Ranger points at an orienteer map — a `soma graph` work graph on a repo's issues — and walks it: claims decided frontier nodes, executes AFK-capable work through the standard SOP (working-tree review → PR → sage review loop → gated merge), files newly-discovered work back onto the graph as typed nodes, and escalates genuine decisions to the principal asynchronously while the rest of the frontier keeps moving.

Ranger is the implementation of soma `docs/work-graph.md` §5 Phase 2 — the headless tick under a machine-account PAT, the Discord claim announcement with 60-second veto, and the GitHub Actions close auditor. That spec is already decided; ranger builds it rather than rivaling it, and extends it with the node-kind routing and SOP integration the spec stops short of.

**The honest value model** (this ordering is a finding, not a disclaimer). On the live reference corpus (Seekolous, two maps, ~35 closed nodes), HITL is the norm even for build nodes — `auto` is the rare exception. Ranger's steady-state value therefore arrives in this order:

1. **Visibility and escalation** — the map pings the principal instead of waiting for him to remember it. The HITL queue, stale claims, and receipt-less closes are invisible between sessions today (the first live audit found 7 of 27 closed nodes receipt-less).
2. **The research lane** — research nodes are the one kind with existing autonomous precedent, parallel-safe by doctrine.
3. **The mechanical tail** — once a decision is made, the implement→review→merge→close pipeline is mechanizable and is where the walk actually compounds.
4. **Graph growth** — filing discovered work with provenance, which today depends on session discipline.

Full autonomous build-node walking is **conditional on charting practice**: autonomy is granted by humans at charting time, and ranger never grants it to itself. A map that wants to be walked must be charted walkable — `auto` build nodes with honest machine probes. That dependency is stated here once and assumed everywhere.

---

## 1. Architecture

Ranger follows the ecosystem's activation/orchestration split (reflex doctrine: activation initiates work, never orchestrates it): a **launchd-triggered stateless tick** orchestrates one bounded pass and exits; detached **per-node worker supervisors** outlive the tick; correctness always lives in the graph's own gates, never in ranger's cache.

```
launchd (interval) ──► ranger tick ──┬─ guards (run-lock, dead-man, identity, cortex health)
                                     ├─ sweep     (reconcile journal vs reality)
                                     ├─ audit     (soma graph audit --json per map)
                                     ├─ derive    (soma graph frontier --json per map)
                                     ├─ route     (autonomy × kind × policy → lane)
                                     ├─ escalate  (HITL cards → Discord; ratify poller)
                                     ├─ claim     (announce → 60s veto → soma graph claim)
                                     └─ spawn     (detached `ranger run-node <id>`)

ranger run-node <id> ──► worktree + prompt assembly ──► headless `claude -p` session
                        └─ SOP tail: working-tree review → PR → sage loop → merge gate
                           → soma graph close → decisions --write → file-back (Scribe)

GitHub Actions close-auditor (per walked repo): on issue close, re-verify receipt
pointers; reopen with `ranger:audit-failed` label on mismatch.
```

| Component | Kind | Notes |
| --- | --- | --- |
| `ranger tick` | NEW-BUILD | The §5 Phase 2 tick. Stateless: re-derives everything from the graph each pass. |
| `ranger run-node` | NEW-BUILD | Worker supervisor: worktree, prompt, bounded `claude -p` spawn, outcome record, cleanup. Direct spawn — see §2 executor decision. |
| Router + policy | NEW-BUILD | `ranger.yaml` per-map walk modes + conservative autonomy floor (§3). |
| Escalation desk | NEW-BUILD | Discord cards, ratification poller, human-report intake (§5). |
| Scribe | NEW-BUILD | Programmatic file-back via `soma graph add` (§6). Nothing in the ecosystem does this today. |
| Journal | NEW-BUILD | SQLite: liveness, attempts, escalation pointers, dead-man counter (§8). |
| Close auditor | NEW-BUILD | GitHub Action, spec'd in §5 Phase 2, zero implementation today. |
| `soma graph` verbs | REUSED | The complete graph API: race-safe claim, hollow-close refusal, cycle rejection, audit, decisions projection (soma `src/cli/graph.ts`, `src/work-graph*.ts`). |
| Orienteer doctrine | REUSED | WalkTheMap / closing / fog files are literal worker-prompt material — referenced, never forked. |
| Pilot pure pieces | REUSED | Exit-code contract, six-check merge-gate *shape* (`evaluateMergeChecks`), fix-small/defer-big table, worktree bootstrap SOP, 3-counter GitHub polling fallback. |
| `sage dispatch` recipe | REUSED | `SAGE_STACK=default sage dispatch <owner>/<repo>#<N> --org jc --post --wait 300` — the proven review round-trip on this machine. |
| `soma graph release` | UPSTREAM | Identity-bound self-release verb (promotes the claim-race loser's existing self-removal). Until it merges, abandoning a claim is escalate-only. |
| Machine-account PAT, approver token, Discord bot, probe-registry entries, launchd plist | PROVISIONING | §9. |

**What ranger is not:** not a NATS consumer in v1 (CLIs with typed exit codes are the bus interface); not a pulse process (pulse cannot express loops/branches — its own dev-loop G1–G4 gaps say the driver must hold run state); not a fork of orienteer doctrine; not a second graph store (no sync contract exists upstream, deliberately).

**Executor decision (v1):** ranger spawns workers **directly** (`claude -p`, subscription mode, absolute-path/env-hygiene plumbing per pulse `capabilities.ts` — but with tools *enabled*). The alternatives lose on ground truth: cortex's `DevConsumer` lane is code-complete but dormant — no live stack has ever run it; pilot's Phase-3 state machine is coded but operationally unproven here, its config loader is broken against the 2026-06-18 cortex config split, and its Discord/env surface is unverified. Direct spawn is the only executor with zero unproven dependencies, and it makes worker liveness trivially supervisable (PID + output stream, not bus envelopes that don't exist between `started` and `completed`). Dispatching to `DevConsumer` becomes a later, optional lane once someone proves it live (decision node on the map).

---

## 2. Identity model

Three identities, structurally separated:

1. **ranger-bot** (machine account; exists, unwired — soma#511 residue). Claims nodes, authors branches and PRs, closes nodes. `GH_TOKEN` = its fine-grained PAT for ranger's entire process tree. Ranger **refuses to tick** if its resolved identity equals the principal's login — "no autonomous ticking under the principal's credentials" made mechanical. Note: fine-grained PATs are org-scoped; covering `the-metafactory/*` and `jcfischer/*` needs two PATs (per-repo mapping in `ranger.yaml`).
2. **jcfischer** (the principal). Speaks only for himself: vetoes, ratifications, grillings, probe-registry widening, good-enough calls. The ratification poller and veto reader **pin on this identity** — the verb accepts any non-proposer's 👍, so ranger checks reaction authorship itself before completing a ratified close.
3. **approver-bot** (`APPROVER_GH_TOKEN`; unprovisioned today). Merge authority. Runs in a **separate ranger component** (merge step of the SOP tail executed by `run-node`'s supervisor code after the worker session ends, or a `pilot approve`-style flow) — **never inside a worker session's environment**. A single agent session holding both author and approver credentials is one brain wearing two hats; the critique is right that this voids the two-of-two gate. Until the token exists: merges escalate to the principal (one tap), never `--admin` autonomously.

**Sage verdict semantics under the bot identity.** Bot-authored PRs end sage's self-review downgrade, so formal verdicts become possible — but sage posts under the principal's login, so a sage APPROVE would satisfy branch protection *as though the human reviewed*. Rule: **sage's verdict is machine review evidence, never human sign-off.** The merge gate consumes it as "review present, 0 blockers"; branch-protection approval, where required, comes from approver-bot or the human. Attestation `verified` stays honestly unreachable while any ranger process runs on a machine where the principal's keychain credential is reachable; ranger treats `unverified` as the normal label it is.

---

## 3. Routing and the autonomy floor

Per frontier node, first match wins:

| # | Condition | Route |
| --- | --- | --- |
| 1 | Open escalation card, vetoed, or parked | Skip (dedupe). |
| 2 | `autonomy ∈ {propose, approve}` — any kind | **Escalate, never claim.** Unclaimed HITL nodes stay visible and takeable by the principal's own interactive sessions. |
| 3 | `autonomy: auto` but kind `grilling`/`prototype` | **Escalate as map hygiene.** HITL kinds are HITL regardless of declared autonomy — ranger's conservative floor, standing in for the unimplemented §4 clamp. |
| 4 | Typed block missing/broken (store fail-safes to `approve`) | Escalate ("node needs typing"). |
| 5 | `auto` + probes not satisfiable on this host (registry preflight via `soma policy probes`) | Skip + provisioning card (the exact `run`+`cwd` for the principal to paste). Never burn a worker into a guaranteed close-refusal. |
| 6 | `auto` + budget exhausted (ranger's ledger) | Park + card — the NodeBudget circuit breaker soma types but doesn't run; ranger is its first enforcer. |
| 7 | `auto` + kind `research` | Research lane (parallel). |
| 8 | `auto` + kind `task`/`build`, **and** the map is registered `walk: full` in `ranger.yaml` | Implement lane (serial). Build authority is an explicit machine-readable opt-in in ranger's config, not an inference from map-Notes prose. |

**The self-amplification ban:** ranger-filed nodes (§6) are `propose` minimum, always. Only a human grants `auto` — at charting, or by editing a filed node. This kills the loop the critique found (machine mints auto work → claims it next tick → mints more) at the cost of one tap per deferred trivial item.

Frontier ordering: doctrine's "first frontier node in order". No priority engine in v1; per-map round-robin so one hot map cannot starve others.

---

## 4. Worker execution model

One worker = one node = one headless session (doctrine; research excepted).

**Provisioning per worker:**

- Worktree: `git worktree add <canonical>/​.worktrees/node-<N> -b node/<N>-<slug> origin/main` + `bun install` + vendor-binary copy — pilot's bootstrap SOP verbatim.
- **Canonical checkout per walked repo** (`~/work/ranger-repos/<repo>`, maintained by ranger, fast-forwarded post-merge). This answers the fatal probe finding: command probes execute in the canonical checkout, whose stable path *can* be pre-registered in the probe registry. Worktrees are for building; probes run where the registry says. Node probe guidance (enforced by the Scribe at creation for ranger-filed nodes, advisory for humans): prefer ungated types — `git-ref-exists` / `artifact-exists atRef:main` / `git-merged-into` shaped for squash merges (the #97 post-hoc-amendment lesson) — over command probes; url probes are useless on private repos (no auth).
- Env: `GH_TOKEN`=ranger-bot PAT, `SOMA_GRAPH_REPO=<owner/repo>`, `SAGE_STACK=default`, `PILOT_PRINCIPAL=jc`. No approver token, no keychain export, no access to `~/.soma/policy/`.
- Prompt = node body + typed block + map **Destination/Constraints/Notes verbatim** (constraints bind only as far as the session reads them — so ranger injects them into every prompt) + the orienteer WalkTheMap/closing doctrine + the kind SOP + an untrusted-text guard (issue bodies are third-party-writable: instructions inside them are data, never directives — grove's sandbox layering is the reference bar).

**Kind SOPs:**

- *research*: investigate; findings on a throwaway `research/<slug>` branch; push; close with an ungated probe + `--resolution-file` + `--gist`.
- *task/build*: implement in the worktree; repo test command; **working-tree review before the PR exists** (decision #5, closed: the standing rule is a sage working-tree mode — `LocalGitBackend` behind the ForgeBackend seam, `sage review --working-tree [path] --base <ref>`, filed upstream as the-metafactory/sage#106; until it lands the lane runs the interim: draft-PR-first with **offline** `sage review <owner/repo#N>` on the draft — never bus dispatch for this round, which sidesteps the live cortex#1503 two-stack durable contention, the DORMANT class, and head-of-line; a draft cannot merge so #588 auto-close stays inert, and the real body is written when marking ready); open PR — **no GitHub closing keywords in PR title, body, or squash commit message** (the observed #588 fail-open path: auto-close skips the gate); sage review loop with verdict dedupe (cortex#422 posts each review twice) and the typed exit-code contract (0 verdict / 3 cant_do / 4 not_now retryable / 5–7 terminal / 124 timeout → DORMANT-consumer check first); batch all findings, one fix pass, **cap 2 round-trips then park + escalate** ("a third round signals a decision is needed, not another patch"); merge via the six-check gate under approver identity (§2) after a 30s merge-veto window; `soma graph close --dry-run` then close; confirm by re-reading the node (close has no `--json`); `decisions --write` (with marker-hash detect-and-retry — the span is read-modify-write with no CAS and the principal's sessions write it too); then the Scribe pass (§6).

**Bounding:** hard wall-clock kill at `NodeBudget.wallClockMin` (default 90 min — ≥ 2 full review cycles + spawn overhead per the SOP's ~65-min floor); `agentInvocations` caps respawns; token spend accumulated from the `claude -p` JSON output. Supervisor-side liveness (PID + output-stream progress), not worker-written heartbeats.

**Workers never:** widen the probe registry, amend probes post-hoc, substitute `--evidence` for a failed probe, reopen closed decisions (the #145/#170 protocol: file a follow-up node + comment "the checkpoint is closed and the decisions stand"), dismiss reviews, merge, or edit map prose.

---

## 5. HITL escalation protocol

**Channel:** Discord, one channel (`#ranger`), one thread per map. Discord is notification and veto surface; **GitHub is where answers bind**. Announce mechanics fail closed: no confirmed message id → no claim, no window, no action.

| Trigger | Card | Answer path |
| --- | --- | --- |
| `grilling` node on frontier | Decision needed: question, options with constrained dimensions visible, link, blocked-descendant count ("resolving this unblocks N nodes") | The principal resolves it in a live interactive session. Ranger never conducts grillings and never drafts his answers. The close re-enters the walk through the graph itself — next tick's frontier sees the unblocked descendants. Zero answer-ingestion machinery. |
| `prototype` node | Handoff card | Interactive session. |
| `propose` node whose content is agent-producible (task/build/research work product) | Ranger does the work, then `soma graph close --propose --body-file …` — a proposal comment via the verb, no close. Card links it. | 👍 **from the principal** (identity-pinned) → `close --proposal-comment <id>`; because ranger always passes `--proposal-comment`, the root author's 👎 is *verb-enforced* refusal — upgrading the recorded-not-enforced flow into ranger's binding contract. 👎 → withdrawn, parked, never re-proposed to route around a refusal. The human ratifies a **work product**; decision-shaped content still goes to a live session. |
| `approve` node — any | Notification only. No proposal, no recommendation-as-default, no action on silence. | Interactive session or explicit operator verb. Silence-proceeds exists **only** in the 60s claim-veto on `auto` nodes, exactly as §5 Phase 2 specifies. |
| Operational stalls | Parked PRs (review cap), close-blocked probes, budget exhaustion, registry needs, audit findings, stale foreign claims, DORMANT lane, dead-man trips | Operator verbs: `ranger resume-node`, `resume-run`, `clear-veto`; or the principal's hands (registry paste, manual unassign until the release verb lands). |
| Human observation intake | The principal posts free-form in the thread; ranger drafts the node (title, placement below the relevant subtree, checkpoint, probes if derivable) as a draft card | 👍 triggers the actual `graph add`. The observation stays in the principal's words. |

Cards are announce-once, edited not reposted, re-surfaced in a daily digest with age. **Meanwhile, nothing blocks:** escalated nodes stay unclaimed; `blocked-by` edges keep dependent work off the frontier automatically; every independent branch keeps walking. The frontier predicate is the scheduler.

**Veto durability:** a veto is recorded as a comment on the node (additive, non-gating, provenance-bearing) *and* cached in the journal. On journal loss, ranger re-reads its own veto comments before any claim. A human's NO never lives only in a disposable store.

---

## 6. Dynamic graph growth (the Scribe)

All filing via `soma graph add <spawning-node> … --blocked-by …` — scaffold placement below the spawning node, never on the map; the frontier walks the whole subtree so placement never buries work (#557). The four provenance patterns from the live corpus, as filing templates:

1. **Split-out-of-review** — defer-big findings, filed after merge: "Split out of #N (PR #M), raised in review and deliberately not done." (Seekolous #162/#163/#135.)
2. **Found-by-probe** — the filed issue *is* the report; failing checks stay failing on purpose. (#166, #120.)
3. **Code-comment-graduated** — landmine comments become schedulable nodes. (#168.)
4. **Human observation** — intake via Discord draft-card flow (§5); the words stay the principal's. (#160.)

Filed nodes: `propose` minimum (§3), checkpoint minted at add time (mandatory — no later attach verb), edges wired with the documented failure mode re-checked (a failed edge leaves the node created and on the frontier), squash-safe probe shapes. Collisions with closed decisions follow #145/#170: comment, follow-up node, never reopen.

**Editorial map maintenance** (fog graduation, out-of-scope rulings, constraint recording) is judgment work with no verb support: ranger proposes in the digest; the principal's interactive sessions apply. The one machine-owned span — the decisions index — ranger re-projects via `decisions --write` after every confirmed close. Constraint-bearing closes are escalated distinctly (a constraint buried in a receipt is one no later session reads).

---

## 7. Failure and stall handling

Stance: **crash = no-op.** The graph's gates are the correctness boundary ("correctness never rests on frontier accuracy"); the journal carries liveness and politeness only.

| Failure | Detection | Response |
| --- | --- | --- |
| Crashed worker | Tick sweep: PID dead, no outcome row | Claim survives (assignment is on the tracker). Sweep checks for an existing open PR/branch for the node and instructs the respawned worker to **adopt, not duplicate**. Attempt < 2 → respawn; ≥ 2 → park + card. |
| Crashed tick | Stale run-lock (dead PID) | Broken automatically; claims made mid-pass are found by the next sweep as claimed-with-no-worker. |
| Stale ranger claim, no recoverable worker | Sweep | Escalate. Until the `soma graph release` verb (UPSTREAM) merges, ranger never unassigns — report-only. |
| Stale foreign claim | `soma graph audit` | Digest only. Ranger cannot distinguish in-flight from stale and never touches another identity's claim. |
| Flaky probe | `--dry-run` preflight fail or close refusal | One retry (the flake rule); then leave the node open, `close-blocked`, card with observed output. Never loosen, never amend, never hollow-close. Probe trouble is signal — the dominant live friction class (≥9 Seekolous issues; agreeing verdicts hide drift). |
| Review non-convergence | Round counter = 2 | Park, keep claim, card with findings summary. Good-enough is the principal's call — sage never converges to zero. |
| Review dispatch failure | Typed exit codes | 4 retries once with backoff; 3/5/6/7 park + card; 124 → DORMANT check (stray nats-server on :4222; 127.0.0.1 never localhost) *before* concluding timeout. Cheap pre-dispatch canary each tick, not only post-timeout. |
| Duplicate verdicts (cortex#422) | Same `result_summary` hash in a cycle | Dedupe; count one round. |
| Wrong-bot review routing (two-stack durable contention) | Reviewer identity on the verdict ≠ expected | Card naming the known workaround (stop the switch bot). Resolving the shared-durable contention is a **precondition** for unattended review dispatch, not a scaling concern — it misroutes at any volume. |
| Tracker-side close, gate never ran (#588) | Close-auditor Action + tick audit | Auditor reopens with `ranger:audit-failed`; digest shows both signals. Prevention: no closing keywords anywhere (title/body/commit). |
| Veto | 👎 in the 60s window | Sticky (node comment + journal), never auto-retried; `ranger clear-veto` only. |
| Dead-man | ≥3 consecutive worker failures | `paused` flag: all claiming stops, tick stays read-only (digests, sweeps, escalations still run), loud alert; only human `ranger resume-run` clears. Plus a daily worker-spawn cap (default 10) as the global spend bound. Absence of the daily digest is itself the outer dead-man signal. |

Everything parked or vetoed is terminal until an operator verb. Silence never un-parks.

---

## 8. Concurrency and state

**Concurrency, shaped around the real bottleneck** (review concurrency is 1 in-flight per agent lane: the cortex#2516 mechanism is merged but defaults to 1 and no boot site passes the knob; #2517 holds the plumbing; a second downstream serialization point is unlocated — do not design around a fix you cannot observe):

- Review-consuming lane: **1** (implement workers may overlap in their build stage and queue at the review gate).
- Research lane: **N** (default 2–3).
- Merge/close: serialized (the decisions span has no CAS).
- Escalations: unbounded, non-blocking.
- When #2517 lands, the lane cap is a config integer, not a redesign.

Claim-level safety against the principal's concurrent interactive sessions is inherited from the verb (post-write re-read + deterministic tie-break), not built.

**State:** SQLite journal (`~/.config/ranger/state.sqlite`) holding only what the graph cannot: `workers` (pid, worktree, attempts, deadlines, outcome, correlation ids), `escalations` (card/message/proposal-comment pointers), `vetoes` (cache of the durable node-comment record), `health` (dead-man, spend), and an append-only event log. Everything topological is re-derived per tick. Deleting the journal degrades to re-announcing and re-trying once — never to incorrect graph state, and never to forgetting a veto (§5).

**Correlation threading:** node id anchors the chain → branch `node/<N>-<slug>` → PR → sage correlation_id (captured from dispatch stdout — the only join key to verdicts) → merge SHA → close receipt. Reading order for any incident: Discord thread → journal row → worker transcript log → PR/review → receipt. Bus-event emission for signal-stack joins is a later optional step; observe the bus, never parse cortex logs.

---

## 9. Build path (each step useful alone)

0. **Provisioning (human, gating):** machine-account PAT(s) per §5.1 checklist + collaborator invites; Discord bot + channel; probe-registry entries for the first repo's canonical checkout; approver token when ready; launchd plist. *Read-only scout under the principal's credential needs an explicit ruling first (decision node) — "no autonomous ticking under the principal's credentials" is worded absolutely.*
1. **`ranger scout`** — read-only tick: frontier + audit + HITL queue → CLI report, then daily Discord digest once the bot exists. Zero write risk; exercises the whole derive/route pipeline; would have caught map #495's receipt-less closes automatically. **Highest-ROI step per the critique — worth building even if nothing else ever ships.**
2. **Escalation desk (graph-read-only)** — HITL cards, provisioning-request detection, human-report intake drafts (👍-gated `graph add` is its first write). Converts orienteer from "remember to start sessions" to "the map pings you."
3. **Claim + veto + research lane** — the smallest full claim→execute→close loop, on the safest kind, under the bot identity, with the veto live.
4. **Implement lane** — the §4 kind SOP end-to-end on a `walk: full` map; review lane 1; merges escalated until the approver identity exists. Ship the close-auditor Action alongside — it guards this lane's merges.
5. **Ratification flow + hardening** — propose-draft ratification, `soma graph release` upstream PR, budget breaker, DevConsumer lane evaluation, review-cap config for #2517.

Steps ship independently and are independently reversible (unload the plist → ranger degrades to scout).

---

## 10. Open decisions (the map's decision nodes)

These are charted as nodes on this repo's orienteer map rather than resolved here:

1. ~~Executor ratification~~ — **decided (#4, closed):** v1 = ranger-owned direct `claude -p` spawn ratified; DevConsumer is a later lane gated on a proven end-to-end walk (proof node #14 charted below #4).
2. ~~Working-tree review mechanism~~ — **decided (#5, closed):** standing rule is sage working-tree mode (`LocalGitBackend`, the-metafactory/sage#106, UPSTREAM); interim is draft-PR-first with offline `sage review` until it lands.
3. **Merge authority** — approver-bot provisioning; branch-protection policy; the sage-verdict-is-not-human-sign-off rule.
4. **Escalation surface** — which Discord server/channel; veto windows; ratifier pinning; digest cadence.
5. **Scout credential ruling** — read-only carve-out vs PAT-first.
6. **Walk-mode opt-in and charting guidance** — `ranger.yaml` schema; how maps get charted walkable; whether orienteer's ChartTheMap gains a "charting for ranger" addendum (upstream to the skill, manual cherry-pick discipline).
7. **Upstream verbs** — `soma graph release`; possibly `close --json`.

Plus research nodes: live cortex build/DORMANT/two-stack state; sage working-tree capability.
