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
Unrecognized merge statuses are `unknown`; missing fields throw
`GitLabReadError`. MR lookup finds the highest iid for the source branch
across all result pages. Nullable merge metadata remains explicitly null.

Pipeline reads filter by the requested head, order by descending id, and
accept only `push` or `merge_request_event` sources. The highest qualifying
id decides every CI purpose: success is green, failed/canceled red, all
other statuses pending. No qualifying pipeline is pending. Green verdicts
carry the pipeline id, URL, and `<id>@<sha>` snapshot for citation. A head
mismatch throws. External pipelines never supply a verdict.

MR notes follow numeric `X-Next-Page` headers to completion. If headers are
absent, full pages continue until a short page. Invalid/backward page hints
throw rather than return partial results. System notes are dropped;
human/bot note authors use `author.username`. Issue labels are read from
the issue endpoint, preserving `ranger:needs-eye`.

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
