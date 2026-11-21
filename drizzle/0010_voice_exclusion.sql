-- Safe to re-run: an earlier draft of this migration may have created the table in a local database before failing. The table holds nothing yet.
DROP TABLE IF EXISTS `voice_exclusion`;--> statement-breakpoint
CREATE TABLE `voice_exclusion` (
	`project_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`voice_id` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`source` enum('account','public') NOT NULL,
	`name` varchar(100) NOT NULL,
	`info` varchar(300),
	`public_owner_id` varchar(100) character set ascii collate ascii_bin,
	`preview_url` varchar(2048),
	`created_by_user_id` char(26) character set ascii collate ascii_bin,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `voice_exclusion_project_id_voice_id_pk` PRIMARY KEY(`project_id`,`voice_id`)
);
--> statement-breakpoint
ALTER TABLE `voice_exclusion` ADD CONSTRAINT `voice_exclusion_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voice_exclusion` ADD CONSTRAINT `voice_exclusion_created_by_user_id_user_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;