-- Items catalog, admin-managed table of collectible items users can
-- buy with Currency, hold in their per-identity inventory, hand to
-- others via /give, or toss around via /throw / /drop.
--
-- Companion to:
--   identity_inventory      (0095), who owns how many of which item
--   identity_collection     (Phase 3, later migration), pinned showcase
--
-- Sale window semantics: `enabled` is the master existence switch
-- (when 0 the item is hidden everywhere and commands referencing it
-- are rejected, but EXISTING inventory rows are preserved so admins
-- can safely retire+revive an item without nuking inventories).
-- `for_sale` is independent, `enabled=1, for_sale=0` keeps the item
-- usable in commands while pulling it out of the shop. The optional
-- `sale_starts_at` / `sale_ends_at` window further constrains the
-- shop-listing time range. Server derives a `purchasable` boolean
-- from all four for the client.
--
-- Per-command message arrays are stored as JSON arrays of templates.
-- An empty array disables that command for the item, e.g. a "crown"
-- item with only `give_messages_json` populated cannot be /throw'n
-- or /drop'd. Placeholders: {sender} {target} {num} {item_name}
-- {item_icon}.

CREATE TABLE `items` (
  `key`              TEXT PRIMARY KEY,
  `name`             TEXT NOT NULL,
  `name_plural`      TEXT,
  `description`      TEXT NOT NULL DEFAULT '',
  `icon_url`         TEXT,
  `price`            INTEGER NOT NULL DEFAULT 0,
  `stack_limit`      INTEGER NOT NULL DEFAULT 99,
  `give_messages_json`  TEXT NOT NULL DEFAULT '[]',
  `throw_messages_json` TEXT NOT NULL DEFAULT '[]',
  `drop_messages_json`  TEXT NOT NULL DEFAULT '[]',
  `enabled`          INTEGER NOT NULL DEFAULT 1,
  `for_sale`         INTEGER NOT NULL DEFAULT 1,
  `sale_starts_at`   INTEGER,
  `sale_ends_at`     INTEGER,
  `order`            INTEGER NOT NULL DEFAULT 0,
  `is_builtin`       INTEGER NOT NULL DEFAULT 0,
  `created_at`       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at`       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint

CREATE INDEX `items_order_idx` ON `items`(`order`);
--> statement-breakpoint

CREATE INDEX `items_enabled_for_sale_idx` ON `items`(`enabled`, `for_sale`);
--> statement-breakpoint

-- Seed a starter set of built-in items so the system has content
-- the moment the migration lands. Admins can edit any field on these
-- rows (name, description, price, messages, icon) but cannot delete
-- them (is_builtin = 1). New items added via the admin UI default to
-- is_builtin = 0 and are fully deletable.
--
-- Prices are calibrated against existing currency awards (a single
-- chat message awards 1 Currency by default, so a 50-currency cookie
-- is roughly an hour of casual RP). Cheap items lean low-cost so
-- testers can /give freely; rare flavor items run higher to give the
-- economy somewhere to spend long-tail currency.

INSERT INTO `items` (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `is_builtin`, `order`) VALUES
(
  'cookie',
  'Cookie',
  'cookies',
  'A warm, chocolate-chip cookie. The classic gift, the classic projectile, the classic apology.',
  NULL,
  50,
  99,
  '["{sender} hands {target} {num} {item_name}.","{sender} offers {target} a fresh batch of {num} {item_name}.","{sender} sneaks {num} {item_name} into {target}''s pocket."]',
  '["{sender} hurls {num} {item_name} at {target}!","{sender} launches {num} {item_name} across the room, {target} barely ducks.","{sender} winds up and pelts {target} with {num} {item_name}."]',
  '["{sender} drops {num} {item_name} on {target}''s head.","{sender} fumbles and dumps {num} {item_name} all over {target}."]',
  1, 10
),
(
  'rose',
  'Rose',
  'roses',
  'A single red rose. Hand it over romantically, or throw it dramatically.',
  NULL,
  120,
  20,
  '["{sender} presents {target} with {num} {item_name}.","{sender} bows and offers {target} {num} {item_name}."]',
  '["{sender} hurls {num} {item_name} at {target}, thorns first.","{sender} pelts {target} with {num} {item_name}."]',
  '["{sender} lets {num} {item_name} fall at {target}''s feet."]',
  1, 20
),
(
  'pie',
  'Pie',
  'pies',
  'A whole pie. Mostly used to demonstrate physics.',
  NULL,
  80,
  10,
  '["{sender} carefully hands {target} {num} {item_name}."]',
  '["{sender} smashes {num} {item_name} into {target}''s face!","{sender} launches {num} {item_name} at {target} with full custard force.","{sender} cream-pies {target} {num} time(s)."]',
  '["{sender} drops {num} {item_name} on {target} with a glorious splat."]',
  1, 30
),
(
  'pillow',
  'Pillow',
  'pillows',
  'A soft pillow. The world''s least threatening weapon.',
  NULL,
  60,
  20,
  '["{sender} tosses {target} {num} {item_name} for the road."]',
  '["{sender} smacks {target} with {num} {item_name}!","{sender} bonks {target} with {num} {item_name}.","{sender} whaps {target} {num} time(s) with a {item_name}."]',
  '["{sender} drops {num} {item_name} on {target}, fwump."]',
  1, 40
),
(
  'rock',
  'Rock',
  'rocks',
  'A regular rock. Heavier than it looks.',
  NULL,
  20,
  50,
  '["{sender} hands {target} {num} {item_name}. ""For luck.""","{sender} gives {target} {num} {item_name}. {target} blinks."]',
  '["{sender} hurls {num} {item_name} at {target}!","{sender} chucks {num} {item_name} squarely at {target}.","{sender} pelts {target} with {num} {item_name}."]',
  '["{sender} drops {num} {item_name} on {target}''s foot.","{sender} lets {num} {item_name} fall on {target} from a worrying height."]',
  1, 50
),
(
  'ale',
  'Ale',
  'ales',
  'A frothy tankard of ale. Round''s on you.',
  NULL,
  100,
  10,
  '["{sender} slides {target} {num} {item_name} across the bar.","{sender} buys {target} {num} {item_name}. Cheers.","{sender} clinks tankards with {target}, {num} {item_name} change hands."]',
  '["{sender} flings {num} {item_name} at {target}, splash!","{sender} dumps {num} {item_name} on {target}''s head."]',
  '["{sender} spills {num} {item_name} on {target}. Bartender weeps."]',
  1, 60
),
(
  'dagger',
  'Dagger',
  'daggers',
  'A short blade. Mostly decorative. Mostly.',
  NULL,
  300,
  5,
  '["{sender} presents {target} with {num} {item_name}, hilt-first.","{sender} entrusts {target} with {num} {item_name}."]',
  '["{sender} throws {num} {item_name} at {target}. {target} ducks.","{sender} hurls {num} {item_name} at {target}, nailed the wall."]',
  '["{sender} drops {num} {item_name} on {target}. Pointy end first."]',
  1, 70
),
(
  'gold_coin',
  'Gold Coin',
  'gold coins',
  'A heavy coin stamped with the Keep''s sigil. Decorative; the real currency is elsewhere.',
  NULL,
  250,
  99,
  '["{sender} tosses {target} {num} {item_name}. ""Drinks on me.""","{sender} presses {num} {item_name} into {target}''s palm.","{sender} flips {num} {item_name} to {target}."]',
  '["{sender} pelts {target} with {num} {item_name}!"]',
  '["{sender} drops {num} {item_name} on {target}. Clink."]',
  1, 80
),
(
  'scroll',
  'Scroll',
  'scrolls',
  'A rolled parchment, sealed with wax. Contents unknown.',
  NULL,
  200,
  10,
  '["{sender} hands {target} {num} {item_name}. ""Read it later.""","{sender} entrusts {target} with {num} sealed {item_name}."]',
  '["{sender} flings {num} {item_name} at {target} like a javelin."]',
  '["{sender} drops {num} {item_name} on {target}''s lap."]',
  1, 90
),
(
  'crown',
  'Crown',
  'crowns',
  'A small ceremonial crown. For declaring someone the room''s monarch.',
  NULL,
  1500,
  3,
  '["{sender} places {num} {item_name} on {target}''s head. All hail.","{sender} crowns {target} with {num} {item_name}. The throne is theirs."]',
  '[]',
  '["{sender} drops {num} {item_name} on {target}. Coronation by accident."]',
  1, 100
);
