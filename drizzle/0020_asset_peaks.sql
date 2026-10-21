CREATE TABLE `asset_peaks` (
	`asset_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`step_ms` smallint unsigned NOT NULL DEFAULT 100,
	`data` mediumblob NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `asset_peaks_asset_id` PRIMARY KEY(`asset_id`)
);
--> statement-breakpoint
ALTER TABLE `asset_peaks` ADD CONSTRAINT `asset_peaks_asset_id_asset_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON DELETE cascade ON UPDATE no action;
