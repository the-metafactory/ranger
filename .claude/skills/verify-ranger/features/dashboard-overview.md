# Dashboard overview

The local dashboard shows the principal what ranger is doing: rows that need
them (failed, parked, awaiting a needs-eye merge), open grillings and
decisions per map, autonomous nodes, the next queued node per lane, the
running worker, and each substrate's quota and recent runs.

## Sub-features

- `overview-load` the page reads `/api/state` and `#meta` leaves "loading…".
- `overview-needs` `#needsyou` has one card per `needsYou` row, led by an "awaiting-merge row(s) not yet checked" notice when `needsYouUnchecked` is non-empty; with no rows and no notice it shows the empty line "Nothing is parked, failed or waiting on a needs-eye merge."
- `overview-grill` `#grill` lists every grilling and decision per map, with counts.
- `overview-queue` `#next` shows each lane (visual, headless) with its holder or "free".
- `overview-current` `#current` shows the running worker or "No worker is running."
- `overview-substrates` `#substrates` shows claude, codex, pi with eligibility.
- `overview-refresh` `#refresh` posts `/api/refresh` and `#msg` says "Refreshing the frontier…".

## How to get to it (user POV)

- Open `http://127.0.0.1:7311` (live; the verify instance is 7399).
- `ranger serve --open` opens it in the browser.

## Driving it with drive.ts (Playwright)

Preconditions: baseline from the README.

- **Load.** Run `bun scripts/drive.ts "$RUN"`. Expect `ok page read /api/state` and `ok six sections rendered: Needs you | Needs your decision | Autonomous — ranger can take these | Next in queue | Current job | Substrates`.
- **Needs you.** Same run. Expect `ok Needs you shows N entries, state implies N`.
- **Decisions.** Same run. Expect `ok all N grillings in state appear under "Needs your decision"`.
- **Refresh.** Run `bun scripts/drive.ts "$RUN" --refresh`. Expect `ok Refresh posted /api/refresh -> 202`, and `<stamp>-after-refresh.png`.
- **Guard.** Every run prints `ok guard aborts action POSTs (/api/merge blocked)` and `<stamp>-network.log` lists `POST /api/merge BLOCKED`.
- **Proof.** `<stamp>-dashboard.png`, `<stamp>-state.json`, `<stamp>-dom.json`, `<stamp>-network.log` in `$RUN/evidence/`.

## Gotchas

- Registered maps render from the tick's frontier cache in the journal, so Refresh re-reads only serve-only maps (`serve.extraMaps`); it changes nothing for the rest.
- The page polls `/api/state` every 15 s; assert after `#meta` changes, not on a fixed sleep.
- Needs-you titles show "(title not read yet)", and current-job and queued-resume rows "(title not in the frontier read)", until serve's own REST read lands; it is not a rendering bug.
- The page token rotates on every serve restart; a page from a previous launch gets "token refused".
- The buttons in each Needs-you card (Resume or Queue resume, Merge, Open session) are outward actions; the guard blocks them.
