-- 0331: Owner-set 18+ flag on rooms (age-restriction plan, Phase 2).
--
-- Mirrors 0302's `persistent` posture: plain additive flag, default 0 so
-- every existing room stays all-ages on deploy. When 1, minors (and
-- anonymous readers where applicable) cannot list, join, read, export, or
-- be notified from the room — HARD `isAdult` tier, enforced server-side.
-- The EFFECTIVE room rating is `servers.is_nsfw OR rooms.is_nsfw` once the
-- server-level flag (0335) is live. Toggled by `/nsfw` (callerCanEditRoom),
-- the servers console (manage_rooms), and the admin rooms routes.

ALTER TABLE rooms ADD COLUMN is_nsfw INTEGER NOT NULL DEFAULT 0;
