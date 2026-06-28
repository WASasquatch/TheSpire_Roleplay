-- Forum tag "staff only" flag (migration 0273).
--
-- When set, only a mod/owner holding `manage_prefixes` may attach or remove
-- this tag on a topic — the ordinary topic author can't. Lets a keeper mint
-- authoritative tags like "Announcement" or "Official" that members can't
-- self-apply. NULL/0 = a normal tag any author may set on their own topic.
ALTER TABLE `forum_prefixes` ADD COLUMN `staff_only` INTEGER NOT NULL DEFAULT 0;
