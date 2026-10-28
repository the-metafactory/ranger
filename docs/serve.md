# The dashboard

`ranger serve` runs a local dashboard on `127.0.0.1` (port 7311 by default, `serve.port`). It shows the current job, the next in the queue, the autonomous nodes, and the open grillings, with a button that opens an interactive session in the map's `localCheckout` (#37).

## Verbs the dashboard runs

The dashboard runs a few operator verbs for the principal (node #166):

- **Drain** and **Undrain** on the visual lane's header run `ranger drain --lane visual`, with `--off` to undrain. Each headless map has the same buttons, which run `--map`. A visual map has no drain of its own.
- **Queue resume** on a parked or failed card runs `resume-node <id> --when-free`. The button appears where that verb would queue.
- A queued node shows its place in the queue and a **Cancel** button, which runs `--cancel`.

Each lane lists its queue in order. A head that the journal lets start shows as next, ahead of any frontier claim. The walk's forge check (a closed node, a merged PR) and its identity check come later and can still drop or defer that head.

An entry that the tick will drop, such as one on a `walk: none` map or a row back in flight, shows why and holds nothing behind it. A queued resume on a busy host does the same and shows "waiting for a quiet host: load X on N cores". Its parked card's reason class is `host load`. [Lanes and the resume queue](lanes.md) describes these rules.

When `serve` refuses an action, for example an unknown map or a node with no queued entry, it shows the error and runs nothing. When a verb exits non-zero, the dashboard shows the exit code and the error. A verb that timed out or never started may already have taken effect, so reload the page to see the current state.

## Run the dashboard under launchd

`ranger serve` runs under launchd (node #348):

1. Copy `ops/launchd/ch.invisible.ranger-serve.plist.example` to `~/Library/LaunchAgents/ch.invisible.ranger-serve.plist`.
2. Replace `__USER__` in the copy.
3. Load the job with `launchctl load`.

The job runs `~/bin/ranger serve`, so it has the tick's environment. It logs to `~/.config/ranger/logs/serve.log`, and launchd keeps it alive. To restart it, kill its process, and launchd starts it again.

When the tick migrates the journal past the code that `serve` started with, the next state read logs the refusal and exits 1. Launchd then restarts `serve` on the code now on disk. A `serve` that starts on a journal that is already past its code stays up and shows the refusal on the page instead, because an exit would restart it in a loop. Fix the checkout or the journal (see [repairing a journal](journal-repair.md)), then restart it.
