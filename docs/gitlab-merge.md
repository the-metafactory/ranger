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
  - A 200 that is not squashed is still `merged`, with an `unsquashed`
    note. The merge happened, so the desk records it and closes, and the
    note escalates it.
  - Any other status throws.

  glab exits nonzero on an HTTP error but still prints the status line,
  so the status decides the result. Subprocess output is never surfaced.
- `rebaseAndWait(repo, iid, { read, write })` first reads
  `GET …/merge_requests/:iid?include_rebase_in_progress=true` under the
  read credential. If a rebase is already running (an earlier pass started
  it), it waits on that rebase and sends no new request. Otherwise it sends
  `PUT …/merge_requests/:iid/rebase`. It then polls the same read, up to
  2 checks 1.5 s apart. The wait is short on purpose: the desk re-reads
  the head next pass, and a long wait would hold up later rows. The
  results:
  - A head that moved is `head-moved` with the new SHA, even beside a
    stale `merge_error`.
  - A `merge_error` on an unchanged head, or a request GitLab refuses
    (403, 405, 422), is `not-mergeable`.
  - Any other failed request (a 5xx, a 429, a 401) throws
    `GitLabWriteError`. The desk records an error and retries next pass;
    it does not park.
  - A 409 on the request (GitLab could not enqueue it yet), still
    rebasing at the bound, or a finished rebase that left the head where
    it was, is `pending`.

  Every outcome but `not-mergeable` carries `requested`: whether this
  call sent the rebase request, or only waited on a running one. It never
  merges.

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
   at the head, and the latest `rebased` journal event goes from the head
   of the latest review to the current head, a landing ranger saw itself.
   That case is ranger's own rebase, so the row goes back to run-node for
   a fresh round. It is not parked.
   - A review never carries across a rebase.
   - A head moved by anyone else still fails `review-clean` and parks, as
     on GitHub. That includes a push past ranger's rebase head.
   - A head that moved while ranger knew its rebase only as `pending`
     (the rebase outlasted the 3 s wait and landed between passes) also
     goes back for a fresh round. Nothing ranger reads tells its rebase
     from another push there, so auto-merge is held: while the latest
     `rebased` event is pending and its `from` is not the gated head,
     the row ends at the merge card, with a note asking the principal to
     confirm the moved head is ranger's rebase. Ranger never merges it.
2. The gate is evaluated. For `needs-rebase` it treats the merge state as
   mergeable, so ranger rebases only a change it would merge.
3. The `ranger:needs-eye` labels are read through the port. A labelled
   node, a manual map, or a superseded-major hold posts the merge card, as
   on GitHub. Under `needs-rebase` the card adds a line asking the
   principal to rebase first.
4. If ranger merges, it reads `squashRefusal` first, once per desk pass.
   On `never` it parks with a card, before any rebase or merge write.
5. Under `needs-rebase`, ranger runs `rebasePr` and records a `rebased`
   event through `journal.recordRebase`, which `journal.listRebases` reads
   back as `{ from, to, requested }`. Its prose says the head moved only on
   `head-moved`; on `pending` it says the rebase was asked for. The row
   stays pending, and nothing merges in that pass. The event's prefix
   records `from`, `to` (only when ranger saw the head move) and `wait`
   (when no request was sent). From one head, ranger sends at most 3
   requests and spends at most 10 passes (requests plus waits), then
   parks the row with a card that gives both counts. A moved head starts
   a new count.
6. Otherwise ranger runs `mergePr`:
   - `head-moved` stays pending and is re-gated next pass.
   - `not-mergeable` parks with the reason.
   - `merged` takes the existing merged path. An `unsquashed` merge says
     so in the `merged` event and the notice, which carries a warning
     line for the principal.

`mergePr` reports refusals per adapter, as its doc on `ForgePort` says.
GitHub's throws on every refusal, unchanged. GitLab's answers
`head-moved` and `not-mergeable` and throws only on a fault.

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
squash option permits `squash=true` has one pre-merge check:
`squashRefusal`. The `squash` field of the merge response only detects,
after the merge has landed, a squash GitLab did not honour; the desk
then records the merge and escalates it.

## What lands on the target

The MR's commits land as one squash commit. Under `rebase_merge`
(semi-linear history) GitLab also writes a merge commit beside it, so
the target gains two commits, and only the squash commit carries the
change. Neither the tests nor this node check the target's history.
