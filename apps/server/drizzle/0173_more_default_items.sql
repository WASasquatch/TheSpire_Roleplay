-- Asset-drop seed of items whose PNG sat in /assets/items but never
-- had a catalog row to point at it. Pricing follows the tiers
-- established in 0102/0110 so the new items slot into the shop's
-- price ladders without standing out as outliers.
--
-- Tier overview:
--   * Pets (cats / dog / white tiger), 2500-12000, stack 1.
--   * Plushies (frodo, timelord), 1500 stack 3, matching the
--     iconic-figure plushie tier 0110 established.
--   * Greeter hats, 600 stack 5, gift category. Decorative.
--   * Sonic-screwdriver tier, 1500-2500 stack 2, tool category.
--   * Curio junk (broken / worn / lost / rotten things),
--     30-120 stack 5-10, joke category. Cheap, throwable, gag.
--   * pouch_of_gold → treasure 500 stack 5.
--   * foraged_herbs → food 80 stack 10.
--
-- Order slots: 1500-1599 reserved for this drop so the shop UI
-- presents the new items together without rewriting prior bands.
--
-- Every INSERT uses `INSERT OR IGNORE`. If an admin already minted
-- a custom item under one of these slugs, the seed silently no-ops
-- for that key, admins keep their edit, the rest of the catalog
-- still seeds.
--
-- Every template uses the `{icon} {item_name}` convention from
-- migration 0109 so the inline icon renders alongside the name on
-- /give /throw /drop chat lines.

/* ---------- Pets ---------- */

INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'guide_dog',
  'Guide Dog',
  'guide dogs',
  'A patient, devoted companion trained to lead and protect. Loyal beyond measure.',
  '/assets/items/guide_dog.png',
  3500, 1,
  '["{sender} entrusts {target} with {num} {icon} {item_name}. A steady companion.","{sender} hands {target} the lead. {num} {icon} {item_name}, ready to walk."]',
  '["{sender} would never throw {num} {icon} {item_name}, but {target} catches the harness with care.","{sender} sends {num} {icon} {item_name} bounding toward {target}."]',
  '["{sender} drops {num} {icon} {item_name} at {target}''s feet. Tail wagging."]',
  '["dog","guide","seeing dog","service dog"]',
  'pet', 1, 1500
),
(
  'maine_coon',
  'Maine Coon',
  'Maine Coons',
  'A long-haired giant of a cat, gentle as a kitten, regal as a lion.',
  '/assets/items/maine_coon.png',
  3000, 1,
  '["{sender} hands {target} {num} {icon} {item_name}. Heavy and purring.","{sender} sets {num} {icon} {item_name} in {target}''s arms. Mane fluffed."]',
  '["{sender} lobs {num} {icon} {item_name} at {target}. *indignant meow*","{sender} flings {num} {icon} {item_name}. The cat is unimpressed."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. Sploot."]',
  '["maine","coon cat","longhair cat"]',
  'pet', 1, 1501
),
(
  'orange_tabby_cat',
  'Orange Tabby',
  'orange tabbies',
  'A sun-warm tabby with two brain cells and infinite chaos.',
  '/assets/items/orange_tabby_cat.png',
  2500, 1,
  '["{sender} hands {target} {num} {icon} {item_name}. *purr engaged*","{sender} drops {num} {icon} {item_name} into {target}''s lap. He is in charge now."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! *cat-shaped projectile*","{sender} chucks {num} {icon} {item_name}. He lands on his feet."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. Loafmode."]',
  '["tabby","orange cat","ginger cat","marmalade cat"]',
  'pet', 1, 1502
),
(
  'black_cat',
  'Black Cat',
  'black cats',
  'Sleek shadow-shaped trouble. Allegedly unlucky. She disagrees.',
  '/assets/items/black_cat.png',
  2500, 1,
  '["{sender} hands {target} {num} {icon} {item_name}. Slow blink.","{sender} sets {num} {icon} {item_name} on {target}''s shoulder. *prrrrt*"]',
  '["{sender} tosses {num} {icon} {item_name} at {target}. *teleport*","{sender} flings {num} {icon} {item_name}. The cat lands eight feet away, judging."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *sploot of darkness*"]',
  '["bombay","midnight cat","void cat"]',
  'pet', 1, 1503
),
(
  'white_tiger',
  'White Tiger',
  'white tigers',
  'A snow-pale apex predator. Beautiful, deadly, and ill-advised as a houseguest.',
  '/assets/items/white_tiger.png',
  12000, 1,
  '["{sender} entrusts {target} with {num} {icon} {item_name}. Mind the teeth.","{sender} hands {target} the leash to {num} {icon} {item_name}. Good luck."]',
  '["{sender} sets {num} {icon} {item_name} loose at {target}! *low growl*","{sender} flings {num} {icon} {item_name} toward {target}. A bad day for everyone."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. The tiger does not appreciate this."]',
  '["tiger","snow tiger","albino tiger"]',
  'pet', 1, 1504
);
--> statement-breakpoint

