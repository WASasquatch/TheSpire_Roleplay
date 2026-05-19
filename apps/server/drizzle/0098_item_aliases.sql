-- Add casual-name aliases to the items catalog so users don't have to
-- guess the canonical key/name when running /give /throw /drop. The
-- server's findItem clause already accepts the slug AND the singular/
-- plural display name; with this column it also accepts any string in
-- `aliases_json` as an additional match. JSON-array shape matches the
-- per-command message tables so the admin UI can edit it the same way.
--
-- Seed defaults for the built-in catalog so common natural-language
-- typings work out of the box ("drink" for ale, "coin" for gold_coin,
-- "knife" for dagger, etc.). Admins can edit these freely.

ALTER TABLE `items` ADD COLUMN `aliases_json` TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint

UPDATE `items` SET `aliases_json` = '["biscuit"]'                            WHERE `key` = 'cookie';
--> statement-breakpoint
UPDATE `items` SET `aliases_json` = '["flower"]'                             WHERE `key` = 'rose';
--> statement-breakpoint
UPDATE `items` SET `aliases_json` = '["cake","tart"]'                        WHERE `key` = 'pie';
--> statement-breakpoint
UPDATE `items` SET `aliases_json` = '["cushion"]'                            WHERE `key` = 'pillow';
--> statement-breakpoint
UPDATE `items` SET `aliases_json` = '["stone","pebble"]'                     WHERE `key` = 'rock';
--> statement-breakpoint
UPDATE `items` SET `aliases_json` = '["beer","drink","tankard","mead"]'      WHERE `key` = 'ale';
--> statement-breakpoint
UPDATE `items` SET `aliases_json` = '["knife","blade"]'                      WHERE `key` = 'dagger';
--> statement-breakpoint
UPDATE `items` SET `aliases_json` = '["coin","coins","gp","gold","piece"]'   WHERE `key` = 'gold_coin';
--> statement-breakpoint
UPDATE `items` SET `aliases_json` = '["parchment","letter","note"]'          WHERE `key` = 'scroll';
--> statement-breakpoint
UPDATE `items` SET `aliases_json` = '["tiara","circlet"]'                    WHERE `key` = 'crown';
