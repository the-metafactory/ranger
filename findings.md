# soma's GitLab work-graph backend against gitlab.software.geant.org

Research node #93, map the-metafactory/ranger. Checkpoint: `soma-gitlab-backend-surveyed`.

**Sources.** The soma source is `origin/main` at `1e6e5d4`, the same code as the installed `soma 0.23.1`. Line numbers point at that tree (`src/work-graph-gitlab.ts`, `src/work-graph.ts`, `src/cli/graph.ts`, `src/work-graph-bridge.ts`, `src/work-graph-attestation.ts`). The GitLab store landed in three commits: #698, #700 and #702.

**Live checks.** On 2026-10-06, against `gitlab.software.geant.org`. They ran read-only through `glab`, under the principal's own glab credential (`jens-christian.fischer`), because no bot token exists yet. Every GraphQL call was a `query`. There were no mutations and no REST writes, and nothing on the host changed.

## TL;DR

| ID | Finding |
|---|---|
| F1 | The instance is **GitLab CE 19.4.1** (`/api/v4/version` → `"enterprise": false`). The `claw` group and `claw/crisis-simulator` offer the work-item types Issue, Task, Incident and Ticket. **There is no Epic type.** |
| F2 | **`chart` cannot work there.** A GitLab root is always an Epic, and the Epic type lookup throws on `claw`. Fixing that needs a paid tier, which is an instance-admin or licensing change and out of bounds. |
| F3 | The read verbs **`node`, `frontier`, `audit` and `decisions` (without `--write`) work live** on crisis-simulator issues. |
| F4 | On this tier the only hierarchy is **Issue → Task**, and an Issue can have **no parent**. #60, #61, #62 and #33 are typed Issues, so they can never sit under a map root here. soma also has no verb that attaches an existing node to a parent. |
| F5 | `close` on an `auto` node takes **any non-empty `--ci <a>@<b>`** on GitLab. The core checks only that both strings are non-empty. The GitLab store saves them and never checks a pipeline or job. GitLab has no equivalent of the GitHub check-run verification. |
| F6 | Auth goes through **glab config only**. soma strips `GITLAB_TOKEN`, `GLAB_TOKEN` and the other token variables from glab's environment. The one way to pin a read-only token is a dedicated `GLAB_CONFIG_DIR`. |
| F7 | A claim identity has to equal `GET /user` for the token in use, so the walker claims as the project bot (`project_<id>_bot_<hex>`). Nobody has tested whether that bot can be assigned to an issue, because that test is a write. |
| F8 | Blocking edges (`add --blocked-by`) need the GitLab **Premium** "blocks / is blocked by" link. On CE that write path is expected to fail. |
| F9 | soma's confinement check always tests the **default** glab `config.yml` path, even when the walker has pinned `GLAB_CONFIG_DIR`. On the principal's Mac that path is where glab finds the principal's GÉANT login (live `glab auth status`). So GitLab close receipts are expected to record `unverified` attestation, which is recorded, not enforced. |

## 1. Verb support

Every verb dispatches to the store from `createGraphStore` (`work-graph-bridge.ts`). For `forge === "gitlab"` that is `createGitLabGraphStore({ host })`. The store is scoped to a host, not a project. Refs take the form `gitlab:<host>/<group>/<project>#<iid>`, or `gitlab:<host>/<group>&<iid>` for an Epic (`work-graph-ref.ts:9-17`, `:181-184`).

| Verb | Status on GÉANT | Basis |
|---|---|---|
| `node` | **works (live)** | `soma graph node gitlab:gitlab.software.geant.org/claw/crisis-simulator#60 --json` returned `typed: true`, `kind: build`, `checkpointId: claw-article-world-language`, `autonomy: approve`, `trackerType: Issue`. |
| `frontier` | **works (live)** on an Issue root | `soma graph frontier …#33` exited 0 and reported `- none`, because #33 has no children. Reads go through the GraphQL `workItem` hierarchy widget (`work-graph-gitlab.ts:296-297`). |
| `audit` | **works (live)** | `soma graph audit …#33` → "Clean". |
| `decisions` (read) | **works (live)** | `soma graph decisions …#33` → "none yet". |
| `decisions --write` | source only | Splices the root body through `writeRawBody`, which is REST `PUT projects/:id/issues/:iid` for an Issue root (`:336`). Not run, because it is a write. |
| `claim` / `release` | source only | `requireActingIdentity` (`:298-301`), then `issueSetAssignees` APPEND or REMOVE, then a re-read and `resolveClaimRace` (`:302-304`). An Epic cannot be claimed (`:304`). |
| `add` | source only, constrained | Creates a child work item (`:264-292`). Below an Epic it creates an Issue. Below an Issue it creates a **Task**. Below a Task it re-homes to the nearest Issue ancestor and adds a `RELATED` link (`:295`, `work-graph.ts:1450-1457`). **`--label` is refused** (`:265`). `--blocked-by` → F8. |
| `chart` | **blocked on this instance** | → §2. |
| `close` | source only | Posts the receipt as an issue note, writes the completion into the node block, and closes with `state_event: close` (`:337`). CI → §3. |

