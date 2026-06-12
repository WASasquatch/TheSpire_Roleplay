-- Forum board categories: ONE level of nesting. A category may sit under
-- a top-level parent (parent_id), giving keepers section / sub-section
-- organization. Deleting a parent promotes its children to top level
-- (SET NULL) - topics are never touched by re-parenting.
ALTER TABLE `room_thread_categories` ADD COLUMN `parent_id` TEXT
  REFERENCES `room_thread_categories`(`id`) ON DELETE SET NULL;
