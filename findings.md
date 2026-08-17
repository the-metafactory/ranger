# Ranger tick operational readiness — inventory of the walker's live surface

Node [#19](https://github.com/the-metafactory/ranger/issues/19) · map root #1 · research, read-only.
Surveyed 2026-08-17 on `fischer@darwin 25.5.0` under the machine account (`ivy-agent`).

**What this answers.** The claim+research lane is shipped and fixture-proven (main `1c09b79`, node #13).
The launchd tick is live and green. But the tick runs `scout`, not `walk` — and swapping that one
argument is *not* sufficient. Six surfaces were inventoried; four carry real gaps, two are clean.
The blocking gaps are a **three-tree split** (the tick executes uncommitted code from a different
checkout than the one its probes validate), a **stale-`origin/main` worker path**, a
**non-idempotent worktree bootstrap** that hard-fails on retry, and a **close gate that runs from
the tree it is meant to guard**.

Everything below was probed this session. `file:line` references are to the committed tree at
`1c09b79` (this worktree) unless stated otherwise; where the running code differs, that is called out.

**Disclosure.** Two reads had side effects worth naming, neither in scope-forbidden territory:
`git fetch origin` in this worktree advanced the *shared* `origin/main` ref of the canonical checkout
(§5 reasons about the pre-fetch state, which is independently pinned by the worktree's own commit),
and one `gh api user` authenticated as `ivy-agent` to confirm the write credential (§2). No config,
plist, wrapper, graph node, or branch other than `research/walker-readiness-inventory` was touched.

---

## 1. Launchd tick — `~/Library/LaunchAgents/ch.invisible.ranger-tick.plist`

**What exists.** Loaded and healthy in `gui/503`:

| Property | Value |
|---|---|
| Label | `ch.invisible.ranger-tick` |
| Command | `/Users/fischer/bin/ranger scout --config /Users/fischer/work/mf/ranger/ranger.yaml` |
| `StartInterval` | `900` (15 min) |
| `RunAtLoad` | `false` |
| stdout | `/Users/fischer/.config/ranger/logs/scout.stdout.log` |
| stderr | `/Users/fischer/.config/ranger/logs/scout.stderr.log` |
| `PATH` | `/Users/fischer/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` |
| Observed | `runs = 73`, `last exit code = 0`, `state = not running` (between ticks) |

`launchctl list` shows `- 0 ch.invisible.ranger-tick`. 73 clean runs at exit 0, and
`src/cli.ts:287` exits 2 if any map fails — so **the read path is proven live**, not just fixture-proven.

**What the walker requires.** `ranger walk` in `ProgramArguments` instead of `scout`, pointed at a
config whose target map has `walk: research-only|full` (`src/walk.ts:111`).

**Gaps.**

- **G1 — the tick runs `scout`, never `walk`.** This is the headline gap and the only *intended* one.
  The plist's own comment anticipates it: *"The full walker tick (node #13) reuses this plist,
  swapping the command to `ranger tick`."* Note the verb drift — the shipped CLI has no `tick`
  subcommand; the commands are `scout`, `walk`, `run-node`, `sweep`, `journal` (`src/cli.ts:273-363`).
  The correct swap is `walk`.
- **G2 — the config path points at a third tree.** `/Users/fischer/work/mf/ranger/ranger.yaml` is
  the *dev* checkout, not the canonical checkout the probe registry validates. See §5/G8.
- **G3 — no log rotation.** `scout.stdout.log` is 199 555 B after 73 appends (~2.7 KB/run) with no
  `newsyslog`/`logrotate` entry (`grep` over `/etc/newsyslog.conf` and `/etc/newsyslog.d/`: none).
  At 96 ticks/day this is ~260 KB/day, unbounded. A `walk` tick emits a JSON result blob per pass,
  so the rate will change but the unboundedness will not. Low severity, trivially fixed, but it will
  silently eat disk on a continuous walk.
- **Not a gap:** `RunAtLoad false` with `StartInterval 900` is correct — the agent fires within 15
  min of load/boot and does not stampede at login.

---

## 2. Token-injecting wrapper — `~/bin/ranger`

**What exists.** A `set -euo pipefail` bash shim that resolves credentials from durable local stores,
exports them, and `exec`s `bun /Users/fischer/work/mf/ranger/src/cli.ts "$@"`.

| Env var exported | Source | Present? |
|---|---|---|
| `GH_TOKEN` | keychain `ivy-agent` | ✅ |
| `RANGER_WRITE_GH_TOKEN_METAFACTORY` | keychain `ivy-agent` | ✅ |
| `RANGER_WRITE_GH_TOKEN_PERSONAL` | keychain `ivy-agent` | ✅ |
| `RANGER_READONLY_GH_TOKEN_METAFACTORY` | keychain `ranger-ro-metafactory` | ✅ |
| `RANGER_READONLY_GH_TOKEN_PERSONAL` | keychain `ranger-ro-personal` | ✅ |
| `RANGER_DISCORD_TOKEN` | `~/.config/grove/bot.env` → `DISCORD_BOT_TOKEN` | ✅ |
| `GH_CONFIG_DIR` | `~/.config/ranger/gh-config` (created) | ✅ (dir empty — no `hosts.yml`) |

All three keychain services are present. `~/.config/grove/bot.env` contains exactly
`DISCORD_BOT_TOKEN=…`, which is the key the wrapper greps for. No token is inlined anywhere.

**Does it cover the walker's write-token env names?** **Yes.** `ranger.yaml`'s `auth.writeTokens`
maps `the-metafactory/*` → `RANGER_WRITE_GH_TOKEN_METAFACTORY` and `jcfischer/*` →
`RANGER_WRITE_GH_TOKEN_PERSONAL`, and the wrapper exports both from the single `ivy-agent` classic
PAT. `resolveWriteToken` (`src/identity.ts:34-54`) does longest-prefix matching over exactly those
keys. **This surface is ready.**

**Credential verified live.** `gh api user` under the `ivy-agent` keychain token returns
`login: ivy-agent`, `X-Oauth-Scopes: repo` — a classic `repo`-scoped PAT for the machine account,
exactly as the map's amended node-#11 constraint requires.

**Gap.**

- **G4 — the principal-refusal gate trusts a config label, not the credential.**
  `resolveBotIdentity` (`src/identity.ts:130-138`) returns `config.bot.identity` verbatim when set,
  and only falls back to `loginForToken` when it is absent. The shipped `ranger.yaml` sets
  `bot.identity: ivy-agent`. `assertNotPrincipal` (`src/identity.ts:145-156`) then compares *that
  string* against `config.principal.login`. So the token's actual login is **never resolved** on the
  configured path: if the `ivy-agent` keychain entry were ever replaced with the principal's PAT, the
  gate would compare `"ivy-agent" != "jcfischer"`, pass, and every graph write would run under the
  principal's credential while labelled `ivy-agent` — the exact thing the map's binding constraint
  forbids. **Today this is latent, not live** (verified above: the token really is `ivy-agent`), but
  the invariant is asserted on a label the config author controls rather than on the credential.
  A `loginForToken` cross-check when `bot.identity` is set would close it and costs one `gh api user`
  per map per tick.

---

## 3. Config — `ranger.yaml` / `ranger.example.yaml`

**Three divergent copies exist on this host.** This is the root of several gaps below:

| Tree | Path | `ranger.yaml` version | `walk` (ranger map) | `auth.writeTokens` | `bot.identity` |
|---|---|---|---|---|---|
| **dev** (tick reads this) | `/Users/fischer/work/mf/ranger` | `ea27be4` (2448 B) | `research-only` | ✅ present | ✅ `ivy-agent` |
| **canonical** (probes run here) | `~/work/ranger-repos/the-metafactory/ranger` | `1c09b79` (1553 B) | `none` | ❌ absent | ❌ absent |
| **this worktree** | `…/.worktrees/node-19` | `1c09b79` (1553 B) | `none` | ❌ absent | ❌ absent |

`origin/main` is `ea27be4` — *"feat(config): opt the ranger map into `walk: research-only` +
machine-account write tokens (map node #18)"* — a config-only commit (`ranger.yaml | 18 +++-`,
1 file). The **shipped/committed reference is therefore `ea27be4`'s `ranger.yaml`**, which the
dev tree happens to hold clean at HEAD:

- `maps[0]` = `the-metafactory/ranger`, root 1, **`walk: research-only`**, Discord `#soma`
  channel `1505550997764833444`, `tokenEnv: RANGER_DISCORD_TOKEN`.
- `maps[1]` = `jcfischer/seekolous`, root 26, **`walk: none`**, Discord channel `1487052222067118111`.
- `auth.readOnlyTokens` + **`auth.writeTokens`** both mapped for `the-metafactory/*` and `jcfischer/*`.
- `bot.identity: ivy-agent`.

**Omitted-but-defaulted sections are fine.** The shipped `ranger.yaml` has no `principal:`, `state:`,
or `workers:` block, but every one is `.default({})` in the Zod schema with populated field defaults
(`src/config.ts:84-115`), so the effective config is:
`principal.login = "jcfischer"` (`config.ts:86` — **the refusal gate is armed despite the missing
key**), `state.journalPath = ~/.config/ranger/state.sqlite`, `state.canonicalRoot = ~/work/ranger-repos`,
`workers = {spawnCapPerDay: 10, wallClockMin: 90, maxAttempts: 2, deadmanThreshold: 3}`.
These match the live artefacts observed in §5/§6. **No gap here** — worth stating because an absent
`principal:` key looks alarming and is not.

`ranger.example.yaml` is the fuller annotated template (documents all seven sections plus the
`security add-generic-password` provisioning recipes and the fine-grained-PAT hard limit).
It is documentation-accurate against the schema.

**Gap.**

- **G5 — the canonical checkout's config would refuse to walk.** Its `ranger.yaml` is the pre-#18
  copy: `walk: none` on both maps and **no `auth.writeTokens` at all**. Anyone running
  `ranger walk` from the canonical checkout gets `walk: none — this map is registered, not walked`
  (`src/walk.ts:113`), or, had the walk mode been set, a hard `WriteGateError: no write-token mapping`
  (`src/identity.ts:41`). The tick currently dodges this only because it points at the dev tree (G2).

---

## 4. Walker CLI surface — `src/cli.ts`

Five commands, all taking `-c, --config <path>` defaulting to `./ranger.yaml`
(`src/cli.ts:278`, `301`, `319`, `335`, `352` — note the default is **cwd-relative** via
`resolve(process.cwd(), …)`, so a launchd-invoked tick must pass an absolute path, which the plist does).

| Command | Requires | Writes graph? | Exit codes |
|---|---|---|---|
| `scout` | config; read-only PAT per map (`assertReadOnlyToken`, no keyring fallback) | no | 0 ok / 2 any map failed / 1 throw |
| `walk` | config + journal; **write token + non-principal identity + `walk != none`**; Discord token (announce is fail-closed); probe registry | **yes** (claim, then sweep) | 0 / 1 |
| `run-node <id>` | as `walk`, plus `--map` when >1 map registered; canonical checkout; `claude` on PATH; `soma` on PATH | **yes** (close, decisions) | 0 / **2 on `WriteGateError`** / 1 |
| `sweep` | config + journal + write token per walked map | **yes** (`graph release` on park) | 0 / 1 |
| `journal` | config + journal only — no token, no network | no | 0 / 1 |

**Tick-relevant mechanics, verified in code:**

- **Gate order in `walk`** (`src/walk.ts:110-138`): walk-mode → write token → `resolveBotIdentity` →
  `assertNotPrincipal` → dead-man pause. A paused journal still runs `sweepMap` (`walk.ts:209`) —
  correct liveness behaviour.
- **Announce is genuinely fail-closed** (`src/announce.ts:71-106`): any fetch error, non-2xx, or
  missing message id throws, and `walk.ts:170-173` turns that into "claim refused". There is **no
  veto window** — `announce.ts:6-11` documents that node #13's "60s veto" wording predates the node
  #7 ruling and is deliberately not implemented. Config and code agree.
- **Spawn cap is checked before each claim** (`walk.ts:150`) against `journal.spawnsToday()`.
- **`run-node` is spawned detached** (`walk.ts:57-72`) with `--map` always passed, so the multi-map
  `pickMap` requirement (`cli.ts:252-255`) is satisfied automatically. `RANGER_NO_SPAWN=1` is a
  claim-without-spawn seam — **not set** in the wrapper or plist, so a real walk will spawn.
- **`cliEntry` is self-referential**: `join(import.meta.dir, "cli.ts")` (`walk.ts:96`). The worker is
  launched from *whatever tree the tick is running from*. This is what makes G8 propagate.
- **Worker command defaults to `["claude", "-p"]`** (`src/worker.ts:158-162`), overridable via
  `RANGER_WORKER_CMD` (not set), bounded by `wallClockMin` × 60 000 ms as a `SIGKILL` timeout
  (`worker.ts:233`, `exec.ts:43-45`).
- **The close is receipt-gated and refuses to be hollow**: no `findings.md` → refuse to close
  (`worker.ts:272-277`); `graph close` failure → `parked` + dead-man bump (`worker.ts:310-323`).
  Only after a confirmed close does it run `graph decisions --write` (`worker.ts:293`).
- **Graph verbs are the only mutation surface** (`src/graph-write.ts:79,104,136,160`):
  `graph claim`, `graph release`, `graph close`, `graph decisions --write`. No raw tracker writes —
  the map's binding constraint holds.

**Gaps.**

- **G6 — `run-node` cannot recover once a worktree branch outlives its directory.** See §5/G7 —
  this is a CLI-path defect but its evidence is in the journal, so it is documented there.
- **G7 — worker `claude` differs from interactive `claude`.** Under the plist's `PATH`,
  `claude` resolves to `/opt/homebrew/bin/claude` = **2.1.107**; the login shell resolves
  `/Users/fischer/.local/bin/claude` = **2.1.233**. A continuous tick would silently execute every
  research node on a 126-patch-older binary than the one the work was designed and tested against.
  Fix is one line: `RANGER_WORKER_CMD` in the wrapper, or reorder the plist `PATH`.

---

## 5. Canonical checkouts — `~/work/ranger-repos/`

Both walked repos have a complete checkout. `canonicalDir` (`src/worker.ts:51-55`) resolves
`<state.canonicalRoot>/<repo>`, i.e. exactly these paths:

| Repo | Path | `.git` | Branch | HEAD | Remote |
|---|---|---|---|---|---|
| `the-metafactory/ranger` | `~/work/ranger-repos/the-metafactory/ranger` | ✅ dir | `main` | `1c09b79` | `https://github.com/the-metafactory/ranger.git` |
| `jcfischer/seekolous` | `~/work/ranger-repos/jcfischer/seekolous` | ✅ dir | `main` | `c022ae6` | `https://github.com/jcfischer/seekolous.git` |

Both clones are complete and on `main`. `seekolous` is clean; the ranger canonical shows only
untracked `.worktrees/` (this session's worktree — expected, and `.gitignore` does not cover it).

The probe registry (`~/.soma/policy/probe-registry.json`) authorises exactly this checkout for the
ranger map — `bun test` and `bunx tsc --noEmit` with
`cwd: /Users/fischer/work/ranger-repos/the-metafactory/ranger`. Design §4 (probes run in the
canonical checkout) is satisfied. `jcfischer/seekolous` has **no** registry entry, so any
probe-declaring auto node on that map routes to `provisioning` rather than being walked — correct
fail-closed behaviour, and the adopter's hand to widen (map constraint).

**Gaps.**

- **G8 — the tick does not run the canonical checkout, and what it does run is uncommitted.**
  Three trees hold ranger code:
  - `/Users/fischer/work/mf/ranger` — **what `~/bin/ranger` executes.** HEAD = `origin/main` =
    `ea27be4`, but **14 files are modified: `+588 / −219`**, including `src/worker.ts` (+207/−…),
    `src/journal.ts`, `src/walk.ts`, `src/cli.ts`, `src/graph-write.ts`, `src/announce.ts`,
    `src/sweep.ts`, and 5 test files.
  - `~/work/ranger-repos/the-metafactory/ranger` — **what the probe registry tests.** Clean, at
    `1c09b79` — one commit behind.
  - this worktree — cut from the canonical, also `1c09b79`.

  So the code that would walk the map is **neither committed nor the code the close gate's probes
  validate**. `bun test` passing in the canonical checkout says nothing about the tick's behaviour,
  and `walk.ts:96` guarantees the drift propagates into every spawned worker. This is the single
  largest gap: it makes the walk unreproducible and the probe evidence non-binding.

- **G9 — the worker path never fetches, so worktrees are cut from a stale `origin/main`.**
  `bootstrapCanonical` (`src/worker.ts:106-125`) returns early whenever `<dir>/.git` exists — there
  is **no `git fetch` anywhere in the worker path** — and `bootstrapWorktree` then branches off
  `origin/main` (`worker.ts:147`). `origin/main` therefore only advances if something *else* fetches.
  **Evidence: this very worktree.** `git worktree list` shows
  `node/19-…` at `1c09b79` while the true remote head is `ea27be4`; since `worktree add -b <branch>
  origin/main` pins the branch to `origin/main` at creation time, `origin/main` was `1c09b79` when
  the supervisor ran. Concretely: node #19's worker was handed a tree **predating the node-#18 config
  commit**, which is why this worktree's `ranger.yaml` has `walk: none` and no `writeTokens` (§3).
  A continuously-walking tick would drift further from `main` with every merge.
  (My `git fetch` this session has since advanced the shared `origin/main` to `ea27be4`; the
  canonical's *`main`* is still `1c09b79`. The pre-fetch state is pinned by the worktree's commit above.)

- **G10 — worktree bootstrap is not idempotent: a surviving branch permanently blocks the node.**
  `bootstrapWorktree` (`worker.ts:135-156`) adopts only on `existsSync(dir)`. It never checks whether
  the *branch* exists, so `git worktree add <dir> -b node/<N>-<slug> origin/main` fails hard when the
  directory is gone but the branch remains — which is exactly what `git worktree prune`, a manual
  `rm -rf`, or a partially-cleaned crash leaves behind. **Observed twice, 20 minutes apart**
  (journal events 9 and 11):

  ```
  cannot add worktree for node 19 (exit 255): Preparing worktree (new branch 'node/19-research-…')
  fatal: a branch named 'node/19-research-ranger-tick-operational-readiness-inven' already exists
  ```

  There is no recovery path: `maxAttempts` respawns hit the identical failure, the node is parked and
  released, re-enters the frontier, is re-announced and re-claimed, and fails again — burning a
  Discord announce, a claim/release cycle, and a spawn-cap slot per pass. On a 15-minute continuous
  tick this is a **claim-churn loop**, and each failure bumps the dead-man counter, so it will
  eventually pause the walker for reasons unrelated to the node's actual work. The fix is small
  (`-B` instead of `-b`, or check `git rev-parse --verify` for the branch and adopt/reset it).

---

## 6. Journal + logs — `~/.config/ranger/`

**`state.sqlite` exists** (4 KB + 32 KB `-shm` + 250 KB `-wal`) at exactly the configured default
`~/.config/ranger/state.sqlite`. Schema matches `src/store/schema.ts` and is migrated
(`__drizzle_migrations`: 1 row).

| Table | Rows | Contents |
|---|---|---|
| `workers` | 1 | node 19 |
| `events` | 15 | today's three claim cycles |
| `health` | 2 | `spawns.2026-08-17 = 3`, `deadman.count = 0` |
| `vetoes` | 0 | — |

**The journal shows three real end-to-end attempts on node #19 today** — the walker has genuinely
run under `ivy-agent` against the live graph, not just fixtures:

| # | Time (UTC) | Events | Outcome |
|---|---|---|---|
| 1 | 07:48:04 → 08:03:12 | announced `1538816670859010168` → claimed by `ivy-agent` → worker-start → worktree created → **refused** | close gate refused: `git-ref-exists:research/walker-readiness-inventory` probe failed (branch not yet pushed — the work itself was incomplete) |
| 2 | 08:13:11 → 08:13:17 | announced `1538822992229048382` → claimed → worker-start → **refused in 6 s** | G10 branch collision |
| 3 | 08:34:37 | worker-start → **refused in 39 ms** | G10 branch collision (sweep respawn, no announce) |
| 4 | 08:37:58 → | announced `1538829227682701342` → claimed → worker-start → worktree adopted | in flight (this session) |

Confirmed working from this: the announce→claim→spawn→worktree chain, `graph claim` under
`ivy-agent`, receipt-gated close refusal, the dead-man counter (reset to 0 on the successful worker),
and the spawn ledger (3 of 10 today).

**Log tails.** `scout.stderr.log` is **0 bytes** across 73 runs — no failures at all.
`scout.stdout.log` tails show consistent healthy digests: `identity: jcfischer (fine-grained)`
(the node-#8 read-only carve-out, working as ruled), `the-metafactory/ranger (root 1, walk:
research-only)` — **confirming the tick reads the post-#18 dev-tree config** — `receipt-less closes: 0`,
`open w/o checkpoint: 0`, `clean ✓` on both maps, and the seekolous map correctly reporting 6 HITL
`propose/approve` grilling nodes it must escalate rather than walk.

**Gaps.**

- **G11 — a re-claimed worker row keeps a previous attempt's outcome.** The live row is internally
  inconsistent: `status = running`, `pid = 60435`, `started_at = 08:38:05`, but
  **`finished_at = 08:03:12` — 35 minutes *before* it started** — with `outcome` still holding attempt
  1's close-gate refusal text. Cause: `upsertWorker`'s conflict branch (`src/journal.ts:85-98`) sets
  `finishedAt: row.finishedAt` and `outcome: row.outcome` **without** the `?? null` coalescing its
  own insert branch uses (`journal.ts:81-82`); Drizzle omits `undefined` keys from the `SET` clause,
  so the stale values survive a re-claim. `worker.ts:205-214` never passes either field, so every
  re-attempt inherits them. Consequence: `ranger journal` and any digest built on `workers` will
  report a stale failure against a healthy in-flight worker, and a stale success would be worse.
  Related and smaller: `worker.ts:245-254` re-stamps `startedAt` with `new Date()` *after* the worker
  returns, so `started_at` records the worker's *end*. `src/journal.ts` is one of the 14 files
  modified in the dev tree (+86/−…), so this may already be addressed in the running code — but it is
  live in the committed tree at `1c09b79`, and the observed row proves it is live in whatever ran today.
- **G12 — `scout.stdout.log` is a single append-only file** shared with the future `walk` output
  (§1/G3). A `walk` tick's JSON blobs interleaved into a 200 KB-and-growing scout log make the one
  artefact a human would reach for during an incident the hardest one to read.

**Clean surfaces (no gap):** `GH_CONFIG_DIR` isolation holds — `~/.config/ranger/gh-config` is
**empty**, no `hosts.yml`, so `gh` cannot reach the principal's write-capable keyring and must use
the injected `GH_TOKEN` (the node-#8 invariant, mechanically true). The read-only gate additionally
introspects classic tokens for write scopes and aborts (`src/token-gate.ts:18`).

---

## Ranked gap list — what a human must change before the tick can walk continuously

Most blocking first. G1 is the *stated* gap; G8–G10 are the ones that would make G1 fail in practice.

| # | Gap | Surface | Severity | Why it blocks |
|---|---|---|---|---|
| **1** | **G8 — three-tree split; the tick executes 14 uncommitted files (+588/−219)** | §5 | **Blocking** | The walking code is neither committed nor the code the probe registry tests. Walks are unreproducible, probe evidence is non-binding, and `walk.ts:96` pushes the drift into every worker. **Decide one tree** — land the dev-tree work on `main`, then point `~/bin/ranger`'s `RANGER_CLI` *and* the plist `--config` at the canonical checkout the probe registry already authorises. |
| **2** | **G10 — worktree bootstrap hard-fails when a branch outlives its directory** | §5 | **Blocking** | Observed twice today. Unrecoverable by design: every respawn/re-claim repeats it, burning an announce + claim + spawn slot and bumping the dead-man counter each pass. On a 15-min tick this is a claim-churn loop that eventually pauses the walker. Use `-B`, or verify the branch and adopt it. |
| **3** | **G9 — no `git fetch` in the worker path; worktrees cut from stale `origin/main`** | §5 | **Blocking** | Proven by this worktree: node #19 got a tree predating the config commit that authorises walking it. Unbounded drift on a continuous tick. Add a fetch to `bootstrapCanonical` (or fetch per tick before claiming). |
| **4** | **G1 — the plist runs `scout`, not `walk`** | §1 | **Blocking (trivial)** | The intended one-argument change. Note the plist comment says `ranger tick`; the real subcommand is `walk`. Do this *after* 1–3, or the first live tick reproduces G10. |
| **5** | **G4 — principal-refusal gate asserts on a config label, not the credential** | §2 | **High (latent)** | With `bot.identity` set, the token's login is never resolved, so a swapped keychain entry would let writes run under the principal's credential while labelled `ivy-agent` — defeating the map's binding constraint. Currently correct (token verified = `ivy-agent`, scope `repo`), but the invariant is only as good as the config author. Cross-check with `loginForToken` when `bot.identity` is set. |
| **6** | **G5 — the canonical checkout's `ranger.yaml` is pre-#18** (`walk: none`, no `writeTokens`) | §3 | **High** | Falls out of fix 1: the moment the tick points at the canonical tree, the config must be the `ea27be4` one or the walk gates itself off (`walk.ts:113`) or `WriteGateError`s (`identity.ts:41`). Resolved by fixes 1+3 together. |
| **7** | **G7 — worker `claude` is 2.1.107 under the plist `PATH` vs 2.1.233 interactively** | §4 | **Medium** | Every research node would silently run on an older binary than the work was designed against. One line: set `RANGER_WORKER_CMD`, or reorder the plist `PATH`. |
| **8** | **G11 — re-claimed worker rows retain a prior attempt's `finished_at`/`outcome`** | §6 | **Medium** | Live row shows `finished_at` 35 min before `started_at` with a stale refusal. Corrupts the operational surface a human reads during an incident. Add `?? null` in the conflict branch (`journal.ts:94-95`); also stop re-stamping `startedAt` at `worker.ts:252`. |
| **9** | **G2 — plist `--config` points at the dev tree** | §1 | **Medium** | Subsumed by fix 1; listed separately because it is the concrete line to edit. |
| **10** | **G3/G12 — no log rotation; `walk` output would interleave into the 200 KB scout log** | §1, §6 | **Low** | ~260 KB/day unbounded. Split `walk` to its own log path and add a `newsyslog.d` entry. |

**Not gaps — verified ready:** the wrapper's credential coverage including both `writeTokens` env
names (§2); all three keychain services and the Discord token (§2); the `ivy-agent` classic `repo`
PAT (§2); `GH_CONFIG_DIR` keyring isolation (§6); schema defaults arming `principal.login` despite
the absent key (§3); both canonical clones complete and on `main` (§5); the probe-registry entry for
the ranger canonical checkout (§5); the migrated journal (§6); and the read path itself — 73 launchd
ticks, 0 bytes of stderr, `clean ✓` on both maps (§1, §6).

**Bottom line.** Nothing in the credential, identity, or graph-verb layer blocks a continuous walk —
that surface is provisioned and live, and the journal proves the announce→claim→worker→gated-close
chain has already run end-to-end under `ivy-agent` against the real graph. What blocks it is
**checkout hygiene**: which tree runs, whether it is committed, and whether it is up to date. Fix
G8/G9/G10 — one tree, fetched, with an idempotent worktree bootstrap — and G1 becomes the
one-argument change the plist comment always intended.
