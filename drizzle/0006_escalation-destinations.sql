CREATE TABLE `escalation_destinations` (
	`key` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`key`, `channel_id`)
);
