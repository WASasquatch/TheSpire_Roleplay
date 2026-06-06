-- Snapshot of the built-in items' template fields after admin
-- iteration. Captures the canonical "installation defaults" so a
-- fresh install + a wiped/restored DB land on the same templates
-- the live site is using right now.
--
-- Scope: ONLY the template-shaped fields are reset:
--   name, name_plural, description, icon_url,
--   give_messages_json, throw_messages_json, drop_messages_json,
--   aliases_json
--
-- Per-server tunables are intentionally LEFT ALONE:
--   price, stack_limit, enabled, for_sale, sale_starts_at,
--   sale_ends_at, order
--, so an admin who's adjusted prices or pulled an item from sale
-- on their server doesn't lose those settings when this migration
-- runs. Templates / icons / aliases are content the system author
-- owns; pricing + availability are content the admin owns.
--
-- Idempotent: applying twice writes the same values. Safe to
-- re-run after a DB restore or as part of a "reset built-in
-- content to canon" admin operation.

UPDATE `items` SET
  `name`                = 'Cookie',
  `name_plural`         = 'cookies',
  `description`         = 'A warm, chocolate-chip cookie. The classic gift, the classic projectile, the classic apology.',
  `icon_url`            = '/assets/items/cookie.png',
  `give_messages_json`  = '["{sender} hands {target} {num} {item_name}.","{sender} offers {target} a fresh batch of {num} {item_name}.","{sender} sneaks {num} {item_name} into {target}''s pocket."]',
  `throw_messages_json` = '["{sender} hurls {num} {item_name} at {target}!","{sender} launches {num} {item_name} across the room at {target}.","{sender} winds up and pelts {target} with {num} {item_name}."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}''s head.","{sender} fumbles and dumps {num} {item_name} all over {target}."]',
  `aliases_json`        = '["biscuit"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'cookie';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Rose',
  `name_plural`         = 'roses',
  `description`         = 'A single red rose. Hand it over romantically, or throw it dramatically.',
  `icon_url`            = '/assets/items/rose.png',
  `give_messages_json`  = '["{sender} presents {target} with {num} {item_name}.","{sender} bows and offers {target} {num} {item_name}."]',
  `throw_messages_json` = '["{sender} hurls {num} {item_name} at {target}, thorns first.","{sender} pelts {target} with {num} {item_name}."]',
  `drop_messages_json`  = '["{sender} lets {num} {item_name} fall at {target}''s feet."]',
  `aliases_json`        = '["flower"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'rose';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Pie',
  `name_plural`         = 'pies',
  `description`         = 'A whole pie. Mostly used to demonstrate physics.',
  `icon_url`            = '/assets/items/pie.png',
  `give_messages_json`  = '["{sender} carefully hands {target} {num} {item_name}."]',
  `throw_messages_json` = '["{sender} smashes {num} {item_name} into {target}''s face!","{sender} launches {num} {item_name} at {target} with full custard force.","{sender} cream-pies {target} {num} time(s)."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target} with a glorious splat."]',
  `aliases_json`        = '["tart"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'pie';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Pillow',
  `name_plural`         = 'pillows',
  `description`         = 'A soft pillow. The world''s least threatening weapon.',
  `icon_url`            = '/assets/items/pillow.png',
  `give_messages_json`  = '["{sender} tosses {target} {num} {item_name} for the road."]',
  `throw_messages_json` = '["{sender} smacks {target} with {num} {item_name}!","{sender} bonks {target} with {num} {item_name}.","{sender} whaps {target} {num} time(s) with a {item_name}."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}, fwump."]',
  `aliases_json`        = '["cushion"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'pillow';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Rock',
  `name_plural`         = 'rocks',
  `description`         = 'A regular rock. Heavier than it looks.',
  `icon_url`            = '/assets/items/rock.png',
  `give_messages_json`  = '["{sender} hands {target} {num} {item_name}. \"For luck.\"","{sender} gives {target} {num} {item_name}. {target} blinks."]',
  `throw_messages_json` = '["{sender} hurls {num} {item_name} at {target}!","{sender} chucks {num} {item_name} squarely at {target}.","{sender} pelts {target} with {num} {item_name}."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}''s foot.","{sender} lets {num} {item_name} fall on {target} from a worrying height."]',
  `aliases_json`        = '["stone","pebble"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'rock';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Ale',
  `name_plural`         = 'ales',
  `description`         = 'A frothy tankard of ale. Round''s on you.',
  `icon_url`            = '/assets/items/ale.png',
  `give_messages_json`  = '["{sender} slides {target} {num} {item_name} across the bar.","{sender} buys {target} {num} {item_name}. Cheers.","{sender} clinks tankards with {target}, {num} {item_name} change hands."]',
  `throw_messages_json` = '["{sender} flings {num} {item_name} at {target}. *splash!*","{sender} dumps {num} {item_name} on {target}''s head."]',
  `drop_messages_json`  = '["{sender} spills {num} {item_name} on {target}.","{sender} drop kicks {num} {item_name} at {target}."]',
  `aliases_json`        = '["beer","drink","tankard","mead"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'ale';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Dagger',
  `name_plural`         = 'daggers',
  `description`         = 'A short blade. Mostly decorative. Mostly.',
  `icon_url`            = '/assets/items/dagger.png',
  `give_messages_json`  = '["{sender} presents {target} with {num} {item_name}, hilt-first.","{sender} entrusts {target} with {num} {item_name}."]',
  `throw_messages_json` = '["{sender} throws {num} {item_name} at {target}.","{sender} hurls {num} {item_name} at {target} and nails them to the wall."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}. Pointy end first.","{sender} drops {num} {item_name} on {target}. \"Oops!\""]',
  `aliases_json`        = '["knife","blade"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'dagger';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Gold Coin',
  `name_plural`         = 'gold coins',
  `description`         = 'A heavy coin stamped with the Keep''s sigil. Decorative; the real currency is elsewhere.',
  `icon_url`            = NULL,
  `give_messages_json`  = '["{sender} tosses {target} {num} {item_name}. \"Drinks on me.\"","{sender} presses {num} {item_name} into {target}''s palm.","{sender} flips {num} {item_name} to {target}."]',
  `throw_messages_json` = '["{sender} pelts {target} with {num} {item_name}!"]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}. Clink."]',
  `aliases_json`        = '["coin","coins","gp","gold","piece"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'gold_coin';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Scroll',
  `name_plural`         = 'scrolls',
  `description`         = 'A rolled parchment, sealed with wax. Contents unknown.',
  `icon_url`            = '/assets/items/scroll.png',
  `give_messages_json`  = '["{sender} hands {target} {num} {item_name}. \"Read it later.\"","{sender} entrusts {target} with {num} sealed {item_name}."]',
  `throw_messages_json` = '["{sender} flings {num} {item_name} at {target} like a javelin."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}."]',
  `aliases_json`        = '["parchment","letter","note"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'scroll';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Crown',
  `name_plural`         = 'crowns',
  `description`         = 'A small ceremonial crown. For declaring someone the room''s monarch.',
  `icon_url`            = '/assets/items/crown.png',
  `give_messages_json`  = '["{sender} places {num} {item_name} on {target}''s head. All hail.","{sender} crowns {target} with {num} {item_name}. The throne is theirs."]',
  `throw_messages_json` = '["{sender} chucks {num} {item_name} at {target}. Coronation by will."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}. Coronation by accident."]',
  `aliases_json`        = '["coronet"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'crown';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Tiara',
  `name_plural`         = 'tiaras',
  `description`         = 'A delicate jeweled tiara. Royal-adjacent, like a crown that doesn''t commit.',
  `icon_url`            = '/assets/items/tiara.png',
  `give_messages_json`  = '["{sender} gently places {num} {item_name} on {target}''s head.","{sender} crowns {target} with {num} {item_name}. Most regal.","{sender} hands {target} {num} {item_name}. The court approves."]',
  `throw_messages_json` = '["{sender} flings {num} {item_name} at {target}. Sparkly impact."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}. Bedazzled."]',
  `aliases_json`        = '["diadem","circlet"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'tiara';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Cake',
  `name_plural`         = 'cakes',
  `description`         = 'A whole layered cake. Frosting and candles included.',
  `icon_url`            = '/assets/items/cake.png',
  `give_messages_json`  = '["{sender} cuts {target} a slice of {item_name}.","{sender} hands {target} {num} {item_name}. Make a wish.","{sender} offers {target} {num} {item_name}."]',
  `throw_messages_json` = '["{sender} smashes {num} {item_name} into {target}''s face!","{sender} launches {num} {item_name} at {target} with full frosting force.","{sender} pelts {target} with {num} {item_name}. Sprinkles everywhere."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}. Frosting everywhere.","{sender} drops {num} {item_name} on {target}''s head. *Splat!*"]',
  `aliases_json`        = '["torte","gateau"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'cake';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Hammock of Cake',
  `name_plural`         = 'hammocks of cake',
  `description`         = 'A hammock. Made entirely of cake. Don''t ask how, do enjoy the nap.',
  `icon_url`            = '/assets/items/hammock-of-cake.png',
  `give_messages_json`  = '["{sender} gifts {target} {num} {item_name}. The dream is real.","{sender} hands {target} {num} {item_name}. Sweet dreams, literally."]',
  `throw_messages_json` = '["{sender} hurls {num} {item_name} at {target}. Physics quietly gives up.","{sender} flings {num} {item_name} at {target}. They are partially upholstered now."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}. They are now part of the dessert."]',
  `aliases_json`        = '["hammock"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'hammock_of_cake';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'House',
  `name_plural`         = 'houses',
  `description`         = 'A modest two-bedroom house. Fully furnished. Inexplicably portable.',
  `icon_url`            = '/assets/items/house.png',
  `give_messages_json`  = '["{sender} hands {target} the deed to {num} {item_name}.","{sender} signs {num} {item_name} over to {target}. Mind the mortgage."]',
  `throw_messages_json` = '["{sender} chucks {num} {item_name} at {target}. Property values plummet.","{sender} hurls {num} {item_name} at {target}. The HOA has questions."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}. \"That''ll teach ''em.\"","{sender} drops {num} {item_name} on {target}. Checks for curled toes."]',
  `aliases_json`        = '["home","cottage"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'house';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Mansion',
  `name_plural`         = 'mansions',
  `description`         = 'A sprawling mansion with too many bathrooms. Insurance: declined.',
  `icon_url`            = '/assets/items/mansion.png',
  `give_messages_json`  = '["{sender} hands {target} the keys to {num} {item_name}.","{sender} gifts {target} {num} {item_name}. Try not to lose it."]',
  `throw_messages_json` = '["{sender} flings {num} {item_name} at {target}. The grand piano lands out of tune.","{sender} hurls {num} {item_name} at {target}. The chandelier survives. Briefly."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}. The east wing collapses on impact.","{sender} drops {num} {item_name} on {target}. Butlers scurry and disperse in all directions."]',
  `aliases_json`        = '["manor","estate","chateau"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'mansion';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Keep',
  `name_plural`         = 'keeps',
  `description`         = 'A fortified stone tower, the central holdfast of any proper castle. Built to last; built, apparently, to fall on people too.',
  `icon_url`            = '/assets/items/keep-fortress.png',
  `give_messages_json`  = '["{sender} hands {target} the deed to {num} {item_name}. Defend it well.","{sender} entrusts {target} with {num} {item_name}. The Keep stands. For now."]',
  `throw_messages_json` = '["{sender} catapults {num} {item_name} at {target}. The siege has reversed.","{sender} flings {num} {item_name} at {target}. Battlements first."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}. The Keep has fallen... directly on {target}.","{sender} drops {num} {item_name} on {target}. \"Light the beacons!\""]',
  `aliases_json`        = '["fortress","citadel","bastion"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'fortress';
--> statement-breakpoint

UPDATE `items` SET
  `name`                = 'Castle',
  `name_plural`         = 'castles',
  `description`         = 'A proper medieval castle. Drawbridge functional. Throne included.',
  `icon_url`            = '/assets/items/castle.png',
  `give_messages_json`  = '["{sender} grants {target} {num} {item_name}. The realm is yours.","{sender} crowns {target} lord of {num} {item_name}. Long may they reign."]',
  `throw_messages_json` = '["{sender} catapults {num} {item_name} at {target}!","{sender} besieges {target} with {num} {item_name}. Trebuchets included."]',
  `drop_messages_json`  = '["{sender} drops {num} {item_name} on {target}. Drawbridge: down. Permanently.","{sender} drops {num} {item_name} on {target}. Kingdom, revoked."]',
  `aliases_json`        = '["palace","fort","stronghold"]',
  `updated_at`          = (unixepoch() * 1000)
 WHERE `key` = 'castle';
