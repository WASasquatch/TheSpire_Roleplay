-- Two concerns in one migration:
--
-- 1. Wire icon_url for every existing builtin that now has an asset
--    file under `apps/web/public/assets/items/`. The 0094 seed left
--    icon_url NULL on all rows; the dashboard rendered a letter-tile
--    placeholder for each. With real PNGs in place the UI now shows
--    proper icons in the shop, inventory list, profile Collection
--    block, and the dashboard's Collection slot grid. `gold_coin`
--    stays placeholder-only — no asset shipped for it yet.
--
-- 2. Add seven new builtin items from the same asset drop:
--      tiara              — small jeweled crown variant
--      cake               — wholesale dessert, separate from pie
--      hammock_of_cake    — meme item: a hammock made of cake
--      house              — modest portable home
--      mansion            — manor scale
--      castle             — palace scale, drawbridge included
--      fortress           — the Keep itself, with `keep` aliased
--                           so the joke `/drop kaal 1 keep` lands
--
-- Alias cleanup paired with #2: the existing `crown` row had
-- `tiara` + `circlet` in its aliases, and the existing `pie` row
-- had `cake` in its aliases. Now that those words name actual
-- items, leaving them on the older rows would make findItem's
-- json_each match ambiguous (LIMIT 1 picks an arbitrary winner —
-- a `/give kaal cake` could resolve to pie OR cake on different
-- runs). Strip the conflicting aliases off the older rows so each
-- alias resolves deterministically.

UPDATE `items` SET `icon_url` = '/assets/items/cookie.png'  WHERE `key` = 'cookie';
--> statement-breakpoint
UPDATE `items` SET `icon_url` = '/assets/items/rose.png'    WHERE `key` = 'rose';
--> statement-breakpoint
UPDATE `items` SET `icon_url` = '/assets/items/pie.png'     WHERE `key` = 'pie';
--> statement-breakpoint
UPDATE `items` SET `icon_url` = '/assets/items/pillow.png'  WHERE `key` = 'pillow';
--> statement-breakpoint
UPDATE `items` SET `icon_url` = '/assets/items/rock.png'    WHERE `key` = 'rock';
--> statement-breakpoint
UPDATE `items` SET `icon_url` = '/assets/items/ale.png'     WHERE `key` = 'ale';
--> statement-breakpoint
UPDATE `items` SET `icon_url` = '/assets/items/dagger.png'  WHERE `key` = 'dagger';
--> statement-breakpoint
UPDATE `items` SET `icon_url` = '/assets/items/scroll.png'  WHERE `key` = 'scroll';
--> statement-breakpoint
UPDATE `items` SET `icon_url` = '/assets/items/crown.png'   WHERE `key` = 'crown';
--> statement-breakpoint

-- Alias cleanup so the new tiara / cake rows don't clash with the
-- old crown / pie rows on lookup.
UPDATE `items` SET `aliases_json` = '["coronet"]' WHERE `key` = 'crown';
--> statement-breakpoint
UPDATE `items` SET `aliases_json` = '["tart"]'    WHERE `key` = 'pie';
--> statement-breakpoint

