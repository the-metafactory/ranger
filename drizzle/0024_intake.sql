CREATE TABLE `intake_cursors` (
 `channel_id` text PRIMARY KEY NOT NULL,
 `last_message_id` text NOT NULL,
 `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intake_drafts` (
 `message_id` text PRIMARY KEY NOT NULL,
 `channel_id` text NOT NULL,
 `repo` text NOT NULL,
 `root` integer NOT NULL,
 `author_id` text NOT NULL,
 `title` text NOT NULL,
 `checkpoint` text NOT NULL,
 `body` text NOT NULL,
 `message_url` text NOT NULL,
 `drafter` text NOT NULL,
 `card_message_id` text NOT NULL,
 `status` text DEFAULT 'draft' NOT NULL,
 `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `intake_drafts_repo_root_idx` ON `intake_drafts` (`repo`, `root`);
