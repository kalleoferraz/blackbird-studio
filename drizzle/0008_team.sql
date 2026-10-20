CREATE TABLE `team` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`name` varchar(100) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `team_id` PRIMARY KEY(`id`),
	CONSTRAINT `team_name_uq` UNIQUE(`name`)
);