/* ---------- Plushies (gift / 1500 / stack 3) ---------- */

INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'frodo_baggins_plushie',
  'Frodo Baggins Plushie',
  'Frodo Baggins plushies',
  'A small, weary hobbit clutching a tiny golden ring. The ring is sewn on, mostly.',
  '/assets/items/frodo_baggins_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. The journey continues.","{sender} offers {target} {num} {icon} {item_name}. Mind the precious."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Into Mordor!","{sender} flings {num} {icon} {item_name} at {target}. A short hobbit-shaped arc."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *small thump*"]',
  '["frodo","frodo plush","hobbit plush","ringbearer plush"]',
  'gift', 1, 1510
),
(
  'timelord_plushie',
  'Timelord Plushie',
  'Timelord plushies',
  'A bow-tied stranger with two hearts and a wardrobe full of regenerations.',
  '/assets/items/timelord_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Wibbly-wobbly.","{sender} offers {target} {num} {icon} {item_name}. Bigger on the inside."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Allons-y!","{sender} flings {num} {icon} {item_name} at {target}. Geronimo."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *fez landing*"]',
  '["timelord","doctor plush","time lord plush"]',
  'gift', 1, 1511
);
--> statement-breakpoint

/* ---------- Greeter hats (gift / 600 / stack 5) ---------- */

INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'greeter_hat_male',
  'Greeter''s Cap',
  'Greeter''s caps',
  'A neatly brushed wool cap worn by those who welcome travelers at the gate.',
  '/assets/items/greeter_hat_male.png',
  600, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. Welcome, friend.","{sender} offers {target} {num} {icon} {item_name}. Mind the brim."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. Caught, barely.","{sender} hurls {num} {icon} {item_name} at {target}. *flap flap*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. Adjust later."]',
  '["greeter cap","welcome hat","gatekeeper hat"]',
  'gift', 1, 1520
),
(
  'greeter_hat_female',
  'Greeter''s Bonnet',
  'Greeter''s bonnets',
  'A ribbon-trimmed bonnet worn by gatekeepers who like to make an entrance.',
  '/assets/items/greeter_hat_female.png',
  600, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. Welcome, friend.","{sender} offers {target} {num} {icon} {item_name}. Tie the ribbon snug."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. Caught, barely.","{sender} hurls {num} {icon} {item_name} at {target}. *ribbon flutter*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. Adjust later."]',
  '["greeter bonnet","welcome bonnet","gatekeeper bonnet"]',
  'gift', 1, 1521
);
--> statement-breakpoint

/* ---------- Sonic screwdrivers (tool / 1500-2500 / stack 2) ---------- */

INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'classic_sonic',
  'Classic Sonic Driver',
  'classic sonic drivers',
  'An older, brass-fitted sonic device. Hums at a frequency only doors recognize.',
  '/assets/items/classic_sonic.png',
  1500, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. Point and click.","{sender} offers {target} {num} {icon} {item_name}. *hum*"]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *zzzz-clink*","{sender} hurls {num} {icon} {item_name} at {target}. Not built for throwing."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *bzzt*"]',
  '["sonic","classic sonic","screwdriver"]',
  'tool', 1, 1530
),
(
  'amber_sonic',
  'Amber Sonic Driver',
  'amber sonic drivers',
  'A sonic device set with a warm amber crystal. The hum is friendlier than most.',
  '/assets/items/amber_sonic.png',
  1800, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. The crystal pulses.","{sender} offers {target} {num} {icon} {item_name}. *warm hum*"]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *zzzt-thump*","{sender} hurls {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. Amber glow fades."]',
  '["amber sonic","amber screwdriver"]',
  'tool', 1, 1531
),
(
  'verdant_sonic',
  'Verdant Sonic Driver',
  'verdant sonic drivers',
  'A sonic device of mossy green. Tuned, allegedly, for organic locks.',
  '/assets/items/verdant_sonic.png',
  1800, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. Leaves rustle, somehow.","{sender} offers {target} {num} {icon} {item_name}. *low whir*"]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *whrrrr-clack*","{sender} hurls {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *soft thunk*"]',
  '["verdant sonic","green sonic","verdant screwdriver"]',
  'tool', 1, 1532
),
(
  '12th_sonic',
  '12th Sonic Driver',
  '12th sonic drivers',
  'A weathered sonic with brass detailing and a temper. Doors comply, eventually.',
  '/assets/items/12th_sonic.png',
  2000, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. *gruff hum*","{sender} offers {target} {num} {icon} {item_name}. Try the long press."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *zzzt-clatter*","{sender} hurls {num} {icon} {item_name} at {target}. Eyebrows raised."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *grumpy whir*"]',
  '["12th sonic","12 sonic","twelfth sonic"]',
  'tool', 1, 1533
),
(
  '14th_sonic',
  '14th Sonic Driver',
  '14th sonic drivers',
  'A spry sonic with a confident chirp. Built for adventure and rooftop landings.',
  '/assets/items/14th_sonic.png',
  2200, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. *chirp*","{sender} offers {target} {num} {icon} {item_name}. Allons-y, then."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *zzzt-skitter*","{sender} hurls {num} {icon} {item_name} at {target}. Caught mid-spin."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *small chime*"]',
  '["14th sonic","14 sonic","fourteenth sonic"]',
  'tool', 1, 1534
),
(
  'war_sonic',
  'War Sonic Driver',
  'war sonic drivers',
  'A battered sonic carried through wars no one likes to name. The hum is heavier.',
  '/assets/items/war_sonic.png',
  2500, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. Keep it close.","{sender} offers {target} {num} {icon} {item_name}. *low, tired hum*"]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *deep zzzzt*","{sender} hurls {num} {icon} {item_name} at {target}. Built to take a hit."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *thud*"]',
  '["war sonic","war screwdriver"]',
  'tool', 1, 1535
);
--> statement-breakpoint

/* ---------- Curio junk (joke / 30-120 / stack 5-10) ---------- */

INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'linen_wrap',
  'Linen Wrap',
  'linen wraps',
  'A length of plain linen cloth. Bandage, sling, scarf, whatever you need.',
  '/assets/items/linen_wrap.png',
  60, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Practical.","{sender} offers {target} {num} {icon} {item_name}. Wrap something."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *flap*","{sender} hurls {num} {icon} {item_name} at {target}. It lands on their head."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *soft fold*"]',
  '["bandage","cloth","wrap","linen"]',
  'joke', 1, 1540
),
(
  'broken_tusk',
  'Broken Tusk',
  'broken tusks',
  'A snapped boar tusk. A trophy of a fight nobody won.',
  '/assets/items/broken_tusk.png',
  80, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Mind the edge.","{sender} offers {target} {num} {icon} {item_name}. Souvenir."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *clack*","{sender} hurls {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *thunk*"]',
  '["tusk","boar tusk","cracked tusk"]',
  'joke', 1, 1541
),
(
  'broken_pottery_bowl',
  'Broken Pottery Bowl',
  'broken pottery bowls',
  'Half a clay bowl, glaze chipped, jagged on one side. Useless. Unless.',
  '/assets/items/broken_pottery_bowl.png',
  40, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Mind the rim.","{sender} offers {target} {num} {icon} {item_name}. Sort of a bowl."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *clatter*","{sender} hurls {num} {icon} {item_name} at {target}. *more breaking*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *crack*"]',
  '["broken bowl","pottery shard","cracked bowl"]',
  'joke', 1, 1542
),
(
  'bag_of_rotten_provisions',
  'Bag of Rotten Provisions',
  'bags of rotten provisions',
  'A sack that smelled like dinner six weeks ago. Now it smells like a war crime.',
  '/assets/items/bag_of_rotten_provisions.png',
  30, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Hold your breath.","{sender} offers {target} {num} {icon} {item_name}. *gag*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! *squelch*","{sender} flings {num} {icon} {item_name} at {target}. The smell carries."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. The fumes linger."]',
  '["rotten food","spoiled rations","stinky sack"]',
  'joke', 1, 1543
),
(
  'rusted_iron_horseshoe',
  'Rusted Iron Horseshoe',
  'rusted iron horseshoes',
  'A pitted horseshoe orange with rust. Lucky, allegedly. Mostly heavy.',
  '/assets/items/rusted_iron_horseshoe.png',
  60, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. For luck.","{sender} offers {target} {num} {icon} {item_name}. Mind the rust."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! *clang*","{sender} flings {num} {icon} {item_name} at {target}. *ow*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *heavy clunk*"]',
  '["horseshoe","rusty horseshoe","lucky horseshoe"]',
  'joke', 1, 1544
),
(
  'worn_out_leather_glove',
  'Worn-out Leather Glove',
  'worn-out leather gloves',
  'A single old glove. The other hand is fending for itself.',
  '/assets/items/worn_out_leather_glove.png',
  50, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Only the one, sorry.","{sender} offers {target} {num} {icon} {item_name}. Better than nothing."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *slap*","{sender} hurls {num} {icon} {item_name} at {target}. A duel, perhaps?"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *limp thump*"]',
  '["old glove","leather glove","mitt"]',
  'joke', 1, 1545
),
(
  'bent_tin_plate',
  'Bent Tin Plate',
  'bent tin plates',
  'A camp plate that lost a fight with a boot. Still holds soup. Mostly.',
  '/assets/items/bent_tin_plate.png',
  40, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Hold it level.","{sender} offers {target} {num} {icon} {item_name}. Sort of a plate."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}. *frisbee*","{sender} flings {num} {icon} {item_name} at {target}. *ting*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *clang*"]',
  '["tin plate","camp plate","dented plate"]',
  'joke', 1, 1546
),
(
  'old_wooden_spoon',
  'Old Wooden Spoon',
  'old wooden spoons',
  'A cracked spoon, handle worn smooth. Used to stir somebody''s grandmother''s stew.',
  '/assets/items/old_wooden_spoon.png',
  30, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Stir something.","{sender} offers {target} {num} {icon} {item_name}. Heirloom."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *bonk*","{sender} hurls {num} {icon} {item_name} at {target}. The wood splinters slightly."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *small tap*"]',
  '["wooden spoon","old spoon","stirring spoon"]',
  'joke', 1, 1547
),
(
  'broken_glass_bottle',
  'Broken Glass Bottle',
  'broken glass bottles',
  'A bottle, snapped at the neck. Whoever made the previous toast did it with feeling.',
  '/assets/items/broken_glass_bottle.png',
  40, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. Careful.","{sender} offers {target} {num} {icon} {item_name}. By the bottom, please."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! *crash*","{sender} flings {num} {icon} {item_name} at {target}. *tinkle of doom*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *more breaking*"]',
  '["broken bottle","smashed bottle","tavern bottle"]',
  'joke', 1, 1548
),
(
  'old_tin_cup',
  'Old Tin Cup',
  'old tin cups',
  'A dented tin cup, ringed inside from a hundred coffee mornings.',
  '/assets/items/old_tin_cup.png',
  40, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Refill anytime.","{sender} offers {target} {num} {icon} {item_name}. Holds at least most of it."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *ting*","{sender} hurls {num} {icon} {item_name} at {target}. *clink*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *clang*"]',
  '["tin cup","camp cup","dented cup"]',
  'joke', 1, 1549
),
(
  'worn_cracked_leather_boots',
  'Worn Cracked Leather Boots',
  'worn cracked leather boots',
  'A pair of boots that have walked further than most. The soles flap a little.',
  '/assets/items/worn_cracked_leather_boots.png',
  90, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. Broke in already.","{sender} offers {target} {num} {icon} {item_name}. Mileage included."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! *thwack*","{sender} flings {num} {icon} {item_name} at {target}. *boot to the head*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *heavy thump*"]',
  '["old boots","cracked boots","worn boots"]',
  'joke', 1, 1550
),
(
  'old_frayed_rope',
  'Old Frayed Rope',
  'old frayed ropes',
  'A coil of rope, frayed at both ends and unreliable in the middle. Lash with care.',
  '/assets/items/old_frayed_rope.png',
  50, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Test it first.","{sender} offers {target} {num} {icon} {item_name}. Holds, probably."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *whip*","{sender} hurls {num} {icon} {item_name} at {target}. *lasso, briefly*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *soft coil*"]',
  '["frayed rope","old rope","unreliable rope"]',
  'joke', 1, 1551
),
(
  'broken_mug',
  'Broken Mug',
  'broken mugs',
  'A handled mug minus the handle. Held grog once. Now holds disappointment.',
  '/assets/items/broken_mug.png',
  40, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Just hold it from the side.","{sender} offers {target} {num} {icon} {item_name}. Functional, mostly."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *clay shrapnel*","{sender} hurls {num} {icon} {item_name} at {target}. *crash*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *more cracking*"]',
  '["broken mug","cracked mug","handleless mug"]',
  'joke', 1, 1552
),
(
  'old_broken_key',
  'Old Broken Key',
  'old broken keys',
  'A snapped iron key. Whatever it opened is locked forever now.',
  '/assets/items/old_broken_key.png',
  80, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Mystery included.","{sender} offers {target} {num} {icon} {item_name}. Try it on something."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *small clink*","{sender} hurls {num} {icon} {item_name} at {target}. *ping*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *tiny thunk*"]',
  '["broken key","snapped key","old key"]',
  'joke', 1, 1553
);
--> statement-breakpoint

