-- /describe: long-form world/setting description for a room. Shown to a user
-- once when they join (NOT persisted in their backlog or visible to people
-- already in the room). Distinct from `topic`, which is a short headline
-- displayed above the chat at all times.
ALTER TABLE `rooms` ADD `description` text;
