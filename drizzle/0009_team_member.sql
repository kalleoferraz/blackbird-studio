CREATE TABLE `team_member` (
	`team_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`user_id` char(26) character set ascii collate ascii_bin NOT NULL,
	CONSTRAINT `team_member_team_id_user_id_pk` PRIMARY KEY(`team_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `team_member` ADD CONSTRAINT `team_member_team_id_team_id_fk` FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `team_member` ADD CONSTRAINT `team_member_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `team_member_user_idx` ON `team_member` (`user_id`);