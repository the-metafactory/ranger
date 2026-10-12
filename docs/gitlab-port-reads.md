# GitLab forge reads (node #124)

`GitLabReadPort` implements `ForgeReadPort<ResolvedToken>`, the five read
methods shared with `ForgePort`. GitHub retains the default string credential
type and its existing behavior. GitLab writes and lane selection are separate
nodes; this adapter cannot perform writes.

Pass the exact token object returned by `assertReadOnlyToken` or a fresh
`tokenBatch`. Every endpoint and pagination request calls `gitlabApiRead`,
which checks the project-bound grant and creates its own private
`GLAB_CONFIG_DIR`. Copied grants and other hosts/projects are refused.

MR reads normalize `state`, `sha`, `draft`, and `detailed_merge_status`.
Per the node's binding contract, `opened` becomes `open`, `merged` becomes
`merged`, and both `closed` and `locked` become `closed`. GitLab's `locked`
state is transient while merging, so a locked MR also carries
`mergeInProgress: true` on its `ChangeRequest`. A consumer must check that
flag before treating `closed` as abandoned; wiring it into
`resolvePhase` belongs to the lane-routing node.
Unrecognized merge statuses are `unknown`; missing fields throw
`GitLabReadError`. MR lookup finds the highest iid for the source branch
across all result pages where `source_project_id === target_project_id`.
Fork MRs are skipped even when their branch name matches; direct fork MR
reads are refused. Both project ids are required positive integers.
Nullable merge metadata remains explicitly null.

Pipeline reads filter by the requested head, order by descending id, and
accept only `push` or `merge_request_event` sources. The highest qualifying
id decides every CI purpose: success is green, failed/canceled red, all
other statuses pending. No qualifying pipeline is pending. Green verdicts
carry the pipeline id, URL, and `<id>@<sha>` snapshot for citation. A head
mismatch throws. External pipelines never supply a verdict.
After validating every row on the first page containing a qualifying
pipeline, the port stops paging because ids are ordered descending.
[Merged-results pipelines](https://docs.gitlab.com/ci/pipelines/merged_results_pipelines/)
use a temporary merge-ref SHA rather than the source
head SHA. They cannot qualify for this head-only query; without a qualifying
source-head pipeline the verdict remains pending. Merge-ref verification
requires a separate policy and is outside this node.

`listComments` takes an MR iid, never an issue iid: GitLab numbers issues
and MRs separately, and every current caller passes a PR/MR number.
MR notes request `order_by=created_at&sort=asc` (oldest first) and follow numeric `X-Next-Page` headers to completion; only an empty
`X-Next-Page` ends a read. Row counts never do: GitLab can filter notes after
paginating, so a short or empty page can sit mid-collection. A page without
`X-Next-Page` (a `Link` header alone included) and invalid/backward page hints
throw rather than return partial results. System notes are dropped;
human/bot note authors use `author.username`. Unlike GitHub issue comments,
the result still includes diff and discussion notes; only `system` is
filtered, as the node specifies. Issue labels are read from
the issue endpoint, checking the requested iid and preserving `ranger:needs-eye`.

The pipeline query is by SHA only, as the node specifies, and is not scoped to
the MR's ref: a `push` pipeline for the same SHA on another branch can decide
the verdict. Ref scoping needs the head branch in `ciVerdictFor` and must
keep `merge_request_event` pipelines (`refs/merge-requests/<iid>/head`); it
is outside this node.

HTTP errors, malformed JSON, missing/invalid required fields, and transport
failures throw typed errors. Subprocess output is excluded from diagnostics
because it can contain credentials.

`test/fixtures/gitlab-reads.json` contains synthetic recorded endpoint JSON
for the stubbed `glab api` runner in `test/gitlab-port.test.ts`. These tests
prove normalization and confinement at Ranger's subprocess boundary. They
do not prove live GÉANT read permissions, glab keyring behavior, or Soma CI
verification. Live pipeline/note access must be checked with the authorized
read credential before rollout; denial must stop adoption.

API references: [merge requests](https://docs.gitlab.com/api/merge_requests/),
[pipelines](https://docs.gitlab.com/api/pipelines/), and
[notes](https://docs.gitlab.com/api/notes/).
