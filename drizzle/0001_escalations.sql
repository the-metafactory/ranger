CREATE TABLE `escalations` (
	`key` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`node_id` text NOT NULL,
	`title` text,
	`message_id` text NOT NULL,
	`created_at` text NOT NULL,
	`last_edited_at` text,
	`status` text DEFAULT 'open' NOT NULL
);
