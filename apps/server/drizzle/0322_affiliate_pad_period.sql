-- Top Communities traffic padding: switch the synthetic-traffic ramp from a
-- CALENDAR-day model to a ROLLING 24h period anchored to a real timestamp, so
-- the ramp always starts near 0 the moment padding is enabled or a period rolls
-- over (enabling late in the day no longer dumps most of a day's target at once).
-- The legacy `pad_day` text column is left in place (now unused). Additive.
ALTER TABLE `affiliates` ADD `pad_period_start` integer;
