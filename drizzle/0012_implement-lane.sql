ALTER TABLE `workers` ADD `lane` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workers` ADD `worker_pgid` integer;--> statement-breakpoint
ALTER TABLE `workers` ADD `phase` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `pr_number` integer;--> statement-breakpoint
ALTER TABLE `workers` ADD `review_round` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workers` ADD `verdict_sha` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `verdict_blockers` integer;--> statement-breakpoint
ALTER TABLE `workers` ADD `merge_message_id` text;