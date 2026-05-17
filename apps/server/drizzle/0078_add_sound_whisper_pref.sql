-- Distinct sound for inbound whispers (whisper.mp3). Was previously
-- folded under the DM ping toggle because we only shipped three
-- audio files (ping / tap / alert); shipping a fourth (whisper.mp3)
-- splits the two events apart so users can mute one independently
-- of the other. Default ON to match the existing per-event posture
-- (opt-out, not opt-in).
ALTER TABLE users ADD COLUMN sound_whisper_enabled INTEGER NOT NULL DEFAULT 1;
