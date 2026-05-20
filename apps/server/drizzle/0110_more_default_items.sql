-- New builtin items from the asset drop.
--
-- Three groups:
--
--   1. Iconic-figure plushies (gift category, $1500, stack 3) — same
--      pricing as kaal_dragon_plushie / deina_plushie so the shop reads
--      the named-character plushies as a coherent tier. Includes three
--      special character plushies whose descriptions came from the
--      user verbatim (king_dragon_plushie / levert_plushie /
--      vitality_plushie) and twelve classic pop-culture characters.
--
--   2. Weapons (weapon category) in three tiers — basic / knights /
--      embelished — plus a few specials (shuriken, war hammer, two
--      sceptors). Pricing scales with tier:
--        basic      :   400 (stack 5)
--        knights    :  2500 (stack 3)
--        embelished :  8000 (stack 2)
--        specials   :   150 to 12000 depending on rarity
--
--   3. Food extensions (food category, 50-200, stacks 20-40), plus
--      retro-handhelds + the Spire arcade machine (tool category to
--      match the existing gameboy classification), and three new
--      loong-style dragon pets (pet category, $22000-35000, stack 1).
--
-- Every template uses the {icon} {item_name} convention introduced
-- in migration 0109 so the inline icon renders alongside the name
-- on /give /throw /drop. Order slots are picked so each group sits
-- contiguous in the shop UI without overlapping existing ranges.
--
-- Safety: every INSERT uses `INSERT OR IGNORE` rather than the bare
-- INSERT used in earlier item migrations (0094, 0102, 0104…). The
-- earlier convention pre-dated the admin Items panel, so collisions
-- with admin-authored custom items couldn't happen. Now that admins
-- can mint custom item keys via the dashboard, a coincidental slug
-- collision (e.g. someone already added their own `pretzel` or
-- `basic_sword`) would otherwise abort this migration AND block
-- every subsequent migration. `OR IGNORE` lets the admin's row win
-- silently — they lose the new seed for that one key (admin items
-- panel surfaces the discrepancy) but the rest of the catalog +
-- later migrations still apply cleanly.

/* ---------- Plushies (gift / 1500 / stack 3) ---------- */

INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'levert_plushie',
  'Levert Plushie',
  'Levert plushies',
  'A sweet little bun with idol charm.',
  '/assets/items/levert_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Idol-grade hug.","{sender} offers {target} {num} {icon} {item_name}. *sparkle*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! *pop-idol shriek*","{sender} flings {num} {icon} {item_name} at {target}. Cute, but yes, projectile."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. Bunshaped delivery."]',
  '["levert","levert plush","bun plush"]',
  'gift', 1, 800
),
(
  'king_dragon_plushie',
  'King Dragon Plushie',
  'King dragon plushies',
  'Kazan "King" Ryusei is a fierce but soft-hearted plushie, scarred by centuries of rule yet still protective, regal, and secretly gentle.',
  '/assets/items/king_dragon_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Bow first, hug second.","{sender} entrusts {target} with {num} {icon} {item_name}. The King approves."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Regal squeak.","{sender} flings {num} {icon} {item_name} at {target}. The King is displeased."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. Crowned squish."]',
  '["king","king plush","king dragon","kazan","ryusei"]',
  'gift', 1, 801
),
(
  'vitality_plushie',
  'Vitality Plushie',
  'Vitality plushies',
  'Vitality is a bashful springtime love-god plushie with cherry-blossom curls, button-bright eyes, and a soft little heart full of life, kindness, and new beginnings.',
  '/assets/items/vitality_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Spring arrives.","{sender} offers {target} {num} {icon} {item_name}. *blush*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Petals everywhere.","{sender} flings {num} {icon} {item_name} at {target}. Cherry-blossom carnage."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. Soft little landing."]',
  '["vitality","vitality plush","love plush","spring plush"]',
  'gift', 1, 802
),
(
  'alice_plushie',
  'Alice Plushie',
  'Alice plushies',
  'A plushie of Alice, freshly returned from Wonderland. Slightly bewildered.',
  '/assets/items/Alice_Plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Curiouser, curiouser.","{sender} offers {target} {num} {icon} {item_name}. Don''t drink the tea."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Down the rabbit hole.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *small thump*"]',
  '["alice","alice plush","wonderland plush"]',
  'gift', 1, 803
),
(
  'mad_hatter_plushie',
  'Mad Hatter Plushie',
  'Mad Hatter plushies',
  'A plushie of the Mad Hatter. Comes with the tiniest tea set.',
  '/assets/items/Mad_Hatter_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. The tea is on.","{sender} entrusts {target} with {num} {icon} {item_name}. *tips tiny hat*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Hat first.","{sender} flings {num} {icon} {item_name} at {target}. Why is a raven like a writing desk?"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *clink of tiny porcelain*"]',
  '["hatter","mad hatter","hatter plush","wonderland plush"]',
  'gift', 1, 804
),
(
  'dorothy_plushie',
  'Dorothy Plushie',
  'Dorothy plushies',
  'A plushie of Dorothy, ruby slippers in tow. There''s no place like home.',
  '/assets/items/dorothy_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. *click click click*","{sender} offers {target} {num} {icon} {item_name}. Eye of the cyclone."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Picked up by the wind.","{sender} flings {num} {icon} {item_name} at {target}. Toto, no."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *soft Kansas thud*"]',
  '["dorothy","dorothy plush","oz plush"]',
  'gift', 1, 805
),
(
  'tin_woodman_plushie',
  'Tin Woodman Plushie',
  'Tin Woodman plushies',
  'A plushie of the Tin Woodman. He just wanted a heart. Stuffed with one.',
  '/assets/items/tin_woodman_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Surprisingly warm.","{sender} offers {target} {num} {icon} {item_name}. *clink*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Metal-on-target.","{sender} flings {num} {icon} {item_name} at {target}. Heartfelt impact."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *tin clatter*"]',
  '["tin","tin woodman","woodman plush","tin man","tin man plush"]',
  'gift', 1, 806
),
(
  'merlin_plushie',
  'Merlin Plushie',
  'Merlin plushies',
  'A plushie of the great wizard Merlin. Hat optional. Wisdom included.',
  '/assets/items/Merlin_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. *muttered incantation*","{sender} offers {target} {num} {icon} {item_name}. The stars approve."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Robe billows mid-flight.","{sender} flings {num} {icon} {item_name} at {target}. Wizardly thwack."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *soft starlit landing*"]',
  '["merlin","merlin plush","wizard plush"]',
  'gift', 1, 807
),
(
  'sherlock_holmes_plushie',
  'Sherlock Holmes Plushie',
  'Sherlock Holmes plushies',
  'A plushie of the great detective. Comes with a tiny magnifying glass.',
  '/assets/items/sherlock_holmes_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Elementary.","{sender} offers {target} {num} {icon} {item_name}. *deductive eyebrow*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! The game is afoot.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *Baker Street thud*"]',
  '["sherlock","holmes","sherlock plush","detective plush"]',
  'gift', 1, 808
),
(
  'captain_hook_plushie',
  'Captain Hook Plushie',
  'Captain Hook plushies',
  'A plushie of the dread Captain Hook. The hook is felt, not steel.',
  '/assets/items/captain_hook_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Mind the hook.","{sender} offers {target} {num} {icon} {item_name}. *ticking clock distantly*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Yo ho!","{sender} flings {num} {icon} {item_name} at {target}. Bad form, bad form."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *plank squeak*"]',
  '["hook","captain hook","pirate plush"]',
  'gift', 1, 809
),
(
  'dracula_plushie',
  'Dracula Plushie',
  'Dracula plushies',
  'A plushie of the Count himself. Suspiciously cold to the touch.',
  '/assets/items/Dracula_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Bidden in.","{sender} offers {target} {num} {icon} {item_name}. *bat squeak*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Velvet impact.","{sender} flings {num} {icon} {item_name} at {target}. Garlic optional."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *cape rustle*"]',
  '["dracula","dracula plush","count plush","vampire plush"]',
  'gift', 1, 810
),
(
  'frankenstein_plushie',
  'Frankenstein Plushie',
  'Frankenstein plushies',
  'A plushie of Frankenstein''s monster. Misunderstood, but huggable.',
  '/assets/items/Frankenstein_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Gentle giant.","{sender} entrusts {target} with {num} {icon} {item_name}. *thunderclap*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! IT''S ALIVE!","{sender} flings {num} {icon} {item_name} at {target}. Bolt-rattling thud."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *seismic squish*"]',
  '["frankenstein","monster plush","franken plush"]',
  'gift', 1, 811
),
(
  'cleopatra_plushie',
  'Cleopatra Plushie',
  'Cleopatra plushies',
  'A regal plushie of the last Pharaoh of Egypt. Gold-thread sash included.',
  '/assets/items/cleopatra_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. The Pharaoh acknowledges you.","{sender} presents {target} with {num} {icon} {item_name}. *kohl-rimmed wink*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Royal projectile.","{sender} flings {num} {icon} {item_name} at {target}. Cleopatra is unamused."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *Nile breeze*"]',
  '["cleo","cleopatra","cleopatra plush","pharaoh plush"]',
  'gift', 1, 812
),
(
  'sun_wukong_plushie',
  'Sun Wukong Plushie',
  'Sun Wukong plushies',
  'A plushie of the Monkey King. Mischief sold separately.',
  '/assets/items/Sun_Wukong_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. *staff twirl*","{sender} offers {target} {num} {icon} {item_name}. Heaven trembles."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Cloud-summoned arc.","{sender} flings {num} {icon} {item_name} at {target}. 72 transformations of impact."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *mischievous squish*"]',
  '["wukong","sun wukong","monkey king","monkey king plush"]',
  'gift', 1, 813
),
(
  'white_tiger_plushie',
  'White Tiger Plushie',
  'White Tiger plushies',
  'A plushie of a sacred white tiger. Soft, fierce, beloved.',
  '/assets/items/white_tiger_plushie.png',
  1500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Guardian of the West.","{sender} offers {target} {num} {icon} {item_name}. *purr*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Striped projectile.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *padded landing*"]',
  '["white tiger","tiger plush","byakko plush"]',
  'gift', 1, 814
);
--> statement-breakpoint