/* ---------- Treasure: pouch_of_gold (treasure / 500 / stack 5) ---------- */

INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'pouch_of_gold',
  'Pouch of Gold',
  'pouches of gold',
  'A leather purse jangling with coin. Heavier than it looks.',
  '/assets/items/pouch_of_gold.png',
  500, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. Spend it well.","{sender} tosses {target} {num} {icon} {item_name}. *coin-jingle*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! *coin shower*","{sender} flings {num} {icon} {item_name} at {target}. Lucky catch."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *heavy clink*"]',
  '["gold pouch","coin pouch","purse"]',
  'treasure', 1, 1560
);
--> statement-breakpoint

/* ---------- Food: foraged_herbs (food / 80 / stack 10) ---------- */

INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'foraged_herbs',
  'Foraged Herbs',
  'bundles of foraged herbs',
  'A bundle of wild greens. Bright, fragrant, and mostly edible.',
  '/assets/items/foraged_herbs.png',
  80, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. From the wood.","{sender} offers {target} {num} {icon} {item_name}. Smells like the woods."]',
  '["{sender} flings {num} {icon} {item_name} at {target}. *leafy patter*","{sender} hurls {num} {icon} {item_name} at {target}. Herbs everywhere."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *soft rustle*"]',
  '["herbs","wild herbs","foraged greens"]',
  'food', 1, 1570
);
--> statement-breakpoint
