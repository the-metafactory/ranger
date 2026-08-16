CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`node_id` text,
	`repo` text,
	`kind` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `health` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vetoes` (
	`node_id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`at` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`node_id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`pid` integer,
	`status` text DEFAULT 'claimed' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`worktree` text,
	`started_at` text,
	`finished_at` text,
	`outcome` text,
	`message_id` text
);
