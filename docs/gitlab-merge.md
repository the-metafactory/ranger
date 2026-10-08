# GitLab squash merge and rebase (node #126)

Ruling Q4 of ranger issue #97 says the project keeps its `rebase_merge`
setting and ranger adapts. Ranger rebases when GitLab asks it to, waits,
re-gates the new head, and then merges with `squash=true` pinned to the
gated head. It refuses when the project disallows squash.

## Port

`GitLabPort` (in `src/gitlab.ts`) adds three operations:

- `squashRefusal(repo, read)` reads `squash_option` from `GET projects/:id`.
  `always`, `default_on` and `default_off` pass. `never` returns a refusal.
  A missing or unknown value throws `GitLabReadError`, so it fails closed.
- `mergePr(repo, iid, sha, title, write)` sends
  `PUT …/merge_requests/:iid/merge` with `squash=true` (a typed field),
  `sha=<gated head>` and `squash_commit_message=<title> (!<iid>)`. The
  results:
  - 409 is `head-moved`.
  - 405, 406 and 422 are `not-mergeable`, carrying GitLab's own
    `message`, bounded to one line.
  - A 200 that is not squashed is `refused`, for escalation.
  - Any other status throws.

  glab exits nonzero on an HTTP error but still prints the status line,
  so the status decides the result. Subprocess output is never surfaced.
- `rebaseAndWait(repo, iid, { read, write })` first reads
  `GET …/merge_requests/:iid?include_rebase_in_progress=true` under the
  read credential. If a rebase is already running (an earlier pass started
  it), it waits on that rebase and sends no new request. Otherwise it sends
  `PUT …/merge_requests/:iid/rebase`. It then polls the same read, up to
  10 checks at 2 s each. The results:
  - A head that moved is `head-moved` with the new SHA, even beside a
    stale `merge_error`.
  - A `merge_error` on an unchanged head, or a refused request, is
    `not-mergeable`.
  - A 409 on the request (GitLab could not enqueue it yet), or still
    rebasing at the bound, is `pending`.

  It never merges.

`gitlabForgePort(config)` wraps the port in the lanes' string-credential
`ForgePort` shape:

- Writes take the machine write token and go through the write gate.
- Reads ignore that token and use the map's read-only credential.
- The read credential is gated once per adapter, so make a new adapter
  per desk pass.

## Merge desk

`runMergeDesk` uses `deskPort(config, map)`: the GitLab adapter for
`gitlab:` maps and `realGitHub` for every other map. GitHub never reports
`needs-rebase` and has no `rebasePr`, so its path is unchanged.

On a GitLab map, the desk acts in this order:

1. The send-back checks run first. One check is GitLab-specific: no review
   at the head, and the latest `rebased` journal event comes from the head
   of the latest review. That case is ranger's own rebase, so the row goes
   back to run-node for a fresh round. It is not parked.
   - A review never carries across a rebase.
   - A head moved by anyone else still fails `review-clean` and parks, as
     on GitHub.
2. The gate is evaluated. For `needs-rebase` it treats the merge state as
   mergeable, so ranger rebases only a change it would merge.
3. The `ranger:needs-eye` labels are read through the port. A labelled
   node, a manual map, or a superseded-major hold posts the merge card, as
   on GitHub. Under `needs-rebase` the card adds a line asking the
   principal to rebase first.
4. If ranger merges, it reads `squashRefusal` first. On `never` it parks
   with a card, before any rebase or merge write.
5. Under `needs-rebase`, ranger runs `rebasePr` and records a `rebased`
   event (`from=<gated head> …`). The row stays pending, and nothing merges
   in that pass.
6. Otherwise ranger runs `mergePr`:
   - `head-moved` stays pending and is re-gated next pass.
   - `not-mergeable` and `refused` park with the reason.
   - `merged` takes the existing merged path.

GitLab's `auto_merge` and the dashboard tap merge are out of scope.
GitLab execution stays refused by `executionRefusal` until the
lane-routing node lands, so the desk tests call `runMergeDesk` directly.

## Tests

- `test/gitlab-port-merge.test.ts` uses a stubbed glab boundary. It covers
  the merge arguments, status mapping, squash option, bounded rebase poll,
  credential separation, and that no credential is echoed.
- `test/gitlab-merge-desk.test.ts` drives the desk with a fake GitLab
  port through needs-rebase → pending → mergeable → merged. It also covers
  each refusal path, the needs-eye hold-back, and port selection.

Neither test makes a live call. The assumption that crisis-simulator's
squash option permits `squash=true` is checked at run time by
`squashRefusal` and by the `squash` field of the merge response.