### What follows for a map on CE

- **Membership is one level deep.** No verb creates an Issue root (§2). If a root Issue were typed by hand, every map node would be a Task directly below it: Tasks take no children, so `add` below a Task re-homes to the root.
- **A map tops out at 100 nodes.** The subtree read asks for `children(first:100)` and refuses when `hasNextPage` is true (`:222`, `:296`).
- None of this flat-map shape was exercised by a write. The source says it should work; nothing here shows that it does.

## 2. `chart` and Epics

- **The source.** A node with no parent becomes an Epic in the home project's group. `createNode` calls `workItemTypeId(group, "Epic")` (`:279`). That lookup throws `GitLab namespace <group> has no Epic work-item type` when the type is missing (`:255`). There is no other root shape: `chart` without `--home-project` is refused (`:275`), and the root is always the Epic.
- **The live answer.** `namespace(fullPath:"claw"){workItemTypes}` returns Incident, Issue, Task and Ticket, with no Epic. `project(fullPath:"claw/crisis-simulator")` returns the same four.
- **Allowed hierarchy (live).** From `widgetDefinitions`:
  - Issue: children `[Task]`, parents `[]`
  - Task: children `[]`, parents `[Incident, Issue, Ticket]`
  - Incident and Ticket: children `[Task]`
- **Verdict.** `soma graph chart` will fail on `claw/crisis-simulator`. Epics are a paid-tier feature, and the instance is CE. A licence change is an instance-admin change, which the map's constraints rule out. A GitLab map here needs a non-Epic root, which in turn needs a soma change:
  - O1: `chart` falls back to an Issue root when the group has no Epic type, giving the flat Issue → Task map described in §1.
  - O2: a verb that types an existing Issue as a root.

## 3. CI citation on `close` for `auto` nodes

- **The core gate.** It refuses an `auto` close unless `receipt.ci.checkRunId` and `receipt.ci.headSha` are both non-empty (`work-graph.ts:1175-1184`). The CLI flag is `--ci <checkRunId>@<headSha>`, split at `@` (`cli/graph.ts:106`, `:426-432`).
- **The GitLab store.** It copies the two strings into `completion.ciCheckRunId` and `completion.ciHeadSha` (`:337`) and never looks them up.
- **The GitHub store, for comparison.** It verifies the same fields live when it reads a closed node:
  - `readNode` → `hasCurrentCloseReceipt` → `fetchCheckRun`, which requires `conclusion === "success"` and a matching `head_sha` (`work-graph-github.ts:692-698`, `:1027-1047`).
  - The GitLab `readNode` (`:263`) does rebuild `completion`, CI strings included, from the persisted node block (`withPersistedCompletion`, `:191-195`). It never sets `currentCloseReceipt`, though: only the GitHub store does (`work-graph-github.ts:697-698`). So `readNodeForBridge` reports `hasCloseReceipt: false` for every closed GitLab node (`work-graph-bridge.ts:312`).
- **Verdict.** Not supported yet. Any `x@y` passes the GitLab close, and nothing later checks it. soma has not decided what identifier GitLab should cite:
  - **pipeline:** `GET projects/:id/pipelines/:pipeline_id` → `status`, `sha`, `source`;
  - **job:** `GET projects/:id/jobs/:job_id` → `status`, `pipeline.sha`.
- **The forgery premise does not carry over unchanged.** soma's argument for CI evidence is that only a GitHub App can mint a check-run `success` (`work-graph.ts:451-461`). GitLab's commit-status API (`POST projects/:id/statuses/:sha`) accepts `state: success`. When no pipeline exists, it creates one with `CI_PIPELINE_SOURCE: external` (GitLab docs, Commits API).
  - Any GitLab verifier should therefore at least refuse pipelines whose `source` is `external`.
  - The role that may post commit statuses was not confirmed this session. To verify.
