-- Profile language tags: the predefined languages a player knows and
-- roleplays in (shared/languageTags.ts catalog keys), shown as flag chips
-- in the profile hero. Comma-separated lowercase key list, same storage
-- convention as story_cw_blocklist ('' = none). Account-level: characters
-- surface their owner's tags.
ALTER TABLE `users` ADD COLUMN `languages` text NOT NULL DEFAULT '';
