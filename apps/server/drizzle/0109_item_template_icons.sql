-- Add the {icon} placeholder to every item's command-message
-- templates. Server-side renderTemplate now expands {icon} (and the
-- legacy alias {item_icon}) into a <icon src="…"> tag that the chat
-- markdown renderer shows as an inline 1.2em image. Placing the icon
-- right before {item_name} reads naturally regardless of locale or
-- whether num is plural: "WAS hurls 3 🍪 cookies at Kaal".
--
-- Implementation: a global REPLACE on the three message JSON columns.
-- Every existing builtin template uses `{item_name}` somewhere, so
-- the substitution lands on each template once. Templates that
-- already happen to include `{icon}` (none today, but harmless if
-- some admin pre-edited) get a duplicate icon — admins can clean
-- those up via the editor.
--
-- Scope: ALL items, not just builtins. Custom items added by admins
-- via the dashboard pick up the same upgrade so their /give /throw
-- /drop lines also show the icon inline without manual re-editing.
--
-- Idempotency: a second run of this migration would double the
-- `{icon} ` prefix in every template. The _migrations table guard
-- in apply-migrations.mjs ensures one-time execution per DB.

UPDATE `items` SET
  `give_messages_json`  = REPLACE(`give_messages_json`,  '{item_name}', '{icon} {item_name}'),
  `throw_messages_json` = REPLACE(`throw_messages_json`, '{item_name}', '{icon} {item_name}'),
  `drop_messages_json`  = REPLACE(`drop_messages_json`,  '{item_name}', '{icon} {item_name}'),
  `updated_at`          = (unixepoch() * 1000);
