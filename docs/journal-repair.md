# Repairing a journal migrated by foreign code

When ranger refuses to start with

> refusing to open the ranger journal at …: this journal was migrated by code this ranger isn't running (N migrations not in its migrations folder: <hashes>)

some process ran a branch's code against the live journal (`~/.config/ranger/state.sqlite`) and applied migrations that `main` does not ship. The tick, `run-node` and `serve` all exit 1 with that message and claim nothing until the journal is repaired. This runbook records the 2026-10-04 repair so the next one isn't improvised.

## What happened on 2026-10-04

The live journal carried two migrations that were not on `main`:

- node #47's: `workers` re-keyed to `(repo, node_id)` with a NOT NULL `root`, and `escalations` with a NOT NULL `root`;
- node #25's `0017_research-base` (`workers.research_base_sha`).

`main`'s `upsertWorker` then failed on every claim (`ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`). The failure came after the GitHub claim, so claims leaked on #52 and #54. Since node #66 the refusal fires before any claim, and the two routes branch code took are closed: under `bun test` the live directory is refused (by real path, so a symlink does not get around it), and worker sessions and the supervisor's test command get a temp `RANGER_JOURNAL_PATH`. Branch code run by hand is not fenced: `bun src/cli.ts …` from a worktree without `RANGER_JOURNAL_PATH` still defaults to the live journal, and the refusal only catches it after it has applied a migration `main` lacks (see the last section).

## Steps

Run every step from a `main` checkout (`~/work/mf/ranger`), never from a worktree. Run steps 2 to 7 in one shell: `$J` and `schema` are defined there.

1. **Stop ranger.** Unload the tick and the digest so nothing opens the journal mid-repair, and stop any `ranger serve`:

   ```sh
   launchctl unload ~/Library/LaunchAgents/ch.invisible.ranger-tick.plist
   launchctl unload ~/Library/LaunchAgents/ch.invisible.ranger-escalate.plist
   pgrep -fl "ranger/src/cli.ts"   # nothing should still be running
   ```

2. **Back up.** Use SQLite's online backup, not `cp`: a copy of the main file alone loses whatever still sits in `-wal`.

   ```sh
   J=~/.config/ranger/state.sqlite
   sqlite3 "$J" ".backup $J.bak-$(date +%Y%m%d)-pre-repair"
   ```

   The later steps use `$J`. Stay in the `main` checkout: the migrations lookup and `bun src/cli.ts` resolve relative to it.

3. **Name the foreign rows.** Compare the journal's migration hashes with the ones `main` ships:

   ```sh
   sqlite3 -readonly "$J" "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id"
   bun -e 'import {readMigrationFiles} from "drizzle-orm/migrator"; for (const m of readMigrationFiles({migrationsFolder: "drizzle"})) console.log(m.hash, m.folderMillis)'
   ```

   The hashes in the first list that are missing from the second are the ones the refusal named. If one of them belongs to a migration `main` still ships under the same tag, then someone edited a committed migration file after it was applied. In that case, revert the edit on `main` instead of repairing the journal.

4. **Diff the schema against a fresh journal built by `main`.** `RANGER_JOURNAL_PATH` points `main`'s code at a scratch file, so the live journal is not touched:

   ```sh
   RANGER_JOURNAL_PATH=/tmp/ranger-fresh/state.sqlite bun src/cli.ts journal --config ranger.yaml > /dev/null
   schema() { sqlite3 -readonly "$1" "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY tbl_name, type DESC, name" | sed -e 's/[`"]//g'; }
   diff <(schema /tmp/ranger-fresh/state.sqlite) <(schema "$J")
   ```

   `schema` drops quoting and orders statements by table (each table before its indexes), so a rebuilt table compares equal: SQLite re-quotes a renamed table's `CREATE TABLE` and stores it in a new position.

   Every table that differs needs a rebuild. Tables that only gained foreign columns or keys need one too: `main`'s upserts depend on the exact keys.

5. **Rebuild the affected tables to `main`'s schema.** Do it in one transaction with foreign keys off, copying the columns both schemas share. Follow SQLite's own order (create the new table, copy, drop the old, rename the new): renaming the old table instead would keep its index names, so `main`'s `CREATE INDEX` statements would collide with them. For each affected table `<t>`:

   ```sql
   PRAGMA foreign_keys = OFF;
   BEGIN;
   -- main's CREATE TABLE <t> … from the fresh .schema, with the name changed to <t>_new
   CREATE TABLE <t>_new (…);
   INSERT INTO <t>_new (<shared columns>) SELECT <shared columns> FROM <t>;
   DROP TABLE <t>;  -- drops <t>'s old indexes with it
   ALTER TABLE <t>_new RENAME TO <t>;
   -- main's CREATE INDEX … ON <t> statements from the fresh .schema, unchanged
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
   sqlite3 "$J" "PRAGMA integrity_check; PRAGMA foreign_key_check;"
   diff <(schema /tmp/ranger-fresh/state.sqlite) <(schema "$J")
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

- The live wrapper `~/bin/ranger` must `unset RANGER_JOURNAL_PATH RANGER_UNDER_TEST`, and unset `NODE_ENV` when it is `test`, before it execs the CLI, so a live process never inherits a worker session's journal or either test-mode marker. `ops/bin/ranger.example` is the versioned copy.
- Run `bun test` from the repo root. Test mode comes from `RANGER_UNDER_TEST`, which the preload in `bunfig.toml` sets, or from `NODE_ENV=test`. Bun reads `bunfig.toml` from the working directory only and gives no other sign of a test run, so `NODE_ENV=production bun test` started elsewhere (or with `--config` pointing at another file) runs without the live-journal fence.
- Never run `bun src/cli.ts …` from a worktree without `RANGER_JOURNAL_PATH` pointing at a scratch file. The tracked `ranger.yaml` sets no `state.journalPath`, so its default is the live journal.
