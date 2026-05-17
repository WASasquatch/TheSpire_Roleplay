-- Per-user display + privacy toggles. Five new booleans:
--
--   show_rank_in_userlist   — when 0, the user's userlist row falls
--                             back to the gender glyph instead of the
--                             rank gem. Default 1 (rank shown), so
--                             current users see no behavior change.
--   show_rank_in_chat       — when 0, chat-line messages from this
--                             user are persisted with null rank fields
--                             so the inline gem doesn't render. Past
--                             messages keep whatever rank was
--                             snapshotted at send time — flipping this
--                             affects FUTURE sends only.
--
--   hide_chat_message_count — when 1, the user's profile metrics
--                             return null for that counter instead of
--                             the real number; the ProfileModal
--                             renders "private". Currency / XP already
--                             have equivalent flags on user_earning.
--   hide_forum_topic_count  — same idea for forum topics opened.
--   hide_forum_reply_count  — same idea for forum replies posted.
--
-- All five live on `users` (not `user_earning`) because they govern
-- display surfaces that aren't strictly part of the earning ledger —
-- rank-icon visibility and message-count privacy compose with the
-- earning rank/xp privacy already on user_earning. Keeping them on
-- `users` also means the /me/profile PUT can write them without
-- needing a second endpoint round-trip.
ALTER TABLE users ADD COLUMN show_rank_in_userlist INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN show_rank_in_chat INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN hide_chat_message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN hide_forum_topic_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN hide_forum_reply_count INTEGER NOT NULL DEFAULT 0;
