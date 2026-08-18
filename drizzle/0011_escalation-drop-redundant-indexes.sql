-- Redundant indexes (round-35 suggestion): `(repo)` is a prefix of
-- `(repo,node_id)` (0008) and `(repo,status,noted_at)` is a prefix of
-- `(repo,status,noted_at,created_at)` (0010) — both duplicate B-trees are
-- maintained on every bounded but frequent card upsert for no query benefit.
-- Dropped in a fresh migration (existing journal DBs keep the legacy indexes
-- harmlessly; fresh DBs never create them).
DROP INDEX `escalations_repo_idx`;--> statement-breakpoint
DROP INDEX `escalations_repo_status_noted_idx`;
