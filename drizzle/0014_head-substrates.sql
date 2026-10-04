CREATE TABLE `head_substrates` (
	`sha` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`node_id` text NOT NULL,
	`substrate` text NOT NULL,
	`recorded_at` text NOT NULL
);
