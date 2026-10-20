CREATE INDEX `intake_drafts_card_idx` ON `intake_drafts` (`card_message_id`);
--> statement-breakpoint
CREATE INDEX `intake_drafts_supersedes_idx` ON `intake_drafts` (`supersedes`);