- **Ranger side.** `graphClose` passes `--ci` straight through (`src/graph-write.ts:149`). `classifyCi` assumes GitHub check runs (`src/ci-policy.ts`), so it needs a GitLab pipeline/job counterpart in the forge seam.

## 4. Bringing existing issues under a map root

- **No verb does it.** The nine verbs are `frontier`, `node`, `claim`, `release`, `add`, `chart`, `close`, `audit` and `decisions` (`cli/graph.ts:90`). Only `add` and `chart` create membership, and both create new items (`createNode`, `:264-292`).
  - The store has no method to adopt or reparent.
  - `add --blocked-by` and re-homing write *links*. Membership is read only from the hierarchy widget (`:143-155`).
- **The instance would refuse it anyway.** Issue `allowedParentTypes` is `[]` (§2), so even a raw GitLab write could not parent an Issue on CE.
- **The four issues (live).** Each one:
  - is an `Issue`;
  - carries a `<!-- soma:work-graph-node` block;
  - has `parent: null` and no children.

  Assignees and links:

  | Issue | Assignee | Links |
  |---|---|---|
  | #60 | none | none |
  | #61 | jens-christian.fischer | none |
  | #62 | none | none |
  | #33 | jens-christian.fischer | `relates_to` #32 |

  Each one is a valid single-node root today, which is how `frontier` and `audit` ran against #33.
- **Ways forward. All of them need a soma change or a re-file, and none needs an instance change:**
  - O3: re-file each one as a Task under a typed Issue root, using `add` with the old body, then close the original as superseded. This loses the issue numbers and history.
  - O4: soma grows a verb that converts an Issue into a Task under a root (`workItemConvert`, then set the parent). This needs a soma decision and is unverified on CE.
  - O5: treat each existing Issue as its own one-node map. This needs nothing new, but ranger's map registry would have to hold several roots.

## 5. Authentication and pinning a read-only token

### How the transport works

The transport shells out to `glab api <path> --hostname <host>` (`:48-79`).

- **Env tokens are stripped.** `gitLabCliEnvironment` forwards only `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`/`TEMP`/`TMP`, `XDG_*` and `GLAB_CONFIG_DIR` (`:36`, `:64`).
  - `GITLAB_TOKEN`, `GLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`, `CI_JOB_TOKEN` and the host overrides never reach glab (`:35`). This is deliberate: a token set for the whole process must never go to a host named in a ref (`:71-72`).
  - So ranger's GitHub pattern, pinning `GH_TOKEN` in the environment (`src/token-gate.ts:88-105`), **does not carry over**.
  - Its `GH_CONFIG_DIR` half does. The GitLab version is a ranger-owned `GLAB_CONFIG_DIR` whose `config.yml` holds only `hosts.gitlab.software.geant.org.token: <read_api token>`, at mode 0600, with `check_update: false` and `telemetry: false`, removed after the call.
- **Live:** pointing `GLAB_CONFIG_DIR` at a fresh empty directory made `glab api user --hostname gitlab.software.geant.org` return `401 Unauthorized`, and `glab auth status` said the host was not authenticated. So with that directory, glab did not pick up the principal's credential.
  - **Where the principal's credential lives (live).** `glab auth status --hostname gitlab.software.geant.org` reports `Logged in … as jens-christian.fischer (/Users/fischer/Library/Application Support/glab-cli/config.yml)`. So glab resolves the principal's GÉANT login from the default config file, and a set `GLAB_CONFIG_DIR` keeps glab from reading that file.
  - **Limit.** The empty directory had no entry for the GÉANT host, so the test does not show whether glab would fall back to an OS keyring when a host entry exists with an empty `token:`. That stronger test was refused by the local runtime policy, as was any direct inspection of the principal's glab config. **Keyring fallback is unverified.** The first bot-token run should repeat this test.
  - glab's `config.yml` also supports `custom_headers` with `valueFromEnv`. That does not help: soma's env allowlist drops the variable before glab sees it.
- **Writes use the same mechanism.** A second `GLAB_CONFIG_DIR` holds the project access token. soma cannot take one token for reads and another for writes in one process. Ranger chooses by which config dir it hands to each `soma` call.

### The confinement check (F9)

