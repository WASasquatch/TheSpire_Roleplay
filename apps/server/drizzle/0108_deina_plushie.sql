-- New builtin: Deina Plushie. Same shape as kaal_dragon_plushie
-- (gift category, $1500, stack 3), both are character-named
-- collectible plushies, so pairing the pricing/limits keeps them
-- as peer trophies in the gift bucket.
--
-- Two parts:
--   1. INSERT the new row with deina-specific aliases.
--   2. UPDATE kaal_dragon_plushie to drop the generic "plushie"
--      alias. Pre-0108 it owned that alias; now that there are
--      two plushies in the catalog, leaving "plushie" on kaal
--      would make `/give kaal plushie` resolve non-deterministically
--      (findItem's json_each + LIMIT 1 picks whichever row the
--      planner returns first). Specific names ("deina", "kaal",
--      "dragon plush") still resolve cleanly.

INSERT INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'deina_plushie',
  'Deina Plushie',
  'Deina plushies',
  'A cute plushie Deina. Who wouldn''t want one?',
  '/assets/items/deina_plushie.png',
  1500,
  3,
  '["{sender} hands {target} {num} {item_name}. Limited edition!","{sender} offers {target} {num} {item_name}. *snuggles*"]',
  '["{sender} hurls {num} {item_name} at {target}! *muffled cry*","{sender} flings {num} {item_name} at {target}."]',
  '["{sender} drops {num} {item_name} on {target}. Heroically squishy."]',
  '["deina","deina plush"]',
  'gift', 1, 357
);
--> statement-breakpoint

UPDATE `items`
   SET `aliases_json` = '["dragon plush","kaal plush","kaal"]'
 WHERE `key` = 'kaal_dragon_plushie';
