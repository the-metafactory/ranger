# Research: can sage review a working tree? (node #3)

**Date:** 2026-08-15 · **Sources:** installed sage `~/.config/metafactory/pkg/repos/sage` (v0.2.7, commit `5740174`, what `~/bin/sage` runs) and dev tree `~/work/mf/sage` (commit `de36cc3`, 2026-08-04 — same forge surface); cortex dev tree `~/work/mf/cortex`. All file:line citations below are into the installed sage repo unless marked otherwise.

## Answer in one line

**No — sage has no working-tree/local-diff mode today; every entry point is PR-shaped.** Adding one upstream is a clean, moderate change (one new `ForgeBackend` + CLI wiring; the lens pipeline needs zero changes). **Draft-PR-first works mechanically today** — neither sage nor cortex gates on draft status — and preserves most, but not literally all, of the pre-PR review invariant's intent.

## 1. CLI surface: all entry points are PR-shaped

`sage --help` exposes exactly three commands: `review <pr-ref>`, `dispatch <pr-ref>`, `init` (`src/cli/index.ts:54-235`).

- `sage review <pr-ref>` — offline single review, no bus. The argument must parse as a PR/MR ref: `https://github.com/OWNER/REPO/pull/N` or `OWNER/REPO#N` (GitHub regexes at `src/forge/github/backend.ts:45-46`, parse throws on anything else at `:58-60`). GitLab equivalents via `GROUP/PROJ!N`.
- `sage dispatch <pr-ref>` — publishes a code-review task envelope to the Myelin bus; cortex's in-process `ReviewConsumer` receives it and invokes sage's `reviewPr` as an injected `pipelineRunner` (`src/cli/index.ts:143-152`). Also PR-ref-shaped.
- `sage init` — config scaffolding only.

There is no `--local`, `--diff`, `--working-tree`, path argument, or stdin-diff mode anywhere in the CLI (checked both installed and dev trees; the dev tree's newest branches add lens-refusal and forge-selection work, nothing working-tree-shaped).

## 2. Where the diff comes from — and why a local mode is cheap

The whole review workflow consumes **data, not a checkout**:

- `reviewPr` fetches three things in parallel: `forge.prView(ref)` (metadata), `forge.prDiff(ref)` (unified diff **string**), and prior findings (`src/lenses/workflow.ts:122-126`). Architecture docs are fetched from the **base branch** via `forge.repoFile(ref, path, {refName: baseRefName})` (`src/lenses/workflow.ts:134-140`).
- Each lens gets everything as **text on stdin** — `buildStdinContent(pr, diff, priorFindings, architectureDocs)` renders metadata + file list + PR body + prior findings + the unified diff into one string (`src/lenses/base.ts:154-191`), and the substrate call is pure text-in/JSON-out (`src/lenses/base.ts:215-233`). **Lenses never touch a filesystem checkout.**
- The GitHub backend implements `prDiff` as literally `gh pr diff N --repo owner/repo` (`src/forge/github/backend.ts:102-105`) and `prView` as `gh pr view --json …` validated against `PrMetadataSchema` (`:70-100`).
- The seam is the deliberately narrow, forge-agnostic `ForgeBackend` interface: `parseRef / prView / prDiff / repoFile / postReview / reviewSource / authStatus` (`src/forge/types.ts:200-241`). The workflow is explicitly designed so "adding a third forge is a single new backend file, not a workflow rewrite" (`src/lenses/workflow.ts:30-37`).

### What adding a working-tree mode would take (UPSTREAM, in sage)

One new backend + CLI wiring; no lens/pipeline/verdict changes:

1. **`src/forge/local/backend.ts` — `LocalGitBackend implements ForgeBackend`** (~200-300 lines, mirroring the GitHub facade):
   - `prDiff` → `git diff <base>...HEAD` plus uncommitted changes (`git diff <base>` covers staged+unstaged vs base; untracked files need `git add -N` or explicit inclusion).
   - `prView` → synthesize `PrMetadata` from git: branch name → `headRefName`, `HEAD` SHA → `headRefOid`, `git diff --numstat` → files/additions/deletions, `git config user.name` → author, `isDraft: true`, `number: 0`. Only friction: `url` must satisfy `z.string().url()` (`src/forge/types.ts:85`) — a `file:///…` URL passes.
   - `repoFile(ref, path, {refName})` → `git show <refName>:<path>` (base-branch reads, exactly what the architecture-docs loader wants).
   - `reviewSource` → empty source, no prior findings; the in-memory pattern already exists (`src/prior-findings/in-memory-source.ts:22-33`).
   - `postReview` → refuse/no-op (nothing to post to); the verdict is already persisted to disk before any post (`src/lenses/workflow.ts:173-176`), so the operator gets the rendered verdict on stdout + the recovery file.
   - `authStatus` → always ok.
2. **CLI wiring**: either `sage review --working-tree [path] --base <ref>` bypassing `parsePrRef`, or a `sage review-local` subcommand. `ForgeKind` is currently `"github" | "gitlab"` (`src/forge/types.ts:24`); the local backend can either extend the union or be constructed outside `selectForge`.
3. **Scope limit**: this is CLI-only by nature. The `dispatch`/bus path stays PR-shaped — a working tree on one machine is not addressable by a bus consumer on another. That's fine for ranger: the pre-PR review runs in the worker's own session, offline (`sage review` mode, no cortex dependency — which also sidesteps the cortex head-of-line/DORMANT failure classes for this review round).

Estimate: a focused sage PR — one backend file + CLI flag + tests. The architecture was built for exactly this kind of extension.

## 3. Draft-PR alternative: works mechanically today

- **Sage never branches on draft status.** `isDraft` is fetched into `PrMetadata` (`src/forge/types.ts:62`; requested from `gh` at `src/forge/github/backend.ts:68`; GitLab maps `draft`/`work_in_progress` at `src/forge/gitlab/backend.ts:184`) but **no code in the review workflow, lens scheduler, verdict, or dispatch path reads it** — grep over both sage trees finds zero consumers. `buildStdinContent` doesn't even show the lenses the draft flag (`src/lenses/base.ts:175-191`).
- **Cortex's review path has no draft gate either**: grep for `draft`/`isDraft` across `src/runner/review-pipeline.ts`, `sage-runner.ts`, `dispatch-listener.ts`, `review-consumer-boot.ts`, `review-prompt.ts` in `~/work/mf/cortex` returns nothing. Reviews are triggered explicitly (`sage dispatch` / pilot request-review), not by PR-open webhooks (the webhook receiver's PR-opened path feeds the public-offer tap, not review dispatch — cortex `src/taps/gh-webhook-receiver/server.ts:170-171`).
- **GitHub allows it**: `gh pr view`, `gh pr diff`, and `gh pr review --comment` all work on draft PRs (drafts block *merging*, not reviewing). Sage posts `--comment` verdicts on self-authored PRs anyway (self-approve is downgraded — `src/forge/github/backend.ts:145,164-184`), so the draft flow hits no new posting edge.

