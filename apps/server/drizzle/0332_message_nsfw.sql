-- 0332: Per-message 18+ stamp (age-restriction plan, Phases 2 + 3).
--
-- Double duty, one column:
--   * CHAT rows are stamped at insert from the room's EFFECTIVE 18+ state
--     (server OR room) — snapshot-at-send, same posture as rank_key/color —
--     so history written while a room was 18+ stays hidden from minors even
--     after the room flips back to all-ages.
--   * FORUM TOPIC rows use the same column as the mutable NSFW tag (topics
--     ARE messages); replies inherit the topic's value at insert and a
--     re-tag retro-updates the children.
-- Default 0: every existing row is all-ages, matching today's reality
-- (the site has been de facto 18+ since launch, but unlabeled content in
-- all-ages spaces stays a moderation matter by design).

ALTER TABLE messages ADD COLUMN is_nsfw INTEGER NOT NULL DEFAULT 0;
