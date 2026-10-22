CREATE TABLE `asset` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`project_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`path` varchar(255) character set utf8mb4 collate utf8mb4_unicode_ci NOT NULL,
	`hash` char(64) character set ascii collate ascii_bin NOT NULL,
	`media_kind` enum('audio','image','video','document','other') NOT NULL,
	`size` bigint unsigned NOT NULL,
	`size_lightweight` bigint unsigned,
	`lightweight_path` varchar(255) character set utf8mb4 collate utf8mb4_unicode_ci,
	`media_info` json,
	`status` enum('pending','processing','ready','failed') NOT NULL DEFAULT 'pending',
	`file_state` enum('ok','missing','changed') NOT NULL DEFAULT 'ok',
	`claimed_by` varchar(64),
	`claimed_at` datetime(3),
	`attempts` tinyint unsigned NOT NULL DEFAULT 0,
	`error` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `asset_id` PRIMARY KEY(`id`),
	CONSTRAINT `asset_project_hash_uq` UNIQUE(`project_id`,`hash`),
	CONSTRAINT `asset_project_path_uq` UNIQUE(`project_id`,`path`),
	CONSTRAINT `asset_project_lightweight_path_uq` UNIQUE(`project_id`,`lightweight_path`)
);
--> statement-breakpoint
CREATE TABLE `asset_peaks` (
	`asset_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`step_ms` smallint unsigned NOT NULL DEFAULT 100,
	`data` mediumblob NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `asset_peaks_asset_id` PRIMARY KEY(`asset_id`)
);
--> statement-breakpoint
CREATE TABLE `chapter` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`project_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`position` smallint unsigned NOT NULL,
	`title` varchar(200) NOT NULL,
	`introductory` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `chapter_id` PRIMARY KEY(`id`),
	CONSTRAINT `chapter_project_position_uq` UNIQUE(`project_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `character` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`project_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`name` varchar(100) NOT NULL,
	`is_narrator` boolean NOT NULL DEFAULT false,
	`default_colour` char(7) character set ascii collate ascii_bin NOT NULL,
	`picture_asset_id` char(26) character set ascii collate ascii_bin,
	`description` text,
	`folder` varchar(30) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `character_id` PRIMARY KEY(`id`),
	CONSTRAINT `character_project_folder_uq` UNIQUE(`project_id`,`folder`)
);
--> statement-breakpoint
CREATE TABLE `clip` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`cue_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`asset_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`number` smallint unsigned NOT NULL,
	`offset_ms` int unsigned NOT NULL,
	`length_ms` int unsigned NOT NULL,
	`gain_db` decimal(5,2) NOT NULL DEFAULT '0.00',
	`fade_in_ms` int unsigned NOT NULL DEFAULT 100,
	`fade_out_ms` int unsigned NOT NULL DEFAULT 100,
	`loops` smallint NOT NULL DEFAULT 0,
	`origin` enum('human-recorded','generated','voice-converted') NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `clip_id` PRIMARY KEY(`id`),
	CONSTRAINT `clip_cue_number_uq` UNIQUE(`cue_id`,`number`)
);
--> statement-breakpoint
CREATE TABLE `cue` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`scene_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`lane_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`type` enum('speech','sfx','music') NOT NULL DEFAULT 'speech',
	`character_id` char(26) character set ascii collate ascii_bin,
	`clip_id` char(26) character set ascii collate ascii_bin,
	`start_ms` int unsigned NOT NULL,
	`length_ms` int unsigned NOT NULL,
	`length_auto` boolean NOT NULL DEFAULT true,
	`text_md` text NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `cue_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lane` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`segment_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`character_id` char(26) character set ascii collate ascii_bin,
	`position` smallint unsigned NOT NULL,
	`title` varchar(100) NOT NULL,
	`colour` char(7) character set ascii collate ascii_bin NOT NULL,
	`auto` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `lane_id` PRIMARY KEY(`id`),
	CONSTRAINT `lane_segment_position_uq` UNIQUE(`segment_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `membership` (
	`user_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`project_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`role` enum('author','narrator','translator','reader') NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `membership_user_id_project_id_pk` PRIMARY KEY(`user_id`,`project_id`)
);
--> statement-breakpoint
CREATE TABLE `note` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`project_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`author_user_id` char(26) character set ascii collate ascii_bin,
	`author_kind` enum('user','system','llm') NOT NULL DEFAULT 'user',
	`type` enum('comment','reference','task') NOT NULL,
	`text_md` text NOT NULL,
	`ref_key` varchar(24) character set utf8mb4 collate utf8mb4_unicode_ci,
	`link` varchar(2048),
	`done_at` datetime(3),
	`done_by_user_id` char(26) character set ascii collate ascii_bin,
	`chapter_id` char(26) character set ascii collate ascii_bin,
	`segment_id` char(26) character set ascii collate ascii_bin,
	`scene_id` char(26) character set ascii collate ascii_bin,
	`cue_id` char(26) character set ascii collate ascii_bin,
	`asset_id` char(26) character set ascii collate ascii_bin,
	`root_note_id` char(26) character set ascii collate ascii_bin,
	`reply_to_note_id` char(26) character set ascii collate ascii_bin,
	`created_at` datetime(3) NOT NULL,
	`edited_at` datetime(3),
	`deleted_at` datetime(3),
	CONSTRAINT `note_id` PRIMARY KEY(`id`),
	CONSTRAINT `note_project_ref_key_uq` UNIQUE(`project_id`,`ref_key`)
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`type` enum('audiobook','textbook','film','series','podcast') NOT NULL DEFAULT 'audiobook',
	`title` varchar(200) NOT NULL,
	`subtitle` varchar(200),
	`language` varchar(10) NOT NULL,
	`speech_units` double NOT NULL DEFAULT 0,
	`speech_ms` bigint unsigned NOT NULL DEFAULT 0,
	`cover_asset_id` char(26) character set ascii collate ascii_bin,
	`revision` bigint unsigned NOT NULL DEFAULT 0,
	`dirty_since` datetime(3),
	`last_edited_at` datetime(3),
	`active_session` char(26) character set ascii collate ascii_bin,
	`repo_folder` varchar(80) character set utf8mb4 collate utf8mb4_unicode_ci,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `project_id` PRIMARY KEY(`id`),
	CONSTRAINT `project_repo_folder_uq` UNIQUE(`repo_folder`)
);
--> statement-breakpoint
CREATE TABLE `scene` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`segment_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`position` smallint unsigned NOT NULL,
	`label` varchar(100),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `scene_id` PRIMARY KEY(`id`),
	CONSTRAINT `scene_segment_position_uq` UNIQUE(`segment_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `segment` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`chapter_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`position` smallint unsigned NOT NULL,
	`title` varchar(200) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `segment_id` PRIMARY KEY(`id`),
	CONSTRAINT `segment_chapter_position_uq` UNIQUE(`chapter_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `snapshot` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`project_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`commit_sha` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`revision` bigint unsigned NOT NULL,
	`label` varchar(200),
	`created_by_user_id` char(26) character set ascii collate ascii_bin,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `snapshot_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `team` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`name` varchar(100) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `team_id` PRIMARY KEY(`id`),
	CONSTRAINT `team_name_uq` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `team_member` (
	`team_id` char(26) character set ascii collate ascii_bin NOT NULL,
	`user_id` char(26) character set ascii collate ascii_bin NOT NULL,
	CONSTRAINT `team_member_team_id_user_id_pk` PRIMARY KEY(`team_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` char(26) character set ascii collate ascii_bin NOT NULL,
	`email` varchar(254) character set utf8mb4 collate utf8mb4_unicode_ci NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`display_name` varchar(100) NOT NULL,
	`disabled_at` datetime(3),
	`must_change_password` boolean NOT NULL DEFAULT false,
	`last_login_at` datetime(3),
	`last_edit_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_email_uq` UNIQUE(`email`)
);
--> statement-breakpoint
ALTER TABLE `asset` ADD CONSTRAINT `asset_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_peaks` ADD CONSTRAINT `asset_peaks_asset_id_asset_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chapter` ADD CONSTRAINT `chapter_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `character` ADD CONSTRAINT `character_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `character` ADD CONSTRAINT `character_picture_asset_id_asset_id_fk` FOREIGN KEY (`picture_asset_id`) REFERENCES `asset`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clip` ADD CONSTRAINT `clip_cue_id_cue_id_fk` FOREIGN KEY (`cue_id`) REFERENCES `cue`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clip` ADD CONSTRAINT `clip_asset_id_asset_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cue` ADD CONSTRAINT `cue_scene_id_scene_id_fk` FOREIGN KEY (`scene_id`) REFERENCES `scene`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cue` ADD CONSTRAINT `cue_lane_id_lane_id_fk` FOREIGN KEY (`lane_id`) REFERENCES `lane`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cue` ADD CONSTRAINT `cue_character_id_character_id_fk` FOREIGN KEY (`character_id`) REFERENCES `character`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cue` ADD CONSTRAINT `cue_clip_id_clip_id_fk` FOREIGN KEY (`clip_id`) REFERENCES `clip`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lane` ADD CONSTRAINT `lane_segment_id_segment_id_fk` FOREIGN KEY (`segment_id`) REFERENCES `segment`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lane` ADD CONSTRAINT `lane_character_id_character_id_fk` FOREIGN KEY (`character_id`) REFERENCES `character`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `membership` ADD CONSTRAINT `membership_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `membership` ADD CONSTRAINT `membership_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_author_user_id_user_id_fk` FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_done_by_user_id_user_id_fk` FOREIGN KEY (`done_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_chapter_id_chapter_id_fk` FOREIGN KEY (`chapter_id`) REFERENCES `chapter`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_segment_id_segment_id_fk` FOREIGN KEY (`segment_id`) REFERENCES `segment`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_scene_id_scene_id_fk` FOREIGN KEY (`scene_id`) REFERENCES `scene`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_cue_id_cue_id_fk` FOREIGN KEY (`cue_id`) REFERENCES `cue`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_asset_id_asset_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_root_note_id_note_id_fk` FOREIGN KEY (`root_note_id`) REFERENCES `note`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `note` ADD CONSTRAINT `note_reply_to_note_id_note_id_fk` FOREIGN KEY (`reply_to_note_id`) REFERENCES `note`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project` ADD CONSTRAINT `project_cover_asset_id_asset_id_fk` FOREIGN KEY (`cover_asset_id`) REFERENCES `asset`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `scene` ADD CONSTRAINT `scene_segment_id_segment_id_fk` FOREIGN KEY (`segment_id`) REFERENCES `segment`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `segment` ADD CONSTRAINT `segment_chapter_id_chapter_id_fk` FOREIGN KEY (`chapter_id`) REFERENCES `chapter`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `snapshot` ADD CONSTRAINT `snapshot_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `snapshot` ADD CONSTRAINT `snapshot_created_by_user_id_user_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `team_member` ADD CONSTRAINT `team_member_team_id_team_id_fk` FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `team_member` ADD CONSTRAINT `team_member_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `asset_status_claimed_idx` ON `asset` (`status`,`claimed_at`);--> statement-breakpoint
CREATE INDEX `clip_asset_idx` ON `clip` (`asset_id`);--> statement-breakpoint
CREATE INDEX `cue_scene_start_idx` ON `cue` (`scene_id`,`start_ms`);--> statement-breakpoint
CREATE INDEX `cue_lane_scene_start_idx` ON `cue` (`lane_id`,`scene_id`,`start_ms`);--> statement-breakpoint
CREATE INDEX `cue_clip_idx` ON `cue` (`clip_id`);--> statement-breakpoint
CREATE INDEX `membership_project_idx` ON `membership` (`project_id`);--> statement-breakpoint
CREATE INDEX `note_project_type_idx` ON `note` (`project_id`,`type`);--> statement-breakpoint
CREATE INDEX `note_chapter_idx` ON `note` (`chapter_id`);--> statement-breakpoint
CREATE INDEX `note_segment_idx` ON `note` (`segment_id`);--> statement-breakpoint
CREATE INDEX `note_scene_idx` ON `note` (`scene_id`);--> statement-breakpoint
CREATE INDEX `note_cue_idx` ON `note` (`cue_id`);--> statement-breakpoint
CREATE INDEX `note_asset_idx` ON `note` (`asset_id`);--> statement-breakpoint
CREATE INDEX `note_root_created_idx` ON `note` (`root_note_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `note_reply_to_idx` ON `note` (`reply_to_note_id`);--> statement-breakpoint
CREATE INDEX `snapshot_project_created_idx` ON `snapshot` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `team_member_user_idx` ON `team_member` (`user_id`);