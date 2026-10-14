-- Scheduled job runs (node #301). At most one queued run per job name.
CREATE TABLE job_runs (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, name text NOT NULL,
lane text NOT NULL, status text DEFAULT 'queued' NOT NULL, queued_at text NOT NULL,
started_at text, finished_at text, pid integer, pgid integer, substrate text,
reason text, result text, log text);
--> statement-breakpoint
CREATE UNIQUE INDEX job_runs_one_queued_idx ON job_runs (name) WHERE status = 'queued';
--> statement-breakpoint
CREATE INDEX job_runs_status_idx ON job_runs (status, id);
