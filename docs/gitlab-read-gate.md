# GitLab read gate (node #122)

GitLab maps require a forge and host qualified read-token prefix:

```yaml
auth:
  readOnlyTokens:
    "gitlab:gitlab.example.org/team/": RANGER_READONLY_GITLAB_TOKEN
```

Bare prefixes, `*`, and `defaultTokenEnv` remain GitHub-only. GitLab PATs
must expose a `scopes` array limited to `read_api` and `read_repository`.
Each new token batch checks `personal_access_tokens/self`, then proves
project access before any graph read. A grant belongs to that token object
and project; copying it or using it against another project refuses.

Ranger creates a separate private config dir for each glab GET and soma
graph read, and passes it as `GLAB_CONFIG_DIR`. On-disk tests assert the
single host and credential, directory mode 0700, file mode 0600, and removal
in `finally`, including spawn errors. The child environment allow-list keeps
PATH, HOME, temporary-directory variables, locale variables and TZ; it
excludes inherited credential variables (including GitHub and arbitrarily
named write tokens) and CLI overrides. GitLab reads bypass GitHub's GraphQL
budget endpoint and retain throttle cooldowns. GitLab write execution
remains gated pending the separate write and lane nodes.

These tests use a stubbed runner or a fixture executable. They prove what
Ranger writes and passes to the child, **not** how a real Soma installation
selects its credential, honors `SOMA_GRAPH_READONLY=1`, or accesses a
keyring. That flag is a request to Soma, not verified confinement evidence.
Soma confinement remains unverified here and requires the separate
the-metafactory/soma#754 probe; this node does not implement that probe.
Do not treat these passing tests as proof of end-to-end Soma confinement.

## Principal's Mac probe — required before rollout

Run under the principal's normal Mac login, where their glab keyring is
available, outside CI:

```sh
bun scripts/probe-glab-keyring.ts gitlab.software.geant.org
```

The probe writes the same isolated config with an empty token and runs
`glab api user --hostname <host> --include`. It passes only on HTTP 401.
Any other result requires stopping and escalating node #122. Include the
literal output and glab version in the supervisor's PR description.

[glab 1.80.4's `fileConfig.GetWithSource`](https://gitlab.com/gitlab-org/cli/-/blob/v1.80.4/internal/config/config.go) attempts a keyring lookup for an
empty host token. Normal gated reads use a nonempty token and skip that
branch. Source inspection does not establish whether the principal has a
reachable keyring entry; the Mac probe must settle that before rollout.

Worker status: probe script verified with stubbed responses; **principal Mac
probe not run by the machine-account worker**. No live result is claimed.
The supervisor must obtain and record the principal Mac output before the
checkpoint. That glab probe alone also does not establish Soma confinement;
the separate Soma probe is required before claiming confined live graph reads.