- `checkGitLabConfinement` (`:230-246`) strips the token variables and runs:
  - `glab auth status`;
  - `glab config get token`;
  - `glab api user`;
  - `glab api personal_access_tokens/self`;
  - a `test -r` on the **hard-coded default** path `~/Library/Application Support/glab-cli/config.yml` on darwin (`:232`, `:236`).
- `GLAB_CONFIG_DIR` survives the stripping, so the glab probes see the pinned bot. The file probe ignores it. On the principal's Mac, the default file is the one glab itself names as the GÉANT login's source (live `glab auth status`, above). It is the principal's own file, so the walker's process can presumably read it. So `file:glab-cli/config.yml` is expected in `reachableIdentities` (`:242`). The `test -r` was not run under the walker's user, so this part is inferred.
- `deriveAttestation` lists every reachable identity other than the acting one as a reason (`work-graph-attestation.ts:89-106`), so receipts come out `unverified`.
- Attestation is deliberately not gated (`work-graph.ts:1105-1107`), so closes still go through.
- Fix in soma: probe `$GLAB_CONFIG_DIR/config.yml` when it is set.
- Not verified: whether `personal_access_tokens/self` answers for a project access token.

## 6. Claim identity and the project-access-token bot

- `claim`/`release` default `--identity` to `store.actingIdentity()`, which is `GET /user` → `username` (`:253`; `cli/graph.ts`, `runRelease`).
- An explicit `--identity` that differs from that is refused (`:298-301`). So ranger should **read** the bot login from the token (`GET /user`) rather than configure it. The bot username is `project_<projectId>_bot_<random>` (GitLab docs, project access tokens).
- **Project access tokens on this instance.** Docs: self-managed has them "with any license", and creating one needs Maintainer or Owner. Live: the principal's access on `claw/crisis-simulator` is `group_access.access_level: 40` (Maintainer). This is inside the map's "Maintainer at most" constraint.
- **Not verified, because it needs a write:**
  - whether `issueSetAssignees` accepts the bot as an assignee (the docs do not say);
  - whether the role picked for the token (Developer or above) covers note, description and state writes.

  The first live claim should check both.

## 7. Other gaps a headless walker hits

- **`ranger:needs-eye`.** Ranger reads node labels itself through `gh` (`src/merge-desk.ts:254`, `src/implement.ts:820`). The GitLab store returns no labels (`stateFrom`, `:210-219`) and refuses them on `add` (`:265`).
  - On GitLab the hold-back needs ranger to read labels with a read-only GitLab call. That is a read, so the "writes through soma verbs" constraint holds. A human sets the label in the UI.
  - Alternatively, soma exposes labels on `NodeState`.
- **Blocking edges (F8).** `addBlockingEdge` sends `workItemAddLinkedItems` with `linkType: BLOCKS` (`:293-294`). The GraphQL schema on the instance lists `RELATED`, `BLOCKED_BY` and `BLOCKS`, but GitLab documents blocking links as **Premium/Ultimate**. On CE, expect `add --blocked-by` to error after the node already exists. The CLI reports that case honestly ("Created node … then failed to add …").
  - Blockers read from existing links would come back empty, so ordering between nodes cannot be expressed on this instance.
  - Unverified live, because testing it means a write.
- **Ranger's repo qualifier.** `somaRepo()` turns every bare repo into `github:github.com/…` (`src/graph.ts:35-37`). A GitLab map has to carry its qualified ref, `gitlab:gitlab.software.geant.org/claw/crisis-simulator`, end to end.

## Questions this leaves for the map

- Q1: **Root shape.** Ask soma for O1 (an Issue-root `chart`, flat Issue → Task maps), or work without `chart`? This decides how the crisis-simulator map is registered.
- Q2: **Existing issues.** Which of O3, O4 or O5 for #60, #61, #62 and #33?
- Q3: **CI identifier for GitLab auto closes.** Pipeline id or job id? Both need a soma-side verifier that also refuses `source: external` pipelines. Until it exists, an `auto` close on GitLab carries an unverified CI citation.
- Q4: **Ordering.** No blocking edges on CE. Accept unordered maps, or encode order another way (for example, by filing nodes only after their predecessor closes)?
- Q5: **soma fixes to file.** The confinement probe should honour `GLAB_CONFIG_DIR`. GitLab readNode should verify completion, mirroring GitHub `hasCurrentCloseReceipt`.
