# Repairing a journal migrated by foreign code

When ranger refuses to start with

> refusing to open the ranger journal at …: this journal was migrated by code this ranger isn't running (N migrations not in its migrations folder: <hashes>)

some process ran a branch's code against the live journal (`~/.config/ranger/state.sqlite`) and applied migrations that `main` does not ship. The tick, `run-node` and `serve` all exit 1 with that message and claim nothing until the journal is repaired. This runbook records the 2026-10-04 repair so the next one isn't improvised.

## What happened on 2026-10-04

The live journal carried two migrations that were not on `main`:

- node #47's: `workers` re-keyed to `(repo, node_id)` with a NOT NULL `root`, and `escalations` with a NOT NULL `root`;
- node #25's `0017_research-base` (`workers.research_base_sha`).

`main`'s `upsertWorker` then failed on every claim (`ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`). The failure came after the GitHub claim, so claims leaked on #52 and #54. Since node #66 the refusal fires before any claim. A worktree's code can no longer reach the live journal: tests refuse the live directory, and worker sessions get a temp `RANGER_JOURNAL_PATH`.

## Steps

Run every step from a `main` checkout (`~/work/mf/ranger`), never from a worktree.

1. **Stop ranger.** Unload the tick and the digest so nothing opens the journal mid-repair, and stop any `ranger serve`:

   ```sh
   launchctl unload ~/Library/LaunchAgents/ch.invisible.ranger-tick.plist
   launchctl unload ~/Library/LaunchAgents/ch.invisible.ranger-escalate.plist
   pgrep -fl "ranger/src/cli.ts"   # nothing should still be running
   ```

2. **Back up.** Use SQLite's online backup, not `cp`: a copy of the main file alone loses whatever still sits in `-wal`.

   ```sh
   cd ~/.config/ranger
   sqlite3 state.sqlite ".backup state.sqlite.bak-$(date +%Y%m%d)-pre-repair"
   ```

3. **Name the foreign rows.** Compare the journal's migration hashes with the ones `main` ships:

   ```sh
   sqlite3 -readonly state.sqlite "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id"
   bun -e 'import {readMigrationFiles} from "drizzle-orm/migrator"; for (const m of readMigrationFiles({migrationsFolder: "drizzle"})) console.log(m.hash, m.folderMillis)'
   ```

   The hashes in the first list that are missing from the second are the ones the refusal named.

4. **Diff the schema against a fresh journal built by `main`.** `RANGER_JOURNAL_PATH` points `main`'s code at a scratch file, so the live journal is not touched:

   ```sh
   RANGER_JOURNAL_PATH=/tmp/ranger-fresh/state.sqlite bun src/cli.ts journal --config ranger.yaml > /dev/null
   diff <(sqlite3 -readonly /tmp/ranger-fresh/state.sqlite .schema) <(sqlite3 -readonly ~/.config/ranger/state.sqlite .schema)
   ```

   Every table that differs needs a rebuild. Tables that only gained foreign columns or keys need one too: `main`'s upserts depend on the exact keys.

5. **Rebuild the affected tables to `main`'s schema.** Do it in one transaction with foreign keys off, copying the columns both schemas share. For each affected table `<t>`:

   ```sql
   PRAGMA foreign_keys = OFF;
   BEGIN;
   ALTER TABLE <t> RENAME TO <t>_foreign;
   -- paste main's CREATE TABLE <t> … and its CREATE INDEX statements from the fresh .schema
   INSERT INTO <t> (<shared columns>) SELECT <shared columns> FROM <t>_foreign;
   DROP TABLE <t>_foreign;
   COMMIT;
   PRAGMA foreign_keys = ON;
   ```

   Rows that collide under `main`'s keys (for example, one node on two map roots) have to be resolved by hand before the `INSERT`. Keep the newest row and record the dropped one.

6. **Delete the foreign migration rows**, by hash, as named by the refusal:

   ```sql
   DELETE FROM __drizzle_migrations WHERE hash IN ('<hash>', '<hash>');
   ```

7. **Check.**

   ```sh
   sqlite3 ~/.config/ranger/state.sqlite "PRAGMA integrity_check; PRAGMA foreign_key_check;"
   diff <(sqlite3 -readonly /tmp/ranger-fresh/state.sqlite .schema) <(sqlite3 -readonly ~/.config/ranger/state.sqlite .schema)
   ~/bin/ranger journal --config ranger.yaml > /dev/null && echo opens
   ```

   `integrity_check` prints `ok`, `foreign_key_check` prints nothing, the schema diff is empty, and the journal opens without the refusal.

8. **Release leaked claims.** A claim taken while the journal was broken has no worker row behind it. Release it with `soma graph release`, under the machine account.

9. **Unpause.** If the dead-man switch paused claiming, clear it, then reload the schedule:

   ```sh
   ~/bin/ranger resume-run --config ranger.yaml
   launchctl load ~/Library/LaunchAgents/ch.invisible.ranger-tick.plist
   launchctl load ~/Library/LaunchAgents/ch.invisible.ranger-escalate.plist
   ```

   Watch the next tick in `~/.config/ranger/logs/walk.stderr.log`.

## Keeping it from happening again

- The live wrapper `~/bin/ranger` must `unset RANGER_JOURNAL_PATH` before it execs the CLI, so a live process never inherits a worker session's journal. `ops/bin/ranger.example` is the versioned copy.
- Never run `bun src/cli.ts …` from a worktree without `RANGER_JOURNAL_PATH` pointing at a scratch file. The tracked `ranger.yaml` sets no `state.journalPath`, so its default is the live journal.
