-- Eidolon Tamer toys: five REUSABLE `category:'toy'` play-things for the
-- familiar (not consumed when used — owning one grants unlimited play for a
-- bigger, varied joy boost beyond the free Play gesture). Per-toy effects live
-- in @thekeep/shared (EIDOLON_TOY_EFFECT); the /arcade/eidolon/toy route applies
-- them. Fresh `toy_*` keys (no collision with the existing feather/snowball/
-- playing_dice/water_balloon trinkets) reuse those item art assets. Social
-- commands are disabled (empty give/throw/drop) — toys are for the familiar.
-- INSERT OR IGNORE keeps re-runs safe.

INSERT OR IGNORE INTO `items`
  (`key`, `name`, `name_plural`, `description`, `icon_url`, `price`, `stack_limit`, `give_messages_json`, `throw_messages_json`, `drop_messages_json`, `aliases_json`, `category`, `is_builtin`, `order`)
VALUES
  ('toy_feather', 'Feather Teaser', 'Feather Teasers', 'A fluttering feather on a string. Your familiar can chase it for hours — lively, joyful play.', '/assets/items/feather.png', 150, 5, '[]', '[]', '[]', '[]', 'toy', 1, 700),
  ('toy_ball', 'Snow Ball', 'Snow Balls', 'A bouncing ball to chase and pounce on. Great fun, but all that running is tiring.', '/assets/items/snowball.png', 200, 5, '[]', '[]', '[]', '[]', 'toy', 1, 701),
  ('toy_dice', 'Bone Dice', 'sets of Bone Dice', 'A quiet little game of chance. A calm amusement that lifts the spirits without wearing it out.', '/assets/items/playing_dice.png', 120, 5, '[]', '[]', '[]', '[]', 'toy', 1, 702),
  ('toy_plushie', 'Cuddle Plushie', 'Cuddle Plushies', 'A soft companion to snuggle. Soothing comfort — pure joy, no strain.', '/assets/items/possum_plushie.png', 350, 5, '[]', '[]', '[]', '[]', 'toy', 1, 703),
  ('toy_balloon', 'Water Balloon', 'Water Balloons', 'A splashy game of catch that doubles as a little rinse. Joyful, and it freshens up your familiar.', '/assets/items/water_balloon.png', 180, 5, '[]', '[]', '[]', '[]', 'toy', 1, 704);
