-- Append after the substrate migrations despite the checkpoint-required filename.
-- Legacy roots are supplied by openDb from the registered map configuration.
CREATE TABLE workers_root (node_id text NOT NULL, repo text NOT NULL, root integer NOT NULL,
pid integer, status text DEFAULT 'claimed' NOT NULL, attempts integer DEFAULT 0 NOT NULL,
worktree text, started_at text, finished_at text, outcome text, message_id text,
lane text, generation integer DEFAULT 0 NOT NULL, worker_pgid integer, phase text,
pr_number integer, review_round integer DEFAULT 0 NOT NULL, verdict_sha text,
verdict_blockers integer, merge_message_id text, substrate text, PRIMARY KEY (repo, node_id));
--> statement-breakpoint
INSERT INTO workers_root (node_id, repo, root, pid, status, attempts, worktree, started_at, finished_at, outcome, message_id, lane, generation, worker_pgid, phase, pr_number, review_round, verdict_sha, verdict_blockers, merge_message_id, substrate) SELECT node_id, repo, (SELECT root FROM ranger_legacy_roots WHERE ranger_legacy_roots.repo = workers.repo), pid, status, attempts, worktree, started_at, finished_at, outcome, message_id, lane, generation, worker_pgid, phase, pr_number, review_round, verdict_sha, verdict_blockers, merge_message_id, substrate FROM workers;
--> statement-breakpoint
DROP TABLE workers;
--> statement-breakpoint
ALTER TABLE workers_root RENAME TO workers;
--> statement-breakpoint
CREATE TABLE escalations_root (key text PRIMARY KEY NOT NULL, repo text NOT NULL, node_id text NOT NULL, root integer NOT NULL,
title text, route text, last_content text, channel_id text, message_id text NOT NULL,
created_at text NOT NULL, last_edited_at text, status text DEFAULT 'open' NOT NULL, noted_at text);
--> statement-breakpoint
INSERT INTO escalations_root (key, repo, node_id, root, title, route, last_content, channel_id, message_id, created_at, last_edited_at, status, noted_at) SELECT key, repo, node_id, (SELECT root FROM ranger_legacy_roots WHERE ranger_legacy_roots.repo = escalations.repo), title, route, last_content, channel_id, message_id, created_at, last_edited_at, status, noted_at FROM escalations;
--> statement-breakpoint
DROP TABLE escalations;
--> statement-breakpoint
ALTER TABLE escalations_root RENAME TO escalations;
--> statement-breakpoint
CREATE INDEX escalations_repo_node_idx ON escalations (repo, node_id);
--> statement-breakpoint
CREATE INDEX escalations_repo_status_created_idx ON escalations (repo, status, created_at);
--> statement-breakpoint
CREATE INDEX escalations_repo_status_noted_created_idx ON escalations (repo, status, noted_at, created_at);
--> statement-breakpoint
INSERT OR IGNORE INTO health (key, value)
SELECT health.key || '#' || ranger_legacy_roots.root, health.value
FROM health JOIN ranger_legacy_roots
ON health.key IN ('digest.' || ranger_legacy_roots.repo,
 'escalate.cursor.' || ranger_legacy_roots.repo,
 'escalate.absentCursor.' || ranger_legacy_roots.repo);
