-- The bio Designer was introduced gated off (0241). Flip the existing settings
-- row on so it's available by default; admins who want it off can toggle it in
-- site settings. (The column default is also updated to 1 for fresh installs.)
UPDATE `site_settings` SET `profile_designer_enabled` = 1;
