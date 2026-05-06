-- Site Rules + Security notice. Both rendered in the Rules modal opened from
-- the banner. Admins edit rulesHtml freely; securityNoticeHtml stays editable
-- but defaults to the canonical privacy contract so users always see it.
ALTER TABLE `site_settings` ADD `rules_html` text NOT NULL DEFAULT '<h3>House Rules</h3>
<ol>
<li><b>Stay in character.</b> Out-of-character chatter belongs in (( double parentheses )) or in OOC rooms.</li>
<li><b>Consent matters.</b> Negotiate dark, sexual, or violent themes with your scene partners before play. Honor "no" without negotiation.</li>
<li><b>No god-modding.</b> Do not dictate other characters'' actions, thoughts, or outcomes. Ask the other player or roll for contested actions.</li>
<li><b>Respect pace.</b> Do not pressure others to post faster, write longer, or play scenes they are uncomfortable with.</li>
<li><b>Keep IC and OOC separate.</b> A character''s hostility is not the player''s. Take grievances out of the scene.</li>
<li><b>Mind the rating.</b> Public rooms are general-audience by default; explicit content belongs in private rooms with consenting participants.</li>
<li><b>No real-world hate.</b> Bigotry, harassment, and targeting of real people are out-of-bounds in any room.</li>
<li><b>Report problems.</b> If something crosses a line, screenshot and report to an admin rather than escalating in chat.</li>
</ol>';
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `security_notice_html` text NOT NULL DEFAULT '<h3>Privacy & Safety</h3>
<p>Private rooms and whispered messages are <b>not readable by administrators</b>. Admins can see who is in a private room and the room''s metadata, but never the contents of what is said there or in any whisper.</p>
<p>This means you are responsible for governing yourself respectfully and protecting your own boundaries. If another user is harassing you or behaving abusively, especially in private, capture screenshots and <b>report them to an admin</b>. We can act on evidence; we cannot read what we never saw.</p>';
