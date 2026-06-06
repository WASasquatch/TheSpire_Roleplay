-- Three more builtin items from the latest asset drop:
--   scylla_pet  , mythical sea-creature pet, slots into the pet
--                  tier between mimic_chest_pet ($5k) and the
--                  dragons ($18k+). $14k feels right.
--   tardis_pet  , a TARDIS as a pet (joke / homage). The filename
--                  carries the `_pet` suffix so it lives in the
--                  pet bucket; price reflects the meme tier, same
--                  ballpark as a dragon, since acquiring a TARDIS
--                  as a "pet" is an absurd flex.
--   gameboy     , a retro handheld. Goes in the `tool` category
--                  alongside playing_cards / playing_dice, quirky
--                  toy-ish utility item, throwable for laughs.
--
-- TARDIS's icon file is `TARDIS_pet.png` (capitalized acronym); the
-- slug stays snake_case (`tardis_pet`) so the regex stays happy, and
-- the icon_url points at the actual on-disk casing. Same pattern as
-- the Akhal-Teke_horse handling in 0104.

INSERT INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'scylla_pet',
  'Scylla',
  'scylla',
  'A many-headed sea creature, somehow miniaturized into pet form. Surprisingly cuddly between the heads.',
  '/assets/items/scylla_pet.png',
  14000,
  1,
  '["{sender} hands {target} {num} {item_name}. \"Take care of them.\"","{sender} gifts {target} {num} {item_name}.","{sender} entrusts {target} with {num} {item_name}. They look up at {target} expectantly."]',
  '[]',
  '[]',
  '["scylla","sea monster","monster"]',
  'pet', 1, 744
),
(
  'tardis_pet',
  'TARDIS',
  'TARDISes',
  'A small blue police box. Bigger on the inside. The most loyal pet you''ll ever own, if you can find the door.',
  '/assets/items/TARDIS_pet.png',
  25000,
  1,
  '["{sender} hands {target} {num} {item_name}. \"Take care of them.\"","{sender} gifts {target} {num} {item_name}.","{sender} entrusts {target} with {num} {item_name}. They look up at {target} expectantly."]',
  '[]',
  '[]',
  '["tardis","blue box","police box","time machine"]',
  'pet', 1, 745
),
(
  'gameboy',
  'Game Boy',
  'Game Boys',
  'A small grey handheld console. Plays exactly one cartridge. Battery: surprisingly fresh.',
  '/assets/items/gameboy.png',
  250,
  10,
  '["{sender} hands {target} {num} {item_name}.","{sender} offers {target} {num} {item_name}. \"It still works.\"","{sender} entrusts {target} with {num} {item_name}. The save file is suspect."]',
  '["{sender} hurls {num} {item_name} at {target}!","{sender} chucks {num} {item_name} at {target}. Plastic carnage."]',
  '["{sender} drops {num} {item_name} on {target}. *clatter*"]',
  '["game boy","handheld","console","gb"]',
  'tool', 1, 332
);
