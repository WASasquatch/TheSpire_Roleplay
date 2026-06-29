-- Servers Lift, Phase 1 (additive): one-time roster backfill (§9.7). Write an
-- explicit `server_members` row (role 'member') per existing user account for
-- the default server, so the default server's owner has an ENUMERABLE roster
-- (manage / ban / list members) the same as any other server.
--
-- ACCESS is unchanged: serverAuthority's implicit `is_system` rule
-- (server.isSystem === true ⇒ every signed-in user is a member) remains the
-- source of truth for what a user MAY do. These rows are a management-enumeration
-- convenience ONLY (the §6.4 hybrid). POST /auth/register writes the same
-- INSERT-OR-IGNORE row for each NEW account going forward.
--
-- EXCLUSIONS:
--   * the 'system' sentinel (login-less; never a real participant) — by both
--     username and id, mirroring §9.4.
--   * the owner — already has the 'owner' row from 0279; INSERT OR IGNORE would
--     skip a duplicate (server_members PK is (server_id, user_id)) but we also
--     filter explicitly so we never even attempt to demote them to 'member'.
--
-- IDEMPOTENT: INSERT OR IGNORE against the (server_id, user_id) primary key, and
-- the whole thing is guarded on the server existing — a fresh install (no server
-- row yet) inserts nothing and the boot backfill covers it once provisioned.
INSERT OR IGNORE INTO `server_members` (
  `server_id`, `user_id`, `role`, `permissions_json`, `joined_at`)
SELECT 'server_spire_system', u.`id`, 'member', '[]', (unixepoch() * 1000)
FROM `users` u
WHERE u.`username` != 'system'
  AND u.`id` != 'system'
  AND u.`id` != (SELECT `owner_user_id` FROM `servers` WHERE `id` = 'server_spire_system')
  AND EXISTS (SELECT 1 FROM `servers` WHERE `id` = 'server_spire_system');
