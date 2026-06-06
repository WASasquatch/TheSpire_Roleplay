-- One-shot migration to keep legacy custom-command templates rendering the
-- way they used to after the kind="cmd" renderer change.
--
-- Pre-this-commit, every custom command's body was rendered with the
-- sender's display name *auto-prepended* by the chat client (same as /me).
-- Templates therefore typically read "hugs {target}" with the implicit
-- assumption that the client would paint "<Alice> hugs Bob".
--
-- Going forward custom commands render as kind="cmd" and the renderer
-- does NOT auto-prepend the name, the template controls placement via
-- a `{sender}` (or `{name}`) placeholder. New templates can put the
-- sender mid-sentence, at the end, or omit it entirely. To stop the
-- transition from silently dropping the sender name from every existing
-- command, this migration prepends "{sender} " to every legacy template
-- that doesn't already mention either placeholder.
--
-- The LIKE check is intentionally case-sensitive because the template
-- engine matches placeholders case-insensitively (`{Sender}` works the
-- same as `{sender}`), checking against lowercase covers the typical
-- author casing AND any odd-cased entries fall back to the prepend,
-- which is a no-op render-wise (the placeholder just appears earlier
-- in the body).
UPDATE custom_commands
SET template = '{sender} ' || template
WHERE LOWER(template) NOT LIKE '%{sender}%'
  AND LOWER(template) NOT LIKE '%{name}%';

-- The inline-only alternate template (added in 0059) is deliberately
-- NOT migrated. Inline templates render as text spliced into the host
-- message body, the host message's own kind ("me" / "say" / etc.)
-- already paints the sender's name at the start, so injecting another
-- {sender} into the inline output would produce "<Alice> ... Alice
-- flips a coin: heads" with the name duplicated mid-sentence.

-- Preserve the visual identity of legacy `kind = action` custom
-- commands after the kind="cmd" renderer change. Before this commit
-- action commands rode through the "me"-line renderer, which:
--   * italicized them via the action font family, and
--   * used `theme:action` as their default text color when the admin
--     hadn't pinned one.
-- The new `kind = "cmd"` line paints plain text by default, so on
-- upgrade those two visual signals would silently vanish from every
-- existing action command. We restore them by seeding the new css /
-- color fields on rows that don't already have an admin override:
--   * css = 'font-style: italic' for the italic emphasis,
--   * color = 'theme:action' to follow the viewer's palette.
-- The COALESCE check on each column makes the migration idempotent
-- and keeps any admin-authored value intact.
UPDATE custom_commands
SET css = 'font-style: italic'
WHERE kind = 'action' AND (css IS NULL OR css = '');

UPDATE custom_commands
SET color = 'theme:action'
WHERE kind = 'action' AND (color IS NULL OR color = '');
