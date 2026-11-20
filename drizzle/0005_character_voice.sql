ALTER TABLE `character` ADD `voice_id` varchar(64) character set ascii collate ascii_bin;--> statement-breakpoint
ALTER TABLE `character` ADD `voice_name` varchar(100);--> statement-breakpoint
ALTER TABLE `character` ADD `voice_source` enum('account','public','clone');--> statement-breakpoint
ALTER TABLE `character` ADD `voice_direction` text;--> statement-breakpoint
ALTER TABLE `character` ADD `voice_settings` json;