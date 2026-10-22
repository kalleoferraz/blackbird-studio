ALTER TABLE `note` ADD `author_kind` enum('user','system','llm') DEFAULT 'user' NOT NULL;
