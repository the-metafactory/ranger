CREATE TABLE `resume_queue` (
 `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
 `repo` text NOT NULL,
 `node_id` text NOT NULL,
 `root` integer NOT NULL,
 `lane` text NOT NULL,
 `queued_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resume_queue_repo_node_idx` ON `resume_queue` (`repo`, `node_id`);
--> statement-breakpoint
CREATE INDEX `resume_queue_lane_id_idx` ON `resume_queue` (`lane`, `id`);
