-- Safe to re-run: an earlier draft of this migration (with a `loop` column) may have created the table in a local database. The table holds nothing yet.
DROP TABLE IF EXISTS `cue_sfx`;--> statement-breakpoint
CREATE TABLE `cue_sfx` (
	`cue_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`prompt` text NOT NULL,
	`duration_ms` int,
	`looped` boolean NOT NULL DEFAULT false,
	`prompt_influence` decimal(3,2) NOT NULL DEFAULT '0.30',
	`model` varchar(64) character set ascii collate ascii_bin NOT NULL DEFAULT 'eleven_text_to_sound_v3',
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `cue_sfx_cue_id` PRIMARY KEY(`cue_id`)
);
--> statement-breakpoint
ALTER TABLE `cue_sfx` ADD CONSTRAINT `cue_sfx_cue_id_cue_id_fk` FOREIGN KEY (`cue_id`) REFERENCES `cue`(`id`) ON DELETE cascade ON UPDATE no action;