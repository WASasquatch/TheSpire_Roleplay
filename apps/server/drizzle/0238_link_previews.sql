-- Link previews (OpenGraph unfurls) for chat + forum messages.
--
-- messages.link_preview_json holds the unfurled card for the FIRST
-- http(s) link in the body: {"url","title","description","imageUrl",
-- "siteName"} - or {"hidden":true} after the author removes it (the
-- tombstone stops a re-unfurl from resurrecting the card). NULL = no
-- link, nothing unfurlable, or not processed yet.
ALTER TABLE `messages` ADD COLUMN `link_preview_json` TEXT;

-- Shared unfurl cache so popular links are fetched once per day, not
-- once per message (also throttles abuse of the outbound fetcher).
-- Negative results cache too (json = '{}').
CREATE TABLE `og_unfurl_cache` (
  `url` text PRIMARY KEY NOT NULL,
  `json` text NOT NULL DEFAULT '{}',
  `fetched_at` integer NOT NULL DEFAULT (unixepoch() * 1000)
);
