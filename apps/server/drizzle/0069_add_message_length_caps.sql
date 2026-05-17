-- Per-surface message length caps.
--
-- Previously, DM body length was a hardcoded constant in
-- routes/directMessages.ts (`MAX_BODY = 4000`) and forum bodies + topic
-- titles were either capped in dispatch.ts (`.slice(0, 120)` on the
-- title) or piggybacking on `max_message_length` (chat). This
-- migration breaks them out as independent admin-configurable
-- settings so DMs can have a longer write surface for long-form
-- conversations and forum posts can carry worldbuilding-sized bodies
-- without bumping chat's limit.
--
-- Defaults preserve existing behavior:
--   max_direct_message_length      → 4000 (matches the deleted constant)
--   max_forum_post_length          → 8000 (2x chat; reasonable forum ceiling)
--   max_forum_topic_title_length   → 120  (matches dispatch.ts's slice)
ALTER TABLE `site_settings`
  ADD COLUMN `max_direct_message_length` INTEGER NOT NULL DEFAULT 4000;
--> statement-breakpoint
ALTER TABLE `site_settings`
  ADD COLUMN `max_forum_post_length` INTEGER NOT NULL DEFAULT 8000;
--> statement-breakpoint
ALTER TABLE `site_settings`
  ADD COLUMN `max_forum_topic_title_length` INTEGER NOT NULL DEFAULT 120;
