-- 0352: rich-HTML chat message format.
-- Chat 'say' messages gain a second body format: sanitized rich HTML.
--   * `format`   — 'md' (historic markdown grammar, the default every
--                  existing row keeps forever) or 'html' (body holds
--                  server-sanitized rich HTML).
--   * `body_text` — server-derived visible plaintext of an 'html'
--                  body (block breaks as newlines, tags stripped).
--                  NULL on every 'md' row. Plaintext consumers
--                  (search, automod, notification snippets, caps)
--                  read COALESCE(body_text, body).
ALTER TABLE `messages` ADD COLUMN `format` text NOT NULL DEFAULT 'md';
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `body_text` text;
