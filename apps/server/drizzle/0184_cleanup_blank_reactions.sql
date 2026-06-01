-- One-shot cleanup: drop reaction rows whose unicode_char column is
-- empty / whitespace-only. Those rows render as blank chips on the
-- client because the picker / typeahead at some point stored an
-- empty value instead of the codepoint. The route validation
-- (zod min(1)) now prevents new ones, the loader in
-- apps/server/src/reactions.ts skips them defensively, and the
-- client ReactionGlyph falls back to "?" — this migration just
-- removes the stragglers so the unique index doesn't carry orphan
-- placeholders.
--
-- Also drops rows where neither ref shape is set (both unicode_char
-- IS NULL AND sheet_id IS NULL). Those should be impossible under
-- the post-0181 schema but the cleanup is cheap.

DELETE FROM `message_reactions`
 WHERE (unicode_char IS NOT NULL AND TRIM(unicode_char) = '')
    OR (unicode_char IS NULL AND sheet_id IS NULL);
