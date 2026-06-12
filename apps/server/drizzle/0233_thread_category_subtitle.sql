-- Forum board categories: optional subtitle line shown under the
-- category name in the section header ("what belongs in here").
ALTER TABLE `room_thread_categories` ADD COLUMN `subtitle` TEXT;
