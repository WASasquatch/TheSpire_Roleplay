-- Affiliates v2: discovery tags on community cards, mirroring the chat-server /
-- forum tag system (a `tags_json` TEXT column holding a JSON string[], NULL when
-- empty). Powers the tag chips + search/filter on the Top RP Communities board.

ALTER TABLE `affiliates` ADD `tags_json` text;
