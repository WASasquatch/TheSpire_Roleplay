-- "Buy a Copy": purchased copies of published stories. The buyer spends
-- currency (a royalty cut goes to the author), and may showcase owned copies on
-- their profile (showcase_slot non-null = pinned). One copy per identity per
-- story (unique index). Owner_user_id cascades so a deleted account's copies go
-- with it; story_id cascades so a deleted story's copies do too.
CREATE TABLE IF NOT EXISTS story_copies (
  id TEXT PRIMARY KEY NOT NULL,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  owner_scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  price_paid INTEGER NOT NULL DEFAULT 0,
  showcase_slot INTEGER,
  purchased_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS story_copies_owner_story_uq ON story_copies (owner_scope, owner_id, story_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS story_copies_showcase_idx ON story_copies (owner_scope, owner_id, showcase_slot);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS story_copies_story_idx ON story_copies (story_id);
