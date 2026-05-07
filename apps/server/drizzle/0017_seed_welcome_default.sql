-- Seed a default welcome message for installs that haven't customized it
-- yet. Only fires when welcome_html is still the migration-0014 empty
-- default; admin-customized values are preserved.
UPDATE `site_settings`
SET `welcome_html` = '<p>Welcome, traveler. This is a sanctuary for free-form roleplay and collaborative storytelling.</p>
<p>Sign in to enter the chambers. New writers are always welcome. Register an account, build a character or two, and find your way to a scene.</p>'
WHERE `id` = 'singleton' AND `welcome_html` = '';
