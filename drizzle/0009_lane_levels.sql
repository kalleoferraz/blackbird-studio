ALTER TABLE `asset` ADD `loudness_lufs` decimal(5,2);--> statement-breakpoint
ALTER TABLE `asset` ADD `peak_db` decimal(5,2);--> statement-breakpoint
ALTER TABLE `clip` ADD `level_auto` enum('auto','limited');