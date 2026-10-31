ALTER TABLE job_runs ADD COLUMN params text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE job_runs ADD COLUMN queue_key text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE job_runs ADD COLUMN policy text;
--> statement-breakpoint
DROP INDEX job_runs_one_queued_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX job_runs_one_queued_idx ON job_runs (name, queue_key) WHERE status = 'queued';
