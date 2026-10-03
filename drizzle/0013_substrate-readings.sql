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