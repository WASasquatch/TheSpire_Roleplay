-- Consolidate room types: drop the unused "private" (invite-only no password)
-- semantics and rename "password" → "private". After this migration, the only
-- valid values are "public" and "private".
--
-- Old type=private rows had no passwordHash; we promote them to public so
-- they're still reachable rather than silently orphaning them.
UPDATE `rooms` SET `type` = 'public' WHERE `type` = 'private' AND `password_hash` IS NULL;
--> statement-breakpoint
UPDATE `rooms` SET `type` = 'private' WHERE `type` = 'password';
