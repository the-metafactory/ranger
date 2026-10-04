PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_head_substrates` (
	`repo` text NOT NULL,
	`sha` text NOT NULL,
	`node_id` text NOT NULL,
	`substrate` text NOT NULL,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`repo`, `sha`)
);
--> statement-breakpoint
INSERT INTO `__new_head_substrates`("repo", "sha", "node_id", "substrate", "recorded_at") SELECT "repo", "sha", "node_id", "substrate", "recorded_at" FROM `head_substrates`;--> statement-breakpoint
DROP TABLE `head_substrates`;--> statement-breakpoint
ALTER TABLE `__new_head_substrates` RENAME TO `head_substrates`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `head_substrates_recorded_at_idx` ON `head_substrates` (`recorded_at`);