-- Add a `category` column to the items catalog so the shop UI can
-- group items by kind (food, drink, joke, tool, weapon, armor, magic,
-- treasure, building, gift, pet, misc) and so the new Pet Collection
-- (5-slot, separate from the existing 10-slot Item Collection) can
-- gate which items are pinnable in which collection.
--
-- The category set is intentionally small (12 buckets) — fewer
-- buckets means tighter shop tabs and less admin guesswork when
-- assigning a new item. `misc` is the fallback for anything that
-- doesn't fit; the column is NOT NULL so every row has a value.
--
-- This migration categorizes every existing builtin via best guess.
-- Custom (admin-authored, is_builtin=0) items inherit the `misc`
-- default and admins can tag them via the editor.

ALTER TABLE `items` ADD COLUMN `category` TEXT NOT NULL DEFAULT 'misc';
--> statement-breakpoint

-- Food: anything edible. Cookies, fruit, meat, cheese, etc.
UPDATE `items` SET `category` = 'food'
 WHERE `key` IN ('cookie','pie','cake','hammock_of_cake','apple','pear','tomato','onion','mushroom','fish','cheese_wheel','loaf_of_bread','turkey_leg','bowl_of_stew','honeypot','candies');
--> statement-breakpoint

-- Drink: ale + every other beverage.
UPDATE `items` SET `category` = 'drink'
 WHERE `key` IN ('ale','coffee_in_mug','tea_in_teacup','wine_in_wineglass','horn_tankard');
--> statement-breakpoint

-- Joke: silly throwables, gag items.
UPDATE `items` SET `category` = 'joke'
 WHERE `key` IN ('pillow','rock','a_boot','rotten_egg','snowball','water_balloon','rubber_ducky','frog','cursed_spud','manure');
--> statement-breakpoint

-- Tool: utility, writing, navigation, tabletop. Cards and dice land
-- here too rather than their own micro-category — the bucket count
-- stays at 12.
UPDATE `items` SET `category` = 'tool'
 WHERE `key` IN ('candle','feather','compass','hourglass','lantern','old_key','quill_inkwell','servant_bell','smoking_pipe','playing_cards','playing_dice');
--> statement-breakpoint

-- Weapon: combat items. Dagger is the lone seed; admin-authored
-- weapons go here too.
UPDATE `items` SET `category` = 'weapon'
 WHERE `key` IN ('dagger');
--> statement-breakpoint

-- Armor: anything worn for protection.
UPDATE `items` SET `category` = 'armor'
 WHERE `key` IN ('leather_armor','chainmail_armor','plate_armor','mage_robes','golden_armor','royal_steel_armor','chromtic_legendary_armor');
--> statement-breakpoint

-- Magic: scrolls, potions, runes, tomes, orbs.
UPDATE `items` SET `category` = 'magic'
 WHERE `key` IN ('scroll','magical_rune','mysterious_potion','magical_book','magic_sphere');
--> statement-breakpoint

-- Treasure: precious metals + chests + maps. Decorative wealth.
UPDATE `items` SET `category` = 'treasure'
 WHERE `key` IN ('gold_coin','treasure_map','treasure_chest','copper_ingot','silver_ingot','gold_ingot');
--> statement-breakpoint

-- Building: dwellings + fortifications. The escalation tier.
UPDATE `items` SET `category` = 'building'
 WHERE `key` IN ('house','mansion','fortress','castle');
--> statement-breakpoint

-- Gift: romance + royal accessories + showpieces. Anything you'd
-- present rather than wield.
UPDATE `items` SET `category` = 'gift'
 WHERE `key` IN ('rose','crown','tiara','bouquet','love_letter','enagement_ring','keepsake_locket','masquerade_mask','paerlescent_shell','kaal_dragon_plushie');
--> statement-breakpoint

-- No existing items fall into 'pet' yet — that bucket fills entirely
-- from migration 0104's new seeds. 'misc' stays as the safety
-- default for any row this migration didn't catch (which should be
-- none — every is_builtin=1 row is enumerated above).

CREATE INDEX `items_category_idx` ON `items`(`category`);
