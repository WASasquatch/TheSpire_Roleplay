-- Rename the Fortress builtin to "Keep" and reposition it BELOW Castle
-- in both price and shop order. Historically a keep is the central
-- fortified tower of a castle — smaller and more focused than a full
-- castle complex — so it sits naturally between Mansion and Castle on
-- the building escalation curve rather than above it.
--
-- The internal slug stays `fortress`. Renaming the PK would cascade
-- through identity_inventory + identity_collection FKs (CASCADE on
-- DELETE only; UPDATE would error if any rows referenced the old key),
-- and the joke value lives in the user-facing name, not the slug.
-- Admins viewing the catalog see `key=fortress, name=Keep` — small
-- cognitive dent for a much safer migration.
--
-- Alias housekeeping: `keep` was the alias that landed the
-- "/drop kaal 1 keep" joke under the old "Fortress" name. Now that
-- the row IS named "Keep" the alias becomes redundant (the name
-- match takes the row first), so it's dropped. `fortress` joins the
-- alias list so anyone who learned the old name on a previous build
-- still resolves to the same row.
--
-- Pricing slot: between mansion (12000) and castle (25000) — 18000
-- reads as a meaningful step up from mansion without rivaling castle.
-- Stack cap drops to 2 to match mansion (one less than castle's 1
-- being the upper bound feels right; keeps and mansions cap at the
-- same point as "one or two trophy items in a pocket"). Order moves
-- from 170 to 155 so the shop list reads small→large in price.

UPDATE `items` SET
  `name`         = 'Keep',
  `name_plural`  = 'keeps',
  `description`  = 'A fortified stone tower — the central holdfast of any proper castle. Built to last; built, apparently, to fall on people too.',
  `price`        = 18000,
  `stack_limit`  = 2,
  `aliases_json` = '["fortress","citadel","bastion"]',
  `order`        = 155,
  `updated_at`   = (unixepoch() * 1000)
 WHERE `key` = 'fortress';
