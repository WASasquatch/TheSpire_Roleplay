-- Per-character "Direct Messenger" opt-in.
--
-- Adds `direct_messenger_enabled` to `characters` and backfills it
-- so existing characters who are already active in the DM system stay
-- reachable. Brand-new characters created after this migration are
-- opt-in (default = 0); existing characters with prior friendships or
-- conversations are migrated to 1 so a player doesn't suddenly find
-- their established characters unreachable on the next deploy.
--
-- Backfill criteria, a character is migrated to enabled = 1 if ANY
-- of the following hold:
--   * they hold (or were the target of) at least one friendship row
--     of either status, "accepted" obviously, but ALSO "pending"
--     because a pending inbox-request implies the character was
--     reachable when the request was sent and the player likely
--     expects to be able to accept it.
--   * they hold either side of a direct conversation row.
--   * they sent at least one direct message under the character's
--     identity.
--
-- The route layer (friend-request POST + DM send POST) gates further
-- writes against the same flag, see apps/server/src/routes/friends.ts
-- and apps/server/src/routes/directMessages.ts for the runtime checks.
-- Disabling the flag does NOT delete existing friendships or
-- conversations; it only blocks NEW reach attempts.

ALTER TABLE `characters` ADD COLUMN `direct_messenger_enabled` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

UPDATE `characters` SET `direct_messenger_enabled` = 1 WHERE `id` IN (
  SELECT `friender_character_id` FROM `friends` WHERE `friender_character_id` IS NOT NULL
  UNION
  SELECT `friended_character_id` FROM `friends` WHERE `friended_character_id` IS NOT NULL
  UNION
  SELECT `user_a_character_id` FROM `direct_conversations` WHERE `user_a_character_id` IS NOT NULL
  UNION
  SELECT `user_b_character_id` FROM `direct_conversations` WHERE `user_b_character_id` IS NOT NULL
  UNION
  SELECT `sender_character_id` FROM `direct_messages` WHERE `sender_character_id` IS NOT NULL
);
