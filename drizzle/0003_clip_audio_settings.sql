ALTER TABLE `clip` ADD `speed` decimal(4,2) DEFAULT '1.00' NOT NULL;
--> statement-breakpoint
ALTER TABLE `clip` ADD `pitch_cents` smallint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `clip` ADD `volume_points` json;
