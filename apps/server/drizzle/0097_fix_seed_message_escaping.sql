-- Fix three seed items whose give_messages_json shipped with doubled
-- double-quotes (`""`) inside their JSON-string templates. SQLite's
-- single-quoted string literals only honor `''` for escaping single
-- quotes; double quotes are stored verbatim, which produces invalid
-- JSON inside the `give_messages_json` column. `parseItemMessages`
-- swallows the parse error and returns an empty array, so /give on
-- those items silently reports "can't be /given", load-bearing
-- flavor lost for `rock`, `gold_coin`, and `scroll`.
--
-- The correct JSON escape for a literal " inside a string is \",
-- the backslash passes through the SQL literal unchanged, then
-- JSON.parse interprets `\"` correctly. Each UPDATE below replaces
-- the corrupt row's value with the same intended templates, just
-- properly escaped.
--
-- Idempotent in spirit: any row that was already correctly escaped
-- gets a no-op overwrite with the same value.

UPDATE `items`
   SET `give_messages_json` = '["{sender} hands {target} {num} {item_name}. \"For luck.\"","{sender} gives {target} {num} {item_name}. {target} blinks."]'
 WHERE `key` = 'rock';
--> statement-breakpoint

UPDATE `items`
   SET `give_messages_json` = '["{sender} tosses {target} {num} {item_name}. \"Drinks on me.\"","{sender} presses {num} {item_name} into {target}''s palm.","{sender} flips {num} {item_name} to {target}."]'
 WHERE `key` = 'gold_coin';
--> statement-breakpoint

UPDATE `items`
   SET `give_messages_json` = '["{sender} hands {target} {num} {item_name}. \"Read it later.\"","{sender} entrusts {target} with {num} sealed {item_name}."]'
 WHERE `key` = 'scroll';
