-- Hierarchy fix (2026-10-21): chapter > segment > scene > cue (was chapter > scene > segment > cue).
-- The two tables swap names and keep their rows: the old `scene` becomes `segment` (owns the lanes) and the
-- old `segment` becomes `scene` (the time box that groups cues). Not additive, on purpose: the swap is atomic
-- (RENAME TABLE) and no real data exists yet. Foreign keys whose names change are dropped first and re-added last.
ALTER TABLE `cue` DROP FOREIGN KEY `cue_segment_id_segment_id_fk`;--> statement-breakpoint
ALTER TABLE `lane` DROP FOREIGN KEY `lane_scene_id_scene_id_fk`;--> statement-breakpoint
ALTER TABLE `scene` DROP FOREIGN KEY `scene_chapter_id_chapter_id_fk`;--> statement-breakpoint
ALTER TABLE `segment` DROP FOREIGN KEY `segment_scene_id_scene_id_fk`;--> statement-breakpoint
ALTER TABLE `note` DROP FOREIGN KEY `note_scene_id_scene_id_fk`;--> statement-breakpoint
ALTER TABLE `note` DROP FOREIGN KEY `note_segment_id_segment_id_fk`;--> statement-breakpoint
RENAME TABLE `scene` TO `segment_swap_tmp`, `segment` TO `scene`, `segment_swap_tmp` TO `segment`;--> statement-breakpoint
ALTER TABLE `segment` RENAME INDEX `scene_chapter_position_uq` TO `segment_chapter_position_uq`;--> statement-breakpoint
ALTER TABLE `scene` RENAME COLUMN `scene_id` TO `segment_id`;--> statement-breakpoint
ALTER TABLE `scene` RENAME INDEX `segment_scene_position_uq` TO `scene_segment_position_uq`;--> statement-breakpoint
ALTER TABLE `lane` RENAME COLUMN `scene_id` TO `segment_id`;--> statement-breakpoint
ALTER TABLE `lane` RENAME INDEX `lane_scene_position_uq` TO `lane_segment_position_uq`;--> statement-breakpoint
ALTER TABLE `cue` RENAME COLUMN `segment_id` TO `scene_id`;--> statement-breakpoint
ALTER TABLE `cue` RENAME INDEX `cue_segment_start_idx` TO `cue_scene_start_idx`;--> statement-breakpoint
ALTER TABLE `cue` RENAME INDEX `cue_lane_segment_start_idx` TO `cue_lane_scene_start_idx`;--> statement-breakpoint
ALTER TABLE `note` RENAME COLUMN `scene_id` TO `swap_tmp_id`;--> statement-breakpoint
ALTER TABLE `note` RENAME COLUMN `segment_id` TO `scene_id`;--> statement-breakpoint
ALTER TABLE `note` RENAME COLUMN `swap_tmp_id` TO `segment_id`;--> statement-breakpoint
ALTER TABLE `note` RENAME INDEX `note_scene_idx` TO `note_swap_tmp_idx`;--> statement-breakpoint
ALTER TABLE `note` RENAME INDEX `note_segment_idx` TO `note_scene_idx`;--> statement-breakpoint
ALTER TABLE `note` RENAME INDEX `note_swap_tmp_idx` TO `note_segment_idx`;--> statement-breakpoint
ALTER TABLE `segment` ADD CONSTRAINT `segment_chapter_id_chapter_id_fk` FOREIGN KEY (`chapter_id`) REFERENCES `chapter`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `scene` ADD CONSTRAINT `scene_segment_id_segment_id_fk` FOREIGN KEY (`segment_id`) REFERENCES `segment`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lane` ADD CONSTRAINT `lane_segment_id_segment_id_fk` FOREIGN KEY (`segment_id`) REFERENCES `segment`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cue` ADD CONSTRAINT `cue_scene_id_scene_id_fk` FOREIGN KEY (`scene_id`) REFERENCES `scene`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_segment_id_segment_id_fk` FOREIGN KEY (`segment_id`) REFERENCES `segment`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_scene_id_scene_id_fk` FOREIGN KEY (`scene_id`) REFERENCES `scene`(`id`) ON DELETE cascade ON UPDATE no action;
