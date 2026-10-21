ALTER TABLE `clip` MODIFY COLUMN `fade_in_ms` int unsigned NOT NULL DEFAULT 100;
--> statement-breakpoint
ALTER TABLE `clip` MODIFY COLUMN `fade_out_ms` int unsigned NOT NULL DEFAULT 100;
