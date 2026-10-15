ALTER TABLE `user` ADD `disabled_at` datetime(3);--> statement-breakpoint
ALTER TABLE `user` ADD `must_change_password` boolean DEFAULT false NOT NULL;