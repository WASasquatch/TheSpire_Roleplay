/**
 * Copy-handler that flattens any chat-shaped selection (chat feed,
 * DM thread, forum posts) to plain text on the clipboard.
 *
 * Without this, the browser writes BOTH `text/plain` AND `text/html`
 * to the clipboard. Pasting into a rich-text target (Word, Discord,
 * an HTML email composer) then drags along every span class, inline
 * style, name-style CSS, link decoration, color, etc. — so a
 * pasted line looks like the chat's render rather than the prose
 * the user actually meant to quote. Writing ONLY `text/plain`
 * forces every rich-text paste surface to fall back to the bare
 * text representation.
 *
 * Avatars are excluded upstream via `user-select: none` on the
 * BorderedAvatar wrapper that mounts inline alongside the
 * displayName — without that, the image's `alt` text (often the
 * username) folds into `selection.toString()` and you'd get the
 * sender's name twice on every paste.
 *
 * Selection structure (block-level newlines between messages,
 * intra-line spacing inside a message) is preserved because
 * `selection.toString()` already serializes those correctly per
 * the standard.
 */
export function handlePlainTextCopy(e: React.ClipboardEvent<HTMLElement>): void {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString();
  if (!text) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", text);
}
