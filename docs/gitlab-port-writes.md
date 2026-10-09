# GitLab forge writes (node #125)

`GitLabPort(config, runner?, env?)` extends `GitLabReadPort` with
`createDraftPr`, `updatePrBody`, `markReady`, and `postComment`, using the
existing `ForgePort` names. Its read methods still require the exact
project-bound `ResolvedToken` from the read gate. Writes take a string
credential matching the configured machine token. The squash merge and
the rebase it may need are described in [gitlab-merge.md](gitlab-merge.md)
(node #126); lane selection belongs to a separate node.

Every mutation rechecks `assertWriteIdentity`: the credential must resolve
from the configured mapping, differ from the host's principal, and identify
this project's access-token bot. `gitlabApiWrite` confines each call to an
isolated `GLAB_CONFIG_DIR` and enforces inherited read-only policy. An
identity refusal may send verification GETs, but never a mutation. Missing
credentials or host policy refuse before any subprocess call.

Draft creation posts source/target branches, a `Draft: ` title, description,
and boolean `remove_source_branch: false`. Description updates send only
`description`. Readiness removes one leading `Draft: ` from the supplied
change request title; without that exact prefix it is a no-op. Comments
post to the MR notes endpoint and return a positive integer note id.
String fields use glab raw fields to preserve literal text; the boolean
uses a typed field.

Non-2xx HTTP responses, nonzero exits, and transport failures throw
`GitLabWriteError` without retrying or echoing subprocess output. Draft
and note responses must have valid required fields; malformed responses
also fail without retrying because the mutation may already have occurred.

`test/gitlab-port-writes.test.ts` verifies the stubbed glab boundary,
identity refusals, field arguments, normalization, failure behavior, and
config cleanup. It makes no live writes and does not attest GÉANT setup.

API contracts: [merge requests](https://docs.gitlab.com/api/merge_requests/),
[MR notes](https://docs.gitlab.com/api/notes/#create-a-merge-request-note),
and [glab fields](https://docs.gitlab.com/cli/api/).
