CREATE TABLE `app_setting` (
	`key` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`value` text NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `app_setting_key` PRIMARY KEY(`key`)
);
