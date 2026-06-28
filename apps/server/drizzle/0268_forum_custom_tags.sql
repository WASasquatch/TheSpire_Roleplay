-- Forum tag governance (migration 0268).
--
-- Two owner controls layered on the topic-prefix system (migration 0266):
--
-- 1. `forums.allow_custom_tags` — master switch. OFF (default): tags are the
--    owner-curated catalog only, offered per category. ON: a mod holding the
--    new `create_tags` granular permission may also mint a tag on the fly when
--    tagging a topic. Either way the catalog is reusable.
--
-- 2. `forum_prefixes.category_ids_json` — a JSON array of room_thread_category
--    ids the tag is offered in. Empty array (the default) = global (offered on
--    every topic). Non-empty = only offered on topics filed under those
--    categories. Lets the keeper present "appropriate tags" per category.
ALTER TABLE `forums` ADD COLUMN `allow_custom_tags` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `forum_prefixes` ADD COLUMN `category_ids_json` TEXT NOT NULL DEFAULT '[]';
