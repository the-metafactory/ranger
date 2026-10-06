# GitLab coupling inventory: where ranger is bound to GitHub

Node #92 on map the-metafactory/ranger. Research findings for the forge-seam grilling.
Checkpoint: `gitlab-coupling-inventoried`.

The node asks for `docs/research/gitlab-coupling-inventory.md`. The research lane only allows
`findings.md` (`src/research-ci.ts:53`, `assertResearchFindingsOnly`), so the doc ships here.
Moving it to `docs/research/` is a follow-up for a build node.

Read at `main` 0c8c7d7 (ranger) and the local soma checkout (`~/work/mf/soma/src`), 2026-10-06.

**Confidence tags.** Every ranger file:line was read this session.
- **[soma]**: read in soma's source this session.
- **[docs]**: checked against docs.gitlab.com this session.
- **[unverified]**: from memory or inference. Check it before a build node relies on it.

---

## Headline findings

These four change the shape of the seam. The tables below have the detail.

### H1. Credentials at the graph boundary bypass ranger's token gate on GitLab

- Every `soma graph` call ranger makes pins `GH_TOKEN` / `GITHUB_TOKEN` / `GH_CONFIG_DIR`. Reads use `gatedEnv`, `src/token-gate.ts:94-117`. Writes use `writeEnv`, `src/identity.ts:78-100`.
- Soma's GitLab transport ignores all three. It runs `glab api` with an env allowlist (`PATH, HOME, …, XDG_*, GLAB_CONFIG_DIR`). It strips `GITLAB_TOKEN`, `GLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`, `CI_JOB_TOKEN` and the host overrides. It keeps "glab's configured credential lookup" (`soma/src/work-graph-gitlab.ts:33-36`, `:63-79`). [soma]
- **Consequence.** Changing only `somaRepo()` to emit `gitlab:` would make scout reads *and* claim/close/decisions run under whatever `glab auth` holds for the host. On this machine that is likely the principal's GÉANT login. That breaks two binding constraints: "no autonomous write under the principal's GÉANT credential" and "read paths token-gated, no glab keyring fallback".
- **Likely mechanism (unverified).** `GLAB_CONFIG_DIR` is on soma's allowlist. Ranger could point it at a throwaway dir whose `config.yml` holds only the target host and the bot/read token. This mirrors the `GH_CONFIG_DIR` trick. Whether glab 1.80.4 (installed) reads a token from a `GLAB_CONFIG_DIR` config without the keyring needs a probe. The alternative is a soma change: an explicit token-env opt-in for the GitLab transport.
- **Read-only gating.** `SOMA_GRAPH_READONLY=1`, set by `gatedEnv` (`src/token-gate.ts:107`), appears nowhere in soma's TypeScript (grep, 0 hits). Read-only enforcement is ranger-side only: the verb allowlist at `src/graph.ts:11` and `:138-142`. On GitLab, the `read_api` token scope becomes the only other guard. That makes the scope check in H1's gate rewrite (Seam B) important.
- Soma has its own confinement probe for GitLab (`checkGitLabConfinement`, `soma/src/work-graph-gitlab.ts:229-245`). It runs `glab auth status`, `glab config get token`, `api user`, `api personal_access_tokens/self` and flags reachable identities. The GitLab gate rewrite could reuse it. [soma]

### H2. GitLab node ids are not numbers

- Soma's GitLab store ids carry their location: `claw/crisis-simulator#12` for an issue/task, `claw&5` for an epic (`storeNodeId`, `soma/src/work-graph-ref.ts:186-189`). [soma]
- A bare `12` passed in with `--repo gitlab:…` resolves to `<repo path>#12` (`localNodeId`, `soma/src/work-graph-bridge.ts:210-216`). Input can stay bare, but frontier/node JSON `ref.id` comes back located. [soma]
- An epic root (`&N`) is not an issue in the project, so a numeric `root` cannot name it.
- Ranger assumes `id = /^\d+$/` and `repo = owner/name` in many places (Seam A). They need one normalisation at the boundary: a typed `NodeKey` / `MapRef`, not scattered regexes.

### H3. CI evidence for `--ci` can be forged on GitLab