/* ---------- Weapons (weapon / tiered pricing) ---------- */

-- Basic tier — 400 / stack 5
INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'basic_sword',
  'Basic Sword',
  'basic swords',
  'A serviceable sword. Forge-stamped, plain hilt.',
  '/assets/items/basic_sword.png',
  400, 5,
  '["{sender} presents {target} with {num} {icon} {item_name}, hilt-first.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Tang first.","{sender} chucks {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *clang*"]',
  '["sword"]',
  'weapon', 1, 600
),
(
  'basic_axe',
  'Basic Axe',
  'basic axes',
  'A working axe. Splits wood, opponents, the occasional argument.',
  '/assets/items/basic_axe.png',
  400, 5,
  '["{sender} hands {target} {num} {icon} {item_name}, handle-first.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! End over end.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *thunk*"]',
  '["axe","hatchet"]',
  'weapon', 1, 601
),
(
  'basic_bow',
  'Basic Bow',
  'basic bows',
  'A short bow. Yew, sinew, the usual.',
  '/assets/items/basic_bow.png',
  400, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. Drawstring waxed.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Tumbling.","{sender} chucks {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *bowstring twang*"]',
  '["bow"]',
  'weapon', 1, 602
),
(
  'basic_crossbow',
  'Basic Crossbow',
  'basic crossbows',
  'A simple crossbow. Heavy trigger pull, satisfying release.',
  '/assets/items/basic_crossbow.png',
  400, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. Bolt-loaded? Probably not.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Stock-first.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *wooden clatter*"]',
  '["crossbow"]',
  'weapon', 1, 603
),
(
  'basic_mace',
  'Basic Mace',
  'basic maces',
  'A flanged head on a sturdy haft. Subtle as a sermon.',
  '/assets/items/basic_mace.png',
  400, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. Heavier than it looks.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Head over haft.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *meaty thud*"]',
  '["mace"]',
  'weapon', 1, 604
),
(
  'basic_spear',
  'Basic Spear',
  'basic spears',
  'A long-hafted spear. Reach is the whole point.',
  '/assets/items/basic_spear.png',
  400, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. Mind the tip.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Javelin form.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *shafted*"]',
  '["spear","javelin"]',
  'weapon', 1, 605
),
(
  'basic_war_sceptor',
  'Basic War Sceptor',
  'basic war sceptors',
  'A blunt, hexed sceptor — half cudgel, half catalyst.',
  '/assets/items/basic_war_sceptor.png',
  500, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. *faint hum*","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Sparking arc.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *runic clatter*"]',
  '["war sceptor","war scepter","battle sceptor"]',
  'weapon', 1, 606
);
--> statement-breakpoint

-- Knights tier — 2500 / stack 3
INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'knights_sword',
  'Knight''s Sword',
  'knights'' swords',
  'A knight''s well-balanced longsword. Pommel-stamped with a regiment crest.',
  '/assets/items/knights_sword.png',
  2500, 3,
  '["{sender} presents {target} with {num} {icon} {item_name}. Crested hilt.","{sender} entrusts {target} with {num} {icon} {item_name}. Honor in the steel."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Heroic arc.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *ceremonial clang*"]',
  '["knight sword","knights sword"]',
  'weapon', 1, 610
),
(
  'knights_axe',
  'Knight''s Axe',
  'knights'' axes',
  'A heavy-bladed battle-axe, banded steel, weighted for cavalry.',
  '/assets/items/knights_axe.png',
  2500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Banded steel.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! End over end.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *banded thud*"]',
  '["knight axe","knights axe"]',
  'weapon', 1, 611
),
(
  'knights_bow',
  'Knight''s Bow',
  'knights'' bows',
  'A longbow strung for a mounted archer. Inlaid grip.',
  '/assets/items/knights_bow.png',
  2500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Inlaid grip.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Tumbling.","{sender} chucks {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *string sigh*"]',
  '["knight bow","knights bow"]',
  'weapon', 1, 612
),
(
  'knights_crossbow',
  'Knight''s Crossbow',
  'knights'' crossbows',
  'A reinforced crossbow with a polished stock. Bolt-rack included.',
  '/assets/items/knights_crossbow.png',
  2500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Polished stock.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Stock-first.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *muffled snap*"]',
  '["knight crossbow","knights crossbow"]',
  'weapon', 1, 613
),
(
  'knights_mace',
  'Knight''s Mace',
  'knights'' maces',
  'A flanged mace with a chased silver grip. Built to dent armor.',
  '/assets/items/knights_mace.png',
  2500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Chased silver grip.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Head over haft.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *armor-denter*"]',
  '["knight mace","knights mace"]',
  'weapon', 1, 614
),
(
  'knights_spear',
  'Knight''s Spear',
  'knights'' spears',
  'A lance-style spear with a steel pennon. Built for the charge.',
  '/assets/items/knights_spear.png',
  2500, 3,
  '["{sender} hands {target} {num} {icon} {item_name}. Steel pennon.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Lance form.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *charged*"]',
  '["knight spear","knights spear","lance"]',
  'weapon', 1, 615
);
--> statement-breakpoint

-- Embelished tier — 8000 / stack 2
INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'embelished_sword',
  'Embellished Sword',
  'embellished swords',
  'A ceremonial sword chased with gold filigree. Too fine to fight with, too valuable to refuse.',
  '/assets/items/embelished_sword.png',
  8000, 2,
  '["{sender} presents {target} with {num} {icon} {item_name}. Gold filigree.","{sender} entrusts {target} with {num} {icon} {item_name}. A treasure."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Glittering arc.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *bejewelled clatter*"]',
  '["embellished sword","fancy sword"]',
  'weapon', 1, 620
),
(
  'embelished_axe',
  'Embellished Axe',
  'embellished axes',
  'A ceremonial axe — etched bit, jewelled boss, heirloom haft.',
  '/assets/items/embelished_axe.png',
  8000, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. Heirloom haft.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Glittering.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *jewelled thud*"]',
  '["embellished axe","fancy axe"]',
  'weapon', 1, 621
),
(
  'embelished_bow',
  'Embellished Bow',
  'embellished bows',
  'A bow carved with vinework, inlaid with pearl and silver. Almost too lovely to draw.',
  '/assets/items/embelished_bow.png',
  8000, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. Pearl inlay.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Tumbling.","{sender} chucks {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *string whisper*"]',
  '["embellished bow","fancy bow"]',
  'weapon', 1, 622
),
(
  'embelished_crossbow',
  'Embellished Crossbow',
  'embellished crossbows',
  'A jeweled crossbow with engraved limbs. As much heirloom as weapon.',
  '/assets/items/embelished_crossbow.png',
  8000, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. Engraved limbs.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Stock-first.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *jewelled snap*"]',
  '["embellished crossbow","fancy crossbow"]',
  'weapon', 1, 623
),
(
  'embelished_mace',
  'Embellished Mace',
  'embellished maces',
  'A ceremonial mace, gilded and gemmed. The head still bites, though.',
  '/assets/items/embelished_mace.png',
  8000, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. Gilded haft.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Head over haft.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *gilded crunch*"]',
  '["embellished mace","fancy mace"]',
  'weapon', 1, 624
),
(
  'embelished_spear',
  'Embellished Spear',
  'embellished spears',
  'A ceremonial spear with a pearled grip and a silvered head. Ceremonial; lethal anyway.',
  '/assets/items/embelished_spear.png',
  8000, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. Silvered head.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Lance form.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *ceremonial thunk*"]',
  '["embellished spear","fancy spear"]',
  'weapon', 1, 625
);
--> statement-breakpoint

-- Specials
INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'shuriken',
  'Shuriken',
  'shuriken',
  'A throwing star. Razor edges; designed to be thrown.',
  '/assets/items/shuriken.png',
  150, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Carefully.","{sender} offers {target} {num} {icon} {item_name}. *gleam*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Whirring arc.","{sender} flings {num} {icon} {item_name} at {target}. *thunk*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *metallic clink*"]',
  '["throwing star","star"]',
  'weapon', 1, 595
),
(
  'war_hammer',
  'War Hammer',
  'war hammers',
  'A heavy two-handed hammer. Ends arguments. Ends shields.',
  '/assets/items/war_hammer.png',
  5000, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. Two-handed grip.","{sender} entrusts {target} with {num} {icon} {item_name}. *thud*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Head over haft.","{sender} heaves {num} {icon} {item_name} at {target}. *seismic*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *floor shakes*"]',
  '["hammer","warhammer"]',
  'weapon', 1, 630
),
(
  'archmage_sceptor',
  'Archmage''s Sceptor',
  'archmage sceptors',
  'A sceptor of an archmage — gemstone head, runic shaft, faintly humming with stored ætherwork.',
  '/assets/items/archmage_sceptor.png',
  12000, 1,
  '["{sender} hands {target} {num} {icon} {item_name}. *audible hum*","{sender} entrusts {target} with {num} {icon} {item_name}. The runes brighten."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Arc of crackling light.","{sender} flings {num} {icon} {item_name} at {target}. *thaumic discharge*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *runic chime*"]',
  '["archmage sceptor","archmage scepter","archmage staff"]',
  'weapon', 1, 635
),
(
  'mages_battle_sceptor',
  'Mage''s Battle Sceptor',
  'mage''s battle sceptors',
  'A sceptor built for war, not study. Heavy at the head, etched along the shaft.',
  '/assets/items/mages_battle_sceptor.png',
  7000, 2,
  '["{sender} hands {target} {num} {icon} {item_name}. Heavy-headed.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Arcing.","{sender} flings {num} {icon} {item_name} at {target}. *flash*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *etched thunk*"]',
  '["battle sceptor","battle scepter","mage sceptor"]',
  'weapon', 1, 636
);
--> statement-breakpoint

