CREATE TABLE `head_substrates` (
	`sha` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`node_id` text NOT NULL,
	`substrate` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `substrate_readings` (
	`substrate` text PRIMARY KEY NOT NULL,
	`read_at` text NOT NULL,
	`five_hour_used_pct` integer,
	`seven_day_used_pct` integer,
	`resets_at` text,
	`capped` integer DEFAULT false NOT NULL,
	`capped_until` text
);
--> statement-breakpoint
ALTER TABLE `workers` ADD `substrate` text;