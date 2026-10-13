ALTER TABLE `intake_drafts` ADD `spec_hash` text;
--> statement-breakpoint
ALTER TABLE `intake_drafts` ADD `filed_node` text;
--> statement-breakpoint
ALTER TABLE `intake_drafts` ADD `gate_read_at` text;
--> statement-breakpoint
CREATE INDEX `intake_drafts_channel_status_idx` ON `intake_drafts` (`channel_id`, `status`);
--> statement-breakpoint
ALTER TABLE `intake_drafts` ADD `parent` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `intake_drafts` ADD `autonomy` text DEFAULT 'propose' NOT NULL;
--> statement-breakpoint
UPDATE `intake_drafts` SET `parent` = `root`;
