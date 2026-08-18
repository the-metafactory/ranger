CREATE INDEX `escalations_repo_node_idx` ON `escalations` (`repo`,`node_id`);--> statement-breakpoint
CREATE INDEX `escalations_repo_status_noted_idx` ON `escalations` (`repo`,`status`,`noted_at`);