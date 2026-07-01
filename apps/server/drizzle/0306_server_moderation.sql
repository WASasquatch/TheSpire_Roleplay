-- 0306: Server-level moderation (suspend / ban / delete) for global admins.
--
-- A global admin (manage_any_server) may SUSPEND a server (indefinite "under
-- review" hold with an optional note) or BAN it (auto-expires once
-- moderation_until passes; NULL until = indefinite). Both hide the server from
-- discovery/catalog for normal users and block their access at the single
-- chokepoint (serverAuthority.canParticipate) with a notice — only the server
-- owner, the owner's admins/mods, and global staff may enter to rectify/review.
-- A ban past moderation_until is treated as 'none' EVERYWHERE (lazy expiry,
-- mirroring server_bans/banned_ips — the row is never auto-deleted). DELETE is a
-- separate hard cascade, not a state here. The isSystem/home server can NEVER be
-- moderated (409-guarded on the admin endpoints).
--
-- Additive only: five new columns on `servers`, all with safe defaults/NULL, so
-- every existing (non-moderated) server keeps byte-identical behavior.

ALTER TABLE servers ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE servers ADD COLUMN moderation_until INTEGER;
--> statement-breakpoint
ALTER TABLE servers ADD COLUMN moderation_note TEXT;
--> statement-breakpoint
ALTER TABLE servers ADD COLUMN moderation_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE servers ADD COLUMN moderation_at INTEGER;
