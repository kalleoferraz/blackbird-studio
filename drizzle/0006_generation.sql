CREATE TABLE `generation` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`project_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`clip_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`kind` enum('speech','sfx','music','voice_change') NOT NULL,
	`model` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`voice_id` varchar(64) character set ascii collate ascii_bin,
	`text_sent` text,
	`direction` text,
	`settings` json,
	`source_clip_id` char(26) character set ascii collate ascii_bin,
	`output_format` varchar(40) character set ascii collate ascii_bin NOT NULL,
	`context` boolean NOT NULL DEFAULT false,
	`request_id` varchar(64) character set ascii collate ascii_bin,
	`character_cost` int,
	`created_by_user_id` char(26) character set ascii collate ascii_bin,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `generation_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `generation` ADD CONSTRAINT `generation_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `generation` ADD CONSTRAINT `generation_clip_id_clip_id_fk` FOREIGN KEY (`clip_id`) REFERENCES `clip`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `generation` ADD CONSTRAINT `generation_source_clip_id_clip_id_fk` FOREIGN KEY (`source_clip_id`) REFERENCES `clip`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `generation` ADD CONSTRAINT `generation_created_by_user_id_user_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `generation_project_idx` ON `generation` (`project_id`);--> statement-breakpoint
CREATE INDEX `generation_clip_idx` ON `generation` (`clip_id`);