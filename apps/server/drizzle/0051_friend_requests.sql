-- Symmetric friendship. The `friends` table (formerly `watches`) was
-- asymmetric, you could silently add anyone and they were never
-- notified. The new flow:
--
--   /friend alice            → row (me, alice, status='pending')
--   alice runs /accept me    → row flips to status='accepted'
--   alice runs /decline me   → row is deleted
--   /unfriend alice          → row is deleted (regardless of side)
--
-- The friends *list* is now the symmetric set: a user appears on my
-- list when there's an accepted row in either direction between us.
-- The `friend_requests` inbox is rows where I'm the friended party
-- and status is pending.
--
-- Existing rows predate the new flow (they were one-sided watches).
-- Default `'accepted'` grandfathers them into the new model as
-- mutual friendships, minor semantics shift but a one-time
-- migration cost; nobody loses access.
ALTER TABLE friends ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted';
CREATE INDEX friends_status_idx ON friends (friended_user_id, status);
