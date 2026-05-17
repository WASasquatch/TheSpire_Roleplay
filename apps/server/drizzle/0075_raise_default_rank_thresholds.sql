-- Raise the default XP thresholds on the seeded rank_tiers rows so
-- climbing the ladder takes weeks/months/years instead of "a single
-- session". The starter values from 0065 were tuned during early
-- prototyping and turned out to let active users hit Distinguished
-- inside a week of normal posting — not the rare achievement that
-- name implies.
--
-- New ladder (for a moderately active user earning ~250-350 XP/day
-- via chat + forum + presence):
--   New Arrival   I…IV   →  ~1 day → ~1 week     (entry tier)
--   Active        I…IV   →  ~3 weeks → ~2 months (regular poster)
--   Recognized    I…IV   →  ~4 months → ~10 months
--   Established   I…IV   →  ~1 year → ~2 years
--   Distinguished I…IV   →  ~3 years → ~6 years
--   Legacy Member I…IV   →  ~8 years → ~12 years (lifer marker)
--
-- Each UPDATE is gated on the old default value so installs whose
-- admin has already tuned a tier keep the admin's number. Tiers that
-- still hold the 0065 seed value get bumped; everything else passes
-- through untouched.
UPDATE rank_tiers SET xp_threshold = 100     WHERE id = 'rt_new_arrival_2'   AND xp_threshold = 25;
UPDATE rank_tiers SET xp_threshold = 300     WHERE id = 'rt_new_arrival_3'   AND xp_threshold = 75;
UPDATE rank_tiers SET xp_threshold = 700     WHERE id = 'rt_new_arrival_4'   AND xp_threshold = 150;

UPDATE rank_tiers SET xp_threshold = 1500    WHERE id = 'rt_active_1'        AND xp_threshold = 300;
UPDATE rank_tiers SET xp_threshold = 3000    WHERE id = 'rt_active_2'        AND xp_threshold = 600;
UPDATE rank_tiers SET xp_threshold = 5500    WHERE id = 'rt_active_3'        AND xp_threshold = 1000;
UPDATE rank_tiers SET xp_threshold = 9000    WHERE id = 'rt_active_4'        AND xp_threshold = 1500;

UPDATE rank_tiers SET xp_threshold = 16000   WHERE id = 'rt_recognized_1'    AND xp_threshold = 2500;
UPDATE rank_tiers SET xp_threshold = 26000   WHERE id = 'rt_recognized_2'    AND xp_threshold = 4000;
UPDATE rank_tiers SET xp_threshold = 40000   WHERE id = 'rt_recognized_3'    AND xp_threshold = 6000;
UPDATE rank_tiers SET xp_threshold = 60000   WHERE id = 'rt_recognized_4'    AND xp_threshold = 9000;

UPDATE rank_tiers SET xp_threshold = 90000   WHERE id = 'rt_established_1'   AND xp_threshold = 13000;
UPDATE rank_tiers SET xp_threshold = 130000  WHERE id = 'rt_established_2'   AND xp_threshold = 18000;
UPDATE rank_tiers SET xp_threshold = 180000  WHERE id = 'rt_established_3'   AND xp_threshold = 24000;
UPDATE rank_tiers SET xp_threshold = 240000  WHERE id = 'rt_established_4'   AND xp_threshold = 32000;

UPDATE rank_tiers SET xp_threshold = 330000  WHERE id = 'rt_distinguished_1' AND xp_threshold = 42000;
UPDATE rank_tiers SET xp_threshold = 450000  WHERE id = 'rt_distinguished_2' AND xp_threshold = 55000;
UPDATE rank_tiers SET xp_threshold = 600000  WHERE id = 'rt_distinguished_3' AND xp_threshold = 70000;
UPDATE rank_tiers SET xp_threshold = 800000  WHERE id = 'rt_distinguished_4' AND xp_threshold = 90000;

UPDATE rank_tiers SET xp_threshold = 1100000 WHERE id = 'rt_legacy_member_1' AND xp_threshold = 115000;
UPDATE rank_tiers SET xp_threshold = 1500000 WHERE id = 'rt_legacy_member_2' AND xp_threshold = 145000;
UPDATE rank_tiers SET xp_threshold = 2000000 WHERE id = 'rt_legacy_member_3' AND xp_threshold = 180000;
UPDATE rank_tiers SET xp_threshold = 2700000 WHERE id = 'rt_legacy_member_4' AND xp_threshold = 225000;
