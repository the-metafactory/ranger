CREATE TABLE `substrate_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`substrate` text NOT NULL,
	`kind` text NOT NULL,
	`repo` text NOT NULL,
	`node_id` text NOT NULL,
	`generation` integer NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`outcome` text
);
--> statement-breakpoint
CREATE INDEX `substrate_sessions_started_at_idx` ON `substrate_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `substrate_sessions_substrate_started_idx` ON `substrate_sessions` (`substrate`,`started_at`);--> statement-breakpoint
CREATE INDEX `substrate_sessions_node_open_idx` ON `substrate_sessions` (`repo`,`node_id`,`ended_at`);--> statement-breakpoint
CREATE INDEX `substrate_sessions_ended_at_idx` ON `substrate_sessions` (`ended_at`);