- Soma treats the `--ci <checkRunId>@<sha>` cite as the one completion fact "an issue editor cannot author, because check-run conclusions are written only by a GitHub App" (`soma/src/work-graph.ts:1174-1184`). Soma checks only that the cite is non-empty. It never verifies it against the forge. [soma]
- On GitLab, `POST /projects/:id/statuses/:sha` "creates a new pipeline with `CI_PIPELINE_SOURCE: external`" when none exists, or appends a job to an existing pipeline. [docs]
- So any token allowed to post statuses can make a green "pipeline" job exist. That includes ranger's own bot token, which needs Developer to push. Role required to post a status: [unverified], believed Developer.
- The GitLab CI reader must cite only runner-executed work. Filter pipelines by `source` (`push` / `merge_request_event`, not `external`), and treat jobs whose pipeline is external as statuses, not evidence. The forge-seam grilling should decide whether soma or ranger owns that check.

### H4. The closing-keyword guard only knows GitHub

- `CLOSING_KEYWORD` (`src/git-ops.ts:733-735`) matches `close/fix/resolve` + `#N`, `owner/name#N` or `github.com/…/issues/N`.
- GitLab's default issue-closing pattern also includes `implement(s|ed|ing)`. It also matches GitLab issue URLs (`/-/issues/N`) and nested-group refs `group/sub/project#N`. [unverified: exact default regex]
- GitLab applies the pattern to MR **descriptions** and to commits landing on the default branch. A miss would let a merge auto-close the node and skip the close gate (#588).
- Ranger's own text is at risk. `closeResolution` writes "Implemented by ranger's implement lane in PR #N" (`src/implement.ts:1713`). That is the close receipt, not an MR description, but the same wording in an MR body or squash message would match on GitLab. MR body writers: `draftBody` and `readyBody`, `src/implement.ts:1655+`.
- The guard is applied at `assertNoClosingKeywords` (`src/git-ops.ts:780-797`) and on the PR title (`src/implement.ts:1640+`). It needs a forge-specific pattern, and it should also scan the MR description ranger writes.

---

## Lanes (key for the tables)

| Lane | Entry points |
|---|---|
| **scout** | `cli.ts` scout (`:94`, `:158`), `card-sync.ts:993`, `frontier-cache.ts`, `budget.ts`, `graph.ts` |
| **walk** (claim/close) | `walk.ts:359`, `graph-write.ts`, `identity.ts` |
| **research** | `worker.ts:780-960` → `research-ci.ts` |
| **implement** | `implement.ts` (implement → review → awaiting-merge → close) |
| **merge desk** | `merge-desk.ts` + `merge-gate.ts` + `ci-policy.ts` |
| **serve** | `serve.ts`, `serve-parked.ts`, `launch.ts` |

---

## Seam A: Repo and node identity (refs)

| # | Where | What it does | Lanes | GitLab equivalent |
|---|---|---|---|---|
| A1 | `src/graph.ts:35-37` `somaRepo()` | Bare `owner/name` → `github:github.com/owner/name`. Anything containing `:` passes through. | all graph calls (scout, walk, research, implement, serve) | Emit `gitlab:<host>/<path>`. Soma grammar: `gitlab:gitlab.software.geant.org/claw/crisis-simulator` [soma `work-graph-ref.ts:10-13`]. The pass-through branch already works if config carries the qualified form, but see A2. |
| A2 | `src/config.ts:38` `REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/`. Used at `:42` (map.repo), `:139` (serve map), `:198` (legacy roots), `src/serve.ts:480,503,1328,1377,1401`, `src/serve-parked.ts:476` | Validates exactly one `/`, with no host and no forge. | config, serve | GitLab paths can nest (`group/sub/project`) and need a host. Needs a forge-qualified ref type: `{forge, host, path}`, parsed once. `claw/crisis-simulator` matches today's regex but drops the host. |
| A3 | `src/config.ts:44-46`, `:104`, `:114`, `:140-141` | `root`, `nodes`, `skip` are positive integers | config, walk, scout | Issue root: iid works (soma resolves bare). Epic root `claw&N`: no numeric form. `nodes`/`skip` can stay iids if they are always resolved against the map's project path. |
| A4 | `src/serve.ts:83`, `src/serve-parked.ts:39` `ID_PATTERN = /^\d+$/`; `src/cli.ts:605` (build-now); `src/implement.ts:269` (`probeCommandFor` refuses non-numeric `{node}`); `src/views.ts:31` | Numeric id guard. It is also an injection guard, because ids reach shell templates and argv. | serve, implement, CLI | Keep a strict pattern, extended to `path#iid` with a strict path charset. Or keep the iid as the local id and add the project path separately. `{node}` substitution should stay digits-only (iid). |
| A5 | `src/worker.ts:142-144` `worktreeBranch` → `node/<id>-<slug>`; `src/git-ops.ts:221` `NODE_BRANCH = /^node\/\d+-[a-z0-9-]+$/` | Branch naming, and the config-cleanup safety check | implement, research | A located id (`claw/crisis-simulator#12`) is not a valid ref component. Use the iid. Cross-project nodes in one GitLab graph (an epic spanning projects) would make iids collide in the journal (A6). |
| A6 | journal keyed on `(repo, nodeId)`, e.g. `src/store/schema.ts:82,139`; `mapKey` / `buildNowArgv` split on `#` (`src/serve.ts:495-504`); temp files `ranger-close-${repo.replace("/", "__")}-${nodeId}.md` (`src/implement.ts:1287`, `src/worker.ts:936`) | Keys, cache keys (`frontier:<repo>#<root>`, `src/frontier-cache.ts:52`), file names | all | `#` is soma's GitLab node sigil, so `repo#root` splitting breaks on located ids. `replace("/", "__")` replaces only the first `/`, and a qualified repo adds `:`. Needs one encoding function. |
| A7 | `src/implement.ts:816`, `src/merge-desk.ts:254` `issueLabels(repo, Number(nodeId))` | Reads the node issue's labels for `ranger:needs-eye` | implement, merge desk | `GET /projects/:id/issues/:iid`, field `labels` (string array). Node project = path part of the located id, which can differ from the MR's project (H2). [unverified: labels on Tasks/work items. Tasks are work items. REST `issues/:iid` covers type `issue`/`task` in recent GitLab. Probe on the GÉANT version.] |
| A8 | `src/serve.ts:474-489` `launchPlan` prompt `soma graph node <id> --repo <owner/name>` | Grilling launch in the principal's checkout | serve | Pass the qualified repo. Soma's `--repo` wants `<forge>:<host>/<path>` unless an origin remote resolves it. |
| A9 | `src/serve-parked.ts:380` `https://github.com/${repo}/issues/${id}`; `:389`, `src/serve.ts:1357`, `src/implement.ts:1290`, `:1713` PR URL fallbacks | Hand-built URLs | serve, implement | `https://<host>/<path>/-/issues/<iid>`, `/-/merge_requests/<iid>`. Prefer the API's `web_url`. |

## Seam B: Credentials and the token gate

| # | Where | What it does | Lanes | GitLab equivalent |
|---|---|---|---|---|
| B1 | `src/token-gate.ts:94-117` `gatedEnv` | Pins `GH_TOKEN`/`GITHUB_TOKEN` to the read-only token, isolates `GH_CONFIG_DIR`, sets `SOMA_GRAPH_READONLY=1` | scout, serve, review | glab: `GITLAB_TOKEN` + `GITLAB_HOST` for ranger's own glab calls. Soma strips both (H1), so the graph boundary needs `GLAB_CONFIG_DIR` isolation or a soma opt-in. [unverified: glab reads token from `GLAB_CONFIG_DIR/config.yml` without the keyring] |
| B2 | `src/identity.ts:78-100` `writeEnv` | The same for the machine-account write token (no READONLY flag) | walk, implement, research, merge desk | Same as B1, with the project access token (bot user). Constraint: project access token, Maintainer max. |
| B3 | `src/token-gate.ts:123-148` `introspectToken`, `gh api /user -i`; `:196-217` `parseGhHeaders` reads `X-OAuth-Scopes`; `:44` `READ_ONLY_SCOPE = /^read:/` | Classifies a token by its scopes. Fine-grained tokens (no header) count as read-only by construction. | scout, serve | No scopes header. `GET /personal_access_tokens/self` returns `scopes` [docs], but only PATs are documented. Whether project access tokens answer it is [unverified]. Read-only policy: scopes ⊆ {`read_api`, `read_repository`}. Anything else (`api`, `write_repository`, …) refuses. |
| B4 | `src/token-gate.ts:177-193` `assertRepoReadable`, `gh api repos/{repo}` | Proves the token reads the map's repo | scout, serve | `GET /projects/:url-encoded-path`. 404 means no access. |
| B5 | `src/token-gate.ts:72-85` `matchTokenEnv`; `src/identity.ts:57-70` `matchWriteTokenEnv`; `src/config.ts:165-175` | Longest-prefix match of `owner/` against `map.repo` | all | Prefix keys carry no host, so `claw/*` would match a same-named group on any forge or host. Keys must include forge+host. |
| B6 | `src/identity.ts:103-122` `loginForToken`, `gh api /user --jq .login`; `:133-150` `resolveBotIdentity`; `:157-168` `assertNotPrincipal`; `src/config.ts:191` `principal.login` default `jcfischer` | Resolves the bot login and refuses a write tick under the principal | walk, implement, research, merge desk | `GET /user` → `username` (a project access token resolves to its bot user, `project_<id>_bot_<hash>`) [unverified: exact bot username format]. **The principal's login is per forge/host**: the GÉANT username is not `jcfischer` on GitHub. `principal.login` needs to be per forge/host, or `assertNotPrincipal` passes vacuously. Soma's `actingIdentity()` also reads `GET user` → `username` [soma `work-graph-gitlab.ts:254`]. |
| B7 | `src/worker-env.ts:74-75` deletes `GH_TOKEN`/`GITHUB_TOKEN`; `src/serve-parked.ts:460` `MACHINE_GH_KEYS` | Keeps forge tokens out of worker sessions and dashboard merges | implement, research, serve | Add `GITLAB_TOKEN`, `GLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`, `CI_JOB_TOKEN`, `GLAB_CONFIG_DIR`, `GITLAB_HOST` (soma's list, `work-graph-gitlab.ts:35`). The worker allowlist passes `GIT_*` and `XDG_*`. Glab's config under `XDG_CONFIG_HOME` is reachable by the worker unless isolated. |
| B8 | `ops/bin/ranger.example` (`GH_TOKEN`, `RANGER_WRITE_GH_TOKEN_*`, `RANGER_READONLY_GH_TOKEN_*`) | Keychain → env wrapper | ops | Add `RANGER_WRITE_GL_TOKEN_GEANT` / `RANGER_READONLY_GL_TOKEN_GEANT` (names illustrative). Out of `src/`, listed for completeness. |

## Seam C: Graph boundary (soma)

| # | Where | What it does | Lanes | GitLab equivalent |
|---|---|---|---|---|
| C1 | `src/graph.ts:134-161` `callGraph` (frontier/node/audit) | Read verbs under `gatedEnv` | scout, serve | Soma's GitLab store implements the same verbs over GraphQL work items [soma]. Unchanged verb surface, but credentials per H1 and ids per H2. |
| C2 | `src/graph-write.ts:73-178` claim/release/close/decisions, all `--repo somaRepo(repo)` | Graph writes under `writeEnv` | walk, implement, research | Same verbs [soma]. Close receipt = issue note + description block + `state_event: close` (`work-graph-gitlab.ts:337`). Credentials per H1. |
| C3 | `src/graph.ts:39-49` `RATE_LIMITED = /rate limit/i` → `RateLimitError` | Turns a throttled read into a cooldown instead of a failure | scout, serve | GitLab throttling is HTTP 429 (`Retry-After`, `RateLimit-*` headers) [unverified: exact glab stderr text]. Soma wraps it as `glab api … failed (exit N): <stderr>`. The regex may or may not match. Probe it. |
| C4 | `src/transient.ts:14-23` | GitHub GraphQL timeout texts + 5xx + network errors → retry reads | all reads | The 5xx and network patterns carry over. The two GitHub GraphQL strings do not. GitLab GraphQL timeouts surface differently [unverified]. |
| C5 | `src/serve.ts:1397-1426` `readIssue`: REST `repos/{repo}/issues/{id}`, parses the `<!-- soma:work-graph-node … -->` block and labels | Live node read on the dashboard, bypassing soma | serve | `GET /projects/:id/issues/:iid` (`description`, `labels`, `assignees[].username`, `state` = `opened`/`closed`). Soma's GitLab store writes the same node block [soma `work-graph-gitlab.ts:337`] plus a `soma:gitlab-work-graph-route` block. Epics need the group epics/work-items API. |

## Seam D: Change request (PR → MR)

`GitHubPort` (`src/github.ts:82-99`) is already an injectable interface: `ImplementContext.github`, `ResearchGitHubPort`, the merge desk's `github?`. It is the natural starting point for a `ForgePort`. Its types leak GitHub (`mergeableState` strings, `CheckRun.conclusion`), so the seam needs normalised states, not renamed fields.

| # | Where | What it does | Lanes | GitLab equivalent |
|---|---|---|---|---|
| D1 | `src/github.ts:101-129` `ghApi`: `gh api` + `writeEnv`; reads retried, writes once (`isReadRequest`, `:22-34`) | Transport | implement, research, merge desk | `glab api` (with `--hostname`) or direct `fetch` to `https://<host>/api/v4` with `PRIVATE-TOKEN`. `isReadRequest` parses gh flags: rewrite it per transport. |
| D2 | `src/github.ts:131-154` `toPullRequest` | `number, state, merged, draft, head.ref/sha, base.ref, mergeable, mergeable_state, merge_commit_sha, merged_by, html_url, user` | all PR consumers | MR: `iid`, `state` (`opened/closed/merged/locked`), `draft`, `source_branch`, `sha` (head), `target_branch`, `detailed_merge_status`, `merge_commit_sha` / `squash_commit_sha`, `merge_user`, `web_url`, `author.username` [docs]. Note `merged` is a state, not a flag. |
| D3 | `src/github.ts:157-174` `findPrByHead`: `pulls?state=all&head=owner:branch` | F2 resume anchor | implement (`implement.ts:604`), research (`worker.ts:802`) | `GET /projects/:id/merge_requests?source_branch=<b>&state=all` [docs]. No owner prefix. Same-project MRs only. |
| D4 | `src/github.ts:177-185` `getPr` | Full state incl. mergeability | implement (`:290,605,682,687,938,1373`), research (`research-ci.ts:95,116`), merge desk (`:124`) | `GET /projects/:id/merge_requests/:iid`. Mergeability "checked asynchronously … poll" [docs]. |
| D5 | `src/github.ts:187-213` `createDraftPr` (`draft=true`) | Opens the draft | implement (`:660`), research (`research-ci.ts:76`) | `POST /projects/:id/merge_requests` with `source_branch`, `target_branch`, `title`, `description`. Draft via a `Draft:` title prefix; a `draft` param is [unverified for the GÉANT version]. |
| D6 | `src/github.ts:215-226` `updatePrBody` | Ready body | implement (`:849`) | `PUT …/merge_requests/:iid` `description`. |
| D7 | `src/github.ts:229-255` `markReady`: GraphQL `markPullRequestReadyForReview` | Draft → ready | implement (`:850`) | `PUT …/merge_requests/:iid` with the title without `Draft:` (or `draft=false` where supported) [unverified]. No GraphQL needed. |
| D8 | `src/github.ts:362-395` `postComment` / `listComments` (`issues/{n}/comments`, **one page of 100**) | Review/probe/base-merge **markers** live in bot-authored PR comments (`recordedReviews` `src/implement.ts:179`, `PROBE_MARKER` `:223`, base-merge `:879`). They are the resumable state (F2). | implement, merge desk (`:157`), close (`implement.ts:1280,1283`) | `POST/GET …/merge_requests/:iid/notes`. Filter `system: true` notes out, and author = `author.username`. Note size cap differs (GitHub 65 536, `COMMENT_BUDGET` `src/implement.ts:1385`; GitLab note limit [unverified, ~1 MB]). **Side finding (GitHub today):** `listComments` reads only the first 100 comments with no pagination, so a PR past 100 comments loses markers. |
| D9 | `src/implement.ts:1358-1380` `awaitHead` | Waits until the forge shows the pushed SHA | implement | Same need: poll `sha` on the MR. |
| D10 | `src/implement.ts:935-940` `conflictsWithBase`; `src/merge-gate.ts:58-68`, `:99-103` | `mergeable === false` or state `dirty` → conflict; `null`/`unknown` → pending | implement, merge desk | `detailed_merge_status`: `conflict` / `need_rebase` → fail. `checking` / `unchecked` / `preparing` / `approvals_syncing` → pending. `mergeable` → ok [docs: full 24-value list]. Other values (`not_approved`, `discussions_not_resolved`, `ci_must_pass`, `ci_still_running`, `draft_status`, `status_checks_must_pass`, …) must map explicitly. An unknown value must not read as mergeable. |

## Seam E: CI evidence (check runs → pipelines)

| # | Where | What it does | Lanes | GitLab equivalent |
|---|---|---|---|---|
| E1 | `src/github.ts:301-323` `checkRunsFor` (`commits/{sha}/check-runs?filter=latest`, paginated) | Every check on the head | merge desk (`merge-desk.ts:229`), close (`implement.ts:1273`), research (`research-ci.ts:101`) | `GET /projects/:id/pipelines?sha=<sha>` (`source`, `status`) + `GET /projects/:id/pipelines/:pid/jobs` (`status`, `allow_failure`) [unverified: exact query params]. Also `GET …/merge_requests/:iid/pipelines`. MR pipelines and branch pipelines can both exist for one SHA, so pick the latest per `source`. |
| E2 | `src/github.ts:326-346` `workflowRunsFor` (`actions/runs?head_sha=`) | Queued workflows before their check runs exist. Also the dashboard's fallback for tokens that cannot read check runs. | research, serve | Pipelines exist before jobs run (status `created`/`pending`), so one source covers both. |
| E3 | `src/github.ts:349-360` `commitStatusesFor` (`commits/{sha}/status`) | External CI contexts | research | `GET /projects/:id/repository/commits/:sha/statuses`. These *are* jobs, possibly in an `external` pipeline: H3. |
| E4 | `src/ci-policy.ts:12-30` `classifyCi`: `status === "completed"`, conclusions `success/neutral/skipped` ok, ≥1 `success` | One verdict for the merge gate and the dashboard | merge desk, serve | Pipeline `status`: `success` ok. `failed/canceled` fail. `created/waiting_for_resource/preparing/pending/running/scheduled/manual` pending (decide on `manual`). `skipped` ≈ GitHub skipped. Jobs with `allow_failure: true` + `failed` ≈ GitHub `neutral` [unverified mapping, a policy decision]. |
| E5 | `src/research-ci.ts:20-42` `classifyCi` (runs + workflows + statuses) and settle loop `:60-138` | Research CI evidence on a never-merged draft. Cite `${success.id}@${sha}` (`:121`). | research | Same loop over pipelines. Cite `<pipelineId>@<sha>` or `<jobId>@<sha>`, with H3's source filter. Needs CI to run on a draft MR or on branch push: crisis-simulator's `.gitlab-ci.yml` `workflow:rules` decide that [unverified]. |
| E6 | `src/merge-gate.ts:145` → `ciCheckRunId`; `src/implement.ts:1320` `ci: ${success.id}@${headSha}`; `src/graph-write.ts:120-121,149` `--ci` | The close cites one CI run | implement, research | Soma stores the cite as opaque strings `ciCheckRunId`/`ciHeadSha` on GitLab too [soma `work-graph-gitlab.ts:194,337`]. No soma change is needed for the shape. Trust: see H3. |
| E7 | `src/implement.ts:1305` evidence pointer `https://github.com/${repo}/runs/${id}` | Externally checkable pointer | implement | `https://<host>/<path>/-/pipelines/<id>` or `/-/jobs/<id>`. |
| E8 | `src/serve.ts:1322-1360` `readPrLive`: check-runs, falling back to `actions/runs`; `src/serve-parked.ts:254-290` page parsers | Dashboard CI state | serve | One pipeline read, with no fallback split (a `read_api` token reads pipelines) [unverified for project-level token visibility]. |

## Seam F: Merge and needs-eye

| # | Where | What it does | Lanes | GitLab equivalent |
|---|---|---|---|---|
| F1 | `src/github.ts:262-284` `mergePr`: `PUT pulls/{n}/merge` `merge_method=squash`, `sha=<gated head>`, `commit_title="<title> (#n)"`. 409 if the head moved. | Ranger merges only the commit its gate saw | merge desk (`merge-desk.ts:265`, `autoMerge`) | `PUT …/merge_requests/:iid/merge` with `squash=true`, `sha=<head>` ("must match the HEAD of the source branch", 409 "SHA does not match HEAD of source branch"), `squash_commit_message` [docs]. The guarantee carries over. **Differences:** (1) the project's merge method (merge commit / semi-linear / ff) still applies around the squash, so "one commit per node" may become squash + merge commit [unverified per project setting]. (2) The project's squash option can be "Do not allow" or "Require", which overrides the parameter. Both are crisis-simulator project settings, Maintainer-level. |
| F2 | `src/merge-gate.ts:15-146` six checks (open, ci-green, mergeable, base-branch, review-clean, probes) | Gate before merge or card | merge desk | Same shape. `open` = `state === "opened"`. `base-branch` = `target_branch`. GitLab-native rules (approvals, `discussions_not_resolved`, protected-branch push rules) show up in `detailed_merge_status` and can block the bot's merge even when ranger's gate passes. |
| F3 | `src/labels.ts:2` `NEEDS_EYE_LABEL = "ranger:needs-eye"`; `src/merge-desk.ts:252-264`; `src/serve-parked.ts:142,364`; `src/views.ts:282` | Hold-back: no auto-merge for labelled nodes | merge desk, serve, implement (views) | GitLab labels are plain strings. `ranger:needs-eye` is a valid label name; `::` would make it a scoped label, a single colon does not [unverified]. The label must exist in the project or group. Read via issue `labels` (A7). |
| F4 | `src/serve-parked.ts:475-480` `mergeArgv`: `gh pr merge <n> --repo <r> --squash --match-head-commit <sha>`; `:468-472` `mergeEnv` strips machine keys so gh uses **the login under HOME**; `:631-660` re-reads checks under that login (`verifyChecksAs`, `src/serve.ts:1376-1395`); button text `src/serve.ts:960-961` | The principal's one-tap merge from the dashboard | serve | `glab mr merge <iid> --squash --sha <sha> -R <host/path>` [unverified: glab flag names]. Runs under the principal's glab login, which on GÉANT *is* the principal's GÉANT credential. That fits the constraint (a human tap, not autonomous), but it needs an explicit decision. |
| F5 | `src/config.ts:117-122` `autoMerge` | Per-map standing grant | merge desk | Unchanged. Crisis-simulator registers `autoMerge: true`. GitLab's own `auto_merge` (merge-when-pipeline-succeeds) [docs] is **not** a substitute: it would merge on pipeline success without ranger's sage/probe checks at merge time. Ranger keeps merging synchronously after its gate. |

## Seam G: Review

| # | Where | What it does | Lanes | GitLab equivalent |
|---|---|---|---|---|
| G1 | `src/review.ts:39-88` `sageReview`: `sage review <owner/name>#<n> --emit-verdict-block` under `gatedEnv` (read-only `GH_TOKEN`) | Offline sage review of the PR diff | implement (`implement.ts:707`) | Depends on sage reading a GitLab MR (`!N` on host). That lives outside ranger: crisis-simulator #21 (sage on GÉANT). The `owner/name#n` argument format and the `GH_TOKEN` env are GitHub-specific. |
| G2 | PR review API | **Not used.** Ranger posts no formal review and reads none (`src/merge-gate.ts:5-13`). The verdict lives in a bot comment marker (D8). | n/a | MR approvals: not used. If crisis-simulator's project requires approvals, the bot cannot approve its own MR. `detailed_merge_status = not_approved` blocks the merge (F2). |

## Seam H: Git transport

| # | Where | What it does | Lanes | GitLab equivalent |
|---|---|---|---|---|
| H-1 | `src/worker.ts:176-195` `bootstrapCanonical`: `git clone https://github.com/${repo}.git` | Canonical checkout bootstrap | implement, research, walk | `https://<host>/<path>.git`, so the host is needed (A2). |
| H-2 | `src/git-ops.ts:30-41` `gitAuthEnv`: `http.extraheader = AUTHORIZATION: basic base64(token:x-oauth-basic)` | Credentialed fetch/push without persisting the token | implement, research (vetted push, `fastForwardCanonical`) | GitLab wants the token as the **password**: `base64("<any-non-blank-user>:<token>")`, e.g. `oauth2:<token>` [unverified for project access tokens; documented for PAT/OAuth]. `http.extraheader` with no URL scope sends the header to every host the call reaches. Fine while ranger names its remote (`assertNamedRefs`). |
| H-3 | `src/worker-env.ts:107-112` `GIT_AUTHOR_EMAIL = <identity>@users.noreply.github.com` | Commit authorship by the bot | implement, research | GitLab bot users have a noreply email (`<bot>@noreply.<host>`) [unverified format]. Some projects enforce "commit author is a GitLab user" push rules, so the email should be the bot's real one. |
| H-4 | `src/git-ops.ts:733-797`, `src/implement.ts:1640+` | Closing-keyword guard | implement | H4. |
| H-5 | `src/git-ops.ts:224` `MAP_REMOTE = "origin"` | Remote naming | implement, research | Forge-neutral. |

## Seam I: Budget, rate limits, frontier cache

| # | Where | What it does | Lanes | GitLab equivalent |
|---|---|---|---|---|
| I1 | `src/budget.ts:137-163` `readGraphqlBudget`, `gh api rate_limit` `.resources.graphql`; `:166-190` floor deferral; `src/config.ts:268-282` `graphqlFloor`; `src/serve.ts:1247` | Hourly GraphQL allowance gate | scout, serve | **No equivalent.** GitLab has no `/rate_limit` endpoint. GraphQL is bounded by per-query complexity (soma batches at 6 items for the 250 cap, `work-graph-gitlab.ts:220-222`) [soma] plus instance-wide request throttles. Limits are instance-admin settings (out of reach). The budget gate becomes a no-op on GitLab, and only the 429 cooldown (I2) applies. |
| I2 | `src/budget.ts:19-27,192-223` secondary-limit cooldown, journal `ratelimit:<token source>` | Backs off after throttling | scout, serve | 429 + `Retry-After` [unverified text through glab]. Depends on C3 matching. |
| I3 | `src/frontier-cache.ts:58-81` `readRepoSentinel`: newest issue `updated_at` (`issues?sort=updated`) + newest repo issue-event id (`issues/events`) | Skips GraphQL frontier reads when nothing changed | scout | Half 1: `GET /projects/:id/issues?order_by=updated_at&sort=desc&per_page=1` → `updated_at`. **Half 2 has no equivalent**: GitLab has no repo-wide issue-events feed. Candidate: `GET /projects/:id/events?target_type=issue` or the per-issue resource events [unverified]. Whether adding/removing a link or a child bumps `updated_at` on GitLab is **unknown**. It needs the same live measurement `frontier-cache.ts:24-35` records for GitHub. An epic-rooted map spans projects, so a per-project sentinel is incomplete. A safe first cut: no cache on GitLab, with frontier max age as the only bound. |

---

## Not GitHub-bound (checked, forge-neutral)

- Discord (`discord.ts`, `announce.ts`, `card-sync.ts`, `digest.ts`, `escalate.ts`): text uses `#<id>` and `node.url` from soma. Cosmetic only: "PR #N" vs "MR !N", and located ids render long.
- Substrate quota and `rate_limit_event` (`substrate.ts`): Claude/Codex, not the forge.
- Journal, locks, sweep, routing: forge-neutral apart from the key encoding (A6).

## Suggested seam grouping for the grilling

1. **ForgeRef**: `{forge, host, path}` + node key (A1-A9, B5, H-1). Parsed once. Replaces `REPO_PATTERN`, `ID_PATTERN` and `somaRepo()`.
2. **ForgeCredentials**: read gate + write gate per forge, incl. the soma/glab boundary (B1-B8, H1, H-2). This is the riskiest part, because the obvious change silently uses the principal's glab login.
3. **ForgePort**: change request + CI + labels + comments (D, E, F1, F3, G1), grown from `GitHubPort`, with normalised states (`MergeState`, `CiVerdict`) so `merge-gate.ts` / `ci-policy.ts` stay forge-free.
4. **ForgeBudget**: GitHub-only allowance gate; GitLab gets cooldown-only and no sentinel cache to start (I1-I3).
5. **ForgeText**: closing-keyword patterns, URLs, noreply email, "PR/MR" wording (H4, A9, H-3).

## Open questions for the grilling

- **Q1.** Credential isolation for soma's glab transport: ranger-side `GLAB_CONFIG_DIR` with a per-call config, or a soma change (explicit token env opt-in)? Either needs a live probe on glab 1.80.4.
- **Q2.** Who verifies that a `--ci` cite names a runner-executed pipeline (H3): soma's close gate, or ranger's CI reader?
- **Q3.** Is the crisis-simulator map rooted at an issue (`#N`) or an epic (`claw&N`)? An epic root forces non-numeric `root` and cross-project ids.
- **Q4.** crisis-simulator project settings that can block or reshape the bot's merge: merge method, squash policy, required approvals, "pipelines must succeed", and whether CI runs on draft MRs. The answers fix F1/F2/E5.
- **Q5.** Dashboard merge on GitLab: keep the principal-tap merge under the principal's glab login (F4), or show only a link?
- **Q6.** `principal.login` per forge/host (B6). Without it, `assertNotPrincipal` cannot catch the GÉANT login.
