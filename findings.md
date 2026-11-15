# Findings: bounded worker sessions on the Clawbox (node #550)

## Answer in one paragraph

Run each worker pass as a one-shot rootless Podman container built from the
remote-test executor's isolation flags (`isolatedContainerFlags` in
`src/remote-test/executor.ts:135`): non-root user, `--network=none`, all
capabilities dropped, read-only image, cgroup CPU/memory/PID limits. Source
goes in as a verified Git bundle (`src/remote-test/source.ts`), and the
commits come back as a bundle that the Ranger host verifies before its
existing vetted push. The model credential never enters the container. The
container's only way out is a bind-mounted Unix socket to a host-side proxy.
That proxy forwards to exactly one model API host and adds the credential
itself. For `pi` the credential is a per-pass OpenRouter key with a credit
limit; for `codex` it is an OpenAI project API key, not the ChatGPT login.
The container adds seconds to about a minute per pass. The median local pass
takes about 20 minutes, so the overhead is small. Clawbox capacity is the
real limit.

## What a worker can reach today (the problem, as seen in code)

A worker runs as the principal's user, with `workerEnv`
(`src/worker-env.ts:46`). The env allowlist (`src/untrusted-env.ts`) removes
forge tokens and `RANGER_*` secrets, but the filesystem and agent sockets
stay open:

- `HOME` passes, so the worker can read `~/.codex/auth.json` (ChatGPT OAuth
  access and refresh tokens) and `~/.pi/agent/auth.json` (OpenAI OAuth
  tokens and the OpenRouter key). The private key of the checks-only GitHub
  App in `~/.config/ranger/` is mode 0600, but it belongs to the same user,
  so the worker can read it.
- `SSH_AUTH_SOCK` is on the allowlist (`src/untrusted-env.ts:24`). A worker
  can therefore use the principal's SSH agent, and with it any forge that
  accepts that key. That gets around "the worker gets no forge credential".
- Egress is open.

A container closes all three. Nobody has to remember the gaps one by one.

## F1. How the model credential reaches the container, and how its exposure is bounded

**The design rule is that the container never holds a model credential.**
Even with egress limited to the provider, a worker that can read its key can
commit the key into the returned bundle. The supervisor would then push it to
a public repository. A key the container never sees cannot leak that way.

The mechanism uses three parts:

1. The container runs with `--network=none`.
2. The worker's base URL points at `http://127.0.0.1:<port>/v1` inside the
   container. A small Bun bridge (Bun is already in the runtime image)
   forwards that port to a Unix socket bind-mounted from the host.
3. A host-side proxy, owned by the operator and outside the container,
   listens on that socket. It accepts only the configured API paths, adds
   `Authorization`, and forwards over HTTPS to the single configured
   upstream. It also counts requests and bytes for the receipt.

Pi already uses a plain-HTTP local `baseUrl` for its Spark provider
(`~/.pi/agent/models.json`), so this pattern works for `pi` without any
change to Pi itself.

### `pi` (OpenRouter)