/* ---------- More food (food / 50-200) ---------- */

INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'blueberry_muffin',
  'Blueberry Muffin',
  'blueberry muffins',
  'A warm muffin studded with blueberries. Wrapped in parchment.',
  '/assets/items/blueberry_muffin.png',
  75, 30,
  '["{sender} hands {target} {num} {icon} {item_name}. Still warm.","{sender} offers {target} {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Berry splatter.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *crumbly thud*"]',
  '["muffin","blueberry"]',
  'food', 1, 230
),
(
  'cranberry_bisquits',
  'Cranberry Biscuits',
  'cranberry biscuits',
  'A small batch of cranberry biscuits. Tart, buttery, dangerously moreish.',
  '/assets/items/cranberry_bisquits.png',
  60, 30,
  '["{sender} hands {target} {num} {icon} {item_name}. Still warm.","{sender} offers {target} {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Buttery splatter.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *crumbly thud*"]',
  '["biscuits","cranberry biscuits","scones"]',
  'food', 1, 231
),
(
  'herb_bread_loaf',
  'Herb Bread Loaf',
  'herb bread loaves',
  'A rustic loaf, flecked with rosemary and thyme. Crusty.',
  '/assets/items/herb_bread_loaf.png',
  80, 20,
  '["{sender} hands {target} {num} {icon} {item_name}. Smells of rosemary.","{sender} offers {target} {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Crusty impact.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *bready thud*"]',
  '["herb bread","herb loaf"]',
  'food', 1, 232
),
(
  'meat_pasty',
  'Meat Pasty',
  'meat pasties',
  'A hand-pie of meat and root veg, baked golden. Travel food, perfected.',
  '/assets/items/meat_pasty.png',
  120, 25,
  '["{sender} hands {target} {num} {icon} {item_name}. Wrapped in parchment.","{sender} offers {target} {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Gravy-bomb.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *flaky thud*"]',
  '["pasty","pasties","hand pie"]',
  'food', 1, 233
),
(
  'meat_pie',
  'Meat Pie',
  'meat pies',
  'A round meat pie. Rich gravy, golden crust, no questions asked.',
  '/assets/items/meat_pie.png',
  150, 20,
  '["{sender} hands {target} {num} {icon} {item_name}. Still steaming.","{sender} offers {target} {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Gravy everywhere.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *savoury splat*"]',
  '["pie","savoury pie"]',
  'food', 1, 234
),
(
  'pretzel',
  'Pretzel',
  'pretzels',
  'A salt-studded soft pretzel, knotted by hand.',
  '/assets/items/pretzel.png',
  50, 40,
  '["{sender} hands {target} {num} {icon} {item_name}. Salt crystals everywhere.","{sender} offers {target} {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Knotted projectile.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *salted thud*"]',
  '["pretzels"]',
  'food', 1, 235
),
(
  'chocolate_box',
  'Box of Chocolates',
  'boxes of chocolates',
  'A small box of assorted chocolates. You never know which one you''ll get.',
  '/assets/items/chocolate_box.png',
  200, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. *ribbon flutter*","{sender} offers {target} {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Truffles everywhere.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *chocolate clatter*"]',
  '["chocolates","box of chocolates","chocolate"]',
  'food', 1, 236
);
--> statement-breakpoint

/* ---------- Handhelds + consoles + arcade (tool / 250-5000) ---------- */

INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'gameboy_advanced_handheld',
  'Game Boy Advance',
  'Game Boy Advances',
  'A purple handheld with a wider screen. Cartridges still optional.',
  '/assets/items/gameboy_advanced_handheld.png',
  350, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Batteries: included this time.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Plastic carnage.","{sender} chucks {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *clatter*"]',
  '["gba","game boy advance","advance","gameboy advance"]',
  'tool', 1, 333
),
(
  'gamegear_handheld',
  'Game Gear',
  'Game Gears',
  'A chunky color handheld. Eats batteries for breakfast.',
  '/assets/items/gamegear_handheld.png',
  350, 10,
  '["{sender} hands {target} {num} {icon} {item_name}. Bring extra batteries.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Plastic carnage.","{sender} chucks {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *clatter*"]',
  '["game gear","gamegear"]',
  'tool', 1, 334
),
(
  'sega_genesis',
  'Sega Genesis',
  'Sega Genesises',
  'A black 16-bit console. Blast-processed.',
  '/assets/items/sega_genesis.png',
  800, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. Controller cable trails behind.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Heavy plastic arc.","{sender} chucks {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *blast-processed thud*"]',
  '["genesis","mega drive","sega"]',
  'tool', 1, 335
),
(
  'super_nintendo',
  'Super Nintendo',
  'Super Nintendos',
  'A grey 16-bit console with purple buttons. The classic.',
  '/assets/items/super_nintendo.png',
  900, 5,
  '["{sender} hands {target} {num} {icon} {item_name}. Cartridges sold separately.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Heavy plastic arc.","{sender} chucks {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *16-bit thud*"]',
  '["snes","super nintendo","super famicom"]',
  'tool', 1, 336
),
(
  'the_spire_arcade_machine',
  'The Spire Arcade Machine',
  'Spire Arcade Machines',
  'A full-cabinet arcade machine in Spire livery. Coin slot accepts nothing. Plays forever.',
  '/assets/items/the_spire_arcade_machine.png',
  5000, 1,
  '["{sender} hands {target} {num} {icon} {item_name}. ...somehow.","{sender} entrusts {target} with {num} {icon} {item_name}. *neon hum*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Impossibly.","{sender} heaves {num} {icon} {item_name} at {target}. *seismic*"]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *coin tray rattles*"]',
  '["arcade","spire arcade","arcade machine"]',
  'tool', 1, 340
);
--> statement-breakpoint

/* ---------- Loong dragons (pet / 22000-35000 / stack 1) ---------- */

INSERT OR IGNORE INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`) VALUES
(
  'green_loong_dragon',
  'Green Loong Dragon',
  'green loong dragons',
  'A serpentine eastern dragon, emerald-scaled and slow-coiling.',
  '/assets/items/green_loong_dragon.png',
  22000, 1,
  '["{sender} hands {target} {num} {icon} {item_name}. The dragon assents.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! The dragon protests.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *coil settles*"]',
  '["green loong","loong dragon","green dragon"]',
  'pet', 1, 870
),
(
  'red_loong_dragon',
  'Red Loong Dragon',
  'red loong dragons',
  'A vermillion eastern dragon, sun-bright and slow-burning.',
  '/assets/items/red_loong_dragon.png',
  25000, 1,
  '["{sender} hands {target} {num} {icon} {item_name}. Auspicious.","{sender} entrusts {target} with {num} {icon} {item_name}."]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Sun-bright protest.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *vermillion coil*"]',
  '["red loong","crimson loong"]',
  'pet', 1, 871
),
(
  'eternal_loong_dragon',
  'Eternal Loong Dragon',
  'eternal loong dragons',
  'A loong dragon woven from cloud and starlight. It has always been here.',
  '/assets/items/eternal_loong_dragon.png',
  35000, 1,
  '["{sender} hands {target} {num} {icon} {item_name}. Time bends, slightly.","{sender} entrusts {target} with {num} {icon} {item_name}. *the room hushes*"]',
  '["{sender} hurls {num} {icon} {item_name} at {target}! Cosmic protest.","{sender} flings {num} {icon} {item_name} at {target}."]',
  '["{sender} drops {num} {icon} {item_name} on {target}. *starlight settles*"]',
  '["eternal loong","celestial loong","ancient dragon"]',
  'pet', 1, 872
);