### Does draft-PR-first preserve the invariant's intent?

The invariant (ranger `design/ranger-design.md:114`): **working-tree review before the PR exists** — review before the PR body is written / before overclaims land in prose / before the PR "counts" (e.g. the #588 fail-open: closing keywords auto-closing gated nodes).

- **Mostly yes, with one honest gap.** A draft PR is not mergeable, is visibly WIP, and triggers no review machinery on its own — so "the PR doesn't count yet" is preserved. Closing-keyword auto-close only fires **on merge**, and a draft can't merge, so the #588 fail-open path stays closed while drafted (the SOP's no-closing-keywords rule still applies for the eventual merge).
- **The gap:** a draft PR still requires *a* body at creation, so "review before the PR body is written" is not literally satisfied. Mitigation that preserves the spirit: open the draft with a stub/minimal body, let sage review the diff, then write the real body when marking ready — and note that sage's overclaim check (lenses see `pr.body` in stdin, `src/lenses/base.ts:181-182`) can only ever run *after* a body exists, so a true working-tree mode wouldn't catch body overclaims either. The body-vs-diff check structurally belongs to the post-ready review round in both designs.
- **Cost of draft-first vs working-tree:** the draft flow depends on the cortex/bus path being healthy if dispatched (head-of-line blocking, DORMANT consumer — known failure classes), or on offline `sage review <ref>` against the draft (which works and needs no cortex). It also creates a public artifact (branch + PR) before any review has happened, and burns a PR number per attempt.

## 4. Recommendation for the mechanism decision node

Run **draft-PR-first with offline `sage review` as the interim** (zero upstream work, no cortex dependency for the pre-PR round, no draft gates anywhere in the path), and file the **sage working-tree backend as a small upstream issue** — the `ForgeBackend` seam makes it a contained, single-file-plus-CLI change whenever the interim's PR-number noise or pre-review-public-branch exposure starts to hurt.