- **Credential:** A per-pass OpenRouter key. A management key stays with the
  proxy's operator on the host. It creates a child key with `POST
  /api/v1/keys` and a `limit` set to the pass budget, then deletes it with
  `DELETE /api/v1/keys/{hash}` when the pass ends. Management keys cannot call
  completion endpoints (OpenRouter docs, fetched 2026-11-15).
- **Spend cap:** The child key's `limit`, which is a hard credit limit
  enforced by OpenRouter. The parent account's monthly allowance stays the
  outer cap.
- **Scope:** One pass. The key exists only in the proxy's memory.
- **Rotation:** Each pass gets a new key, so no rotation schedule is needed.
  Only the management key needs periodic rotation, and it never touches a
  worker.
- **Code impact:** `readOpenRouterCredit` (`src/substrate.ts:70`) needs
  `limit_reset: "monthly"` and reads the parent key. It must keep reading the
  parent key. Child keys have no monthly reset and would fail its schema.

### `codex` (OpenAI)

- **Credential:** An OpenAI **project API key**, not the ChatGPT OAuth login
  in `~/.codex/auth.json`. The 2026-11-15 spike was rejected partly because
  of a per-pass device login. An API key removes that step, and OpenAI's
  Codex docs name API keys as "the right default for automation". The same
  docs warn against putting `CODEX_API_KEY` or `OPENAI_API_KEY` in the
  environment of repository-controlled code, which is the case for a worker.
  That warning supports proxy injection.
- **Spend cap:** A dedicated OpenAI project for Ranger workers, with a
  project budget and an allowlist of only the configured model. The proxy
  also enforces a per-pass request and byte ceiling. **Q1:** I have not
  confirmed whether an OpenAI project budget blocks requests or only alerts.
  If it only alerts, the proxy's per-pass ceiling is the hard cap.
- **Scope:** One project, and with the proxy's path allowlist, only the
  Responses endpoint.
- **Rotation:** Scheduled rotation through the OpenAI admin API, or by hand.
  The proxy reloads the key from operator-private configuration. Workers
  never need a restart.
- **Billing change:** API keys bill per token. ChatGPT-plan quota does not
  apply. The quota reader `readCodexQuota` (`src/substrate.ts:185`) reads
  ChatGPT-plan windows, so it does not apply to a container pass. A container
  backend needs its own eligibility signal, either the project budget or the
  proxy's spend counter.
- **Codex's own sandbox:** `workerCommandFor` (`src/substrate.ts:528`) runs
  Codex with `--sandbox workspace-write`, `--add-dir <canonical .git>` and
  the auto-review approval policy. All of that is there to get around
  macOS's seatbelt. Inside a container with all capabilities dropped and
  `no-new-privileges`, Codex's Linux sandbox probably cannot set up its user
  namespaces. The container is already the sandbox, so the container command
  should use `--sandbox danger-full-access` without `--add-dir`. The Codex
  docs limit that mode to controlled environments, and this is one. **Q2:**
  Confirm with a probe that Codex accepts a custom `model_providers` entry
  with an HTTP `base_url` and no key in the container. Otherwise give it a
  placeholder `env_key` that the proxy replaces.

## F2. How egress is limited to the model API, and how that is proven

**Mechanism:** The container has `--network=none`, so it has no network
namespace with a route out. It also gets `--http-proxy=false` and
`--unsetenv-all`, as the executor already sets. The only path out is the
proxy socket. The proxy allows one upstream host per substrate:
`openrouter.ai` for `pi`, and `api.openai.com` for `codex` on an API key.
It allows only that host's API path prefix, refuses everything else, and
does no generic CONNECT tunneling. Do not use the NATS-sidecar pattern
(`--network=container:<sidecar>`) here. A worker that shares a networked
sidecar's namespace would share its egress too.

**Proof, recorded per pass and once per image:**

1. **The executor's checkpoint probes:** The pilot checkpoint already had to
   show network isolation and no host credential or config mounts
   (`docs/remote-test-executor.md`). Reuse those probes with the worker
   flags.
2. **A negative egress probe in the worker image**, run at the start of each
   pass inside the same container. A DNS lookup, a TCP connect to a public
   IP, and an HTTPS request to the forge through the proxy socket must all
   fail. A one-token request to the model through the proxy must succeed. If
   any check gives the wrong result, the pass fails as `infra_failed` before
   the worker starts.
3. **The proxy log on the receipt:** The receipt records the upstream host,
   request count, bytes, and refused-request count. A refused request is
   evidence that the worker tried to reach something else, and the pass is
   flagged.
4. **No credential in the mounts:** The container mounts only the job
   checkout and the proxy socket. `HOME` is `/tmp`. The pass asserts that
   there are no other mounts, as the executor already does for unexpected
   configured mounts.

## F3. What a pass costs in time, compared with a local pass

**Local passes:** These are from the ranger journal (`substrate_sessions`,
`ok` outcomes since 2026-10-15), in minutes, rounded:

| Substrate and kind | n | p50 | p90 |
| --- | --- | --- | --- |
| codex worker | 232 | 23 | 57 |
| codex fix pass | 232 | 19 | 42 |
| pi worker | 60 | 21 | 74 |
| pi fix pass | 77 | 12 | 32 |

**Container overhead per stage:** Measured on the laptop where marked. The
Clawbox numbers are deployment metrics, so they stay in private evidence.

| Stage | Cost | Basis |
| --- | --- | --- |
| Start | Container create and start, cgroup checks, egress probe, child-key mint | The executor's launch time is in private pilot receipts. The key mint is one HTTPS call. Expect seconds; measure in S6. |
| Clone | Bundle create 0.5 s (ranger, 3.4 MB) and 0.4 s (soma, 15 MB); clone from bundle 0.2 s and 0.6 s; checkout 0.1 s and 0.2 s | Measured on the laptop, 2026-11-15. SSH transfer of 3 to 15 MB to the Clawbox comes on top. |
| Dependencies | Offline frozen install from the image's baked cache | This is the reviewed-profile pattern (`docs/remote-test-profiles.md`). A warm local `bun install` took 0.2 to 0.5 s. A cold container install is unmeasured. |
| Worker | The model's time dominates, and it is the same as locally | In-session test runs on 2 cores run slower than on the laptop's 10 cores. With `remoteTests` on, the worker commits and the supervisor tests (`REMOTE_TEST_RULE`, `src/prompt.ts:423`), which avoids that. |
| Return | Bundle of base..head: 0.16 s, 35 KB for 5 commits | Measured on the laptop. Verify and fetch take under a second at that size. |

**Comparison:** Outside the model's time, the overhead is seconds plus
transfer, which is under 5% of a 20-minute median pass. The binding cost is
**capacity**, not latency. The map caps the Clawbox at one job, 2 cores and
1.5 GiB in total, and says existing services and workers keep their
capacity. A worker session holds its lane for 20 to 70 minutes, while a test
job holds it for at most 10. **Q3:** Decide whether worker passes get their
own lane and budget or share the single remote-test lane. Sharing it blocks
remote tests for a whole pass. Also decide whether 1.5 GiB fits a Codex CLI
session plus an in-session `bun test`. S6 measures that.

## F4. How commits return

- **Container side:** The container writes `git bundle create out.bundle
  <base>..HEAD` into the job directory. The container's `.git/config`,
  hooks and other refs never leave.
- **Ranger host side:** Before the existing gates run, the host does the
  following:
  1. It runs `git bundle verify` and requires that the prerequisites equal
     the recorded base.
  2. It fetches into a quarantine ref with `core.hooksPath=/dev/null` and
     `transfer.fsckObjects=true`, using the canonical clone's own config.
  3. It requires that every commit's author and committer equal the machine
     identity that `authorEnv` sets.
  4. It runs the existing checks: `assertResearchFindingsOnly` for research,
     and the implement gates plus `assertGitUntouched` and `vettedPush` for
     everything else.
- **Base-merge passes:** The base-merge prompt runs `git merge origin/<base>`
  (`src/prompt.ts:332`). The source bundle must therefore carry the base tip
  as `refs/remotes/origin/<base>`.

## F5. Seams in Ranger

- **Worker runner:** `WorkerRun` (`ctx.workerRun` at `src/implement.ts:2925`,
  and `workerRun` at `src/worker.ts:1142`) already has an injection seam. A
  container backend replaces the closure, and the gates around it stay as
  they are.
- **Backend choice:** The choice follows the `supervisorTests` local/SSH
  seam (`src/remote-test/supervisor-backend.ts`), per map and opt-in, with
  local as the default.
- **Untouched paths:** Graphical and probe work, the Spark-bound `pi`
  provider, and `claude` sessions stay local. The node's constraints scope
  this lane to `pi` on OpenRouter and to `codex`.

## Slices to file below this node

The research SOP forbids filing nodes, so I list them here for the
supervisor or principal to file:

- **S1 Worker container contract:** A worker job, profile and receipt
  contract that reuses the V1 remote-test identities (commit, tree, image,
  lock), and a reviewed worker image (Bun, Git, the `pi` and `codex` CLIs,
  offline dependency cache). It ships with offline tests.
- **S2 Credential-injecting egress proxy:** A host-side Unix-socket proxy
  with one upstream per substrate, a path allowlist, header injection, and
  per-pass request and byte ceilings. It includes the in-container Bun
  bridge, refused-request accounting on the receipt, and the negative egress
  probe (F2). Offline tests run against a fake upstream.
- **S3 OpenRouter per-pass keys:** Mint a key with `limit` and delete it at
  pass end, including deletion on crash recovery. This requires a fenced
  ledger row so an orphaned key is always found. The quota reader keeps
  reading the parent key.
- **S4 Codex in a container:** A container variant of `workerCommandFor`
  (`danger-full-access`, a custom provider pointed at the bridge) and an
  eligibility signal from the project budget or the proxy's spend counter,
  in place of ChatGPT-plan windows. It settles Q1 and Q2 with probes.
- **S5 Return bundle and host verification:** F4, plus a container
  `WorkerRun` backend behind a per-map opt-in, local by default.
- **S6 Operator checkpoint for the pilot:** Provision the worker lane, prove
  F2's probes live, and measure F3's per-stage costs and memory peak against
  the 1.5 GiB cap. It settles Q3. This needs principal approval for live
  provisioning and credential issuance.

Order: S1 and S2 first (S2 does not depend on S1), then S3 and S4 in
parallel, then S5, then S6.

## Open questions for the principal

- **Q1:** Does an OpenAI project budget block requests or only alert? This
  decides whether the proxy ceiling is the only hard cap for `codex`.
- **Q2:** Does Codex run against a keyless custom provider at an HTTP base
  URL? Settle it with a probe in S4.
- **Q3:** Should worker passes get their own Clawbox lane and budget, or
  share the one remote-test lane?
- **Q4:** Should `SSH_AUTH_SOCK` leave the worker allowlist for local
  workers now (`src/untrusted-env.ts:24`)? The container does not need it,
  and on the laptop it gives workers the principal's SSH agent. This is
  outside this node's scope and can be filed as a separate node.