-- New builtin items. Pricing escalates with absurdity — tiara/cake
-- in the regular range, hammock_of_cake mid-premium, buildings on
-- a steep curve so they read as aspirational trophy items rather
-- than casual ammo. Stack limits drop with rarity for the same
-- reason: a fortress should never stack to 99 in a pocket.
INSERT INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `is_builtin`, `order`) VALUES
(
  'tiara',
  'Tiara',
  'tiaras',
  'A delicate jeweled tiara. Royal-adjacent — like a crown that doesn''t commit.',
  '/assets/items/tiara.png',
  800,
  5,
  '["{sender} gently places {num} {item_name} on {target}''s head.","{sender} crowns {target} with {num} {item_name}. Most regal.","{sender} hands {target} {num} {item_name}. The court approves."]',
  '["{sender} flings {num} {item_name} at {target}. Sparkly impact."]',
  '["{sender} drops {num} {item_name} on {target}. Bedazzled."]',
  '["diadem","circlet"]',
  1, 110
),
(
  'cake',
  'Cake',
  'cakes',
  'A whole layered cake. Frosting and candles included.',
  '/assets/items/cake.png',
  100,
  10,
  '["{sender} cuts {target} a slice of {item_name}.","{sender} hands {target} {num} {item_name}. Make a wish.","{sender} offers {target} {num} {item_name}."]',
  '["{sender} smashes {num} {item_name} into {target}''s face!","{sender} launches {num} {item_name} at {target} with full frosting force.","{sender} pelts {target} with {num} {item_name}. Sprinkles everywhere."]',
  '["{sender} drops {num} {item_name} on {target}. Frosting everywhere."]',
  '["torte","gateau"]',
  1, 120
),
(
  'hammock_of_cake',
  'Hammock of Cake',
  'hammocks of cake',
  'A hammock. Made entirely of cake. Don''t ask how, do enjoy the nap.',
  '/assets/items/hammock-of-cake.png',
  3000,
  3,
  '["{sender} gifts {target} {num} {item_name}. The dream is real.","{sender} hands {target} {num} {item_name}. Sweet dreams, literally."]',
  '["{sender} hurls {num} {item_name} at {target}. Physics quietly gives up.","{sender} flings {num} {item_name} at {target}. They are partially upholstered now."]',
  '["{sender} drops {num} {item_name} on {target}. They are now part of the dessert."]',
  '["hammock"]',
  1, 130
),
(
  'house',
  'House',
  'houses',
  'A modest two-bedroom house. Fully furnished. Inexplicably portable.',
  '/assets/items/house.png',
  5000,
  3,
  '["{sender} hands {target} the deed to {num} {item_name}.","{sender} signs {num} {item_name} over to {target}. Mind the mortgage."]',
  '["{sender} chucks {num} {item_name} at {target}. Property values plummet.","{sender} hurls {num} {item_name} at {target}. The HOA has questions."]',
  '["{sender} drops {num} {item_name} on {target}. The chimney lands first."]',
  '["home","cottage"]',
  1, 140
),
(
  'mansion',
  'Mansion',
  'mansions',
  'A sprawling mansion with too many bathrooms. Insurance: declined.',
  '/assets/items/mansion.png',
  12000,
  2,
  '["{sender} hands {target} the keys to {num} {item_name}.","{sender} gifts {target} {num} {item_name}. Try not to lose it."]',
  '["{sender} flings {num} {item_name} at {target}. The grand piano lands out of tune.","{sender} hurls {num} {item_name} at {target}. The chandelier survives. Briefly."]',
  '["{sender} drops {num} {item_name} on {target}. The east wing collapses on impact."]',
  '["manor","estate","chateau"]',
  1, 150
),
(
  'castle',
  'Castle',
  'castles',
  'A proper medieval castle. Drawbridge functional. Throne included.',
  '/assets/items/castle.png',
  25000,
  1,
  '["{sender} grants {target} {num} {item_name}. The realm is yours.","{sender} crowns {target} lord of {num} {item_name}. Long may they reign."]',
  '["{sender} catapults {num} {item_name} at {target}!","{sender} besieges {target} with {num} {item_name}. Trebuchets included."]',
  '["{sender} drops {num} {item_name} on {target}. Drawbridge: down. Permanently."]',
  '["palace","fort","stronghold"]',
  1, 160
),
(
  'fortress',
  'Fortress',
  'fortresses',
  'The Keep itself. Battlements, gates, the works. Built to last; built, apparently, to fall on people.',
  '/assets/items/keep-fortress.png',
  50000,
  1,
  '["{sender} hands {target} the deed to {num} {item_name}. Defend it well.","{sender} entrusts {target} with {num} {item_name}. The Keep stands. For now."]',
  '["{sender} catapults {num} {item_name} at {target}. The siege has reversed.","{sender} flings {num} {item_name} at {target}. Battlements first."]',
  '["{sender} drops {num} {item_name} on {target}. The Keep has fallen — directly on {target}."]',
  '["keep","citadel","bastion"]',
  1, 170
);
