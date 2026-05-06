-- Disclaimer rendered above the register form. Users must tick a checkbox
-- accepting it before /auth/register accepts the submission. Admin-editable
-- alongside the rules and security notice.
ALTER TABLE `site_settings` ADD `register_disclaimer_html` text NOT NULL DEFAULT '<p>This is a <b>free-form roleplay chat</b>. Characters, scenes, and stories created here are works of fiction authored by the people writing them. The views expressed in roleplay are not those of the site authors, the operators, or the software itself.</p>
<p>Some themes explored in roleplay (violence, conflict, mature content in private rooms, dark fiction, etc.) <b>may be offensive or upsetting to some people</b>. Use your best judgement about what you read and what you participate in, and remember that you can leave any room or scene at any time.</p>
<p>Be <b>respectful and kind</b> to other users out-of-character. The fiction is shared between consenting players; the people behind the keyboards deserve the same courtesy you would give anyone else.</p>
<p>By creating an account you confirm that you have read and accept the house rules and this disclaimer.</p>';
