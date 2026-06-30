-- Servers Lift: the default server's slug should read as the chat NAME (e.g.
-- "The Spire" → "the-spire"), not the legacy "spire-server" / "spire". Rename it,
-- derived from the server's own name (spaces → hyphens, apostrophes dropped).
-- Idempotent: only the legacy hardcoded slugs are touched, so a re-run — or a
-- fresh install that already seeded "the-spire" — is a no-op.
UPDATE `servers`
  SET `slug` = lower(replace(replace(`name`, ' ', '-'), '''', '')),
      `updated_at` = unixepoch() * 1000
  WHERE `id` = 'server_spire_system' AND `slug` IN ('spire-server', 'spire');
