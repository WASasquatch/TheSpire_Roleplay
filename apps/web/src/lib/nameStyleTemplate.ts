/**
 * Name-style template placeholder substitution.
 *
 * Templates are admin-authored HTML strings that wrap a user's display
 * name in custom markup. The placeholder vocabulary is:
 *
 *   {username}       — the display name as a plain text run, HTML-escaped.
 *                      Works in any context that accepts text.
 *
 *   {username-span}  — the display name split into one `<span>` per
 *                      character, each with a `data-i="N"` attribute
 *                      pointing at its zero-based position. Lets a
 *                      template's CSS target individual characters via
 *                      attribute selectors or `:nth-child(N)` for
 *                      animations, alternating colors, per-letter
 *                      transforms, and so on.
 *
 * Example template using both:
 *
 *   <span class="ns-rainbow">{username-span}</span>
 *
 *   .ns-rainbow span[data-i="0"] { color: red; }
 *   .ns-rainbow span:nth-child(odd) { animation: bob 1.2s infinite; }
 *
 * Both placeholders escape their character payload before insertion so
 * a username containing `<`, `&`, or `"` can't break out of the
 * surrounding HTML. The DOMPurify pass downstream of this helper
 * provides the second line of defense (and strips any disallowed tags
 * the admin template itself contains).
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the per-character markup that `{username-span}` expands to.
 *
 * Uses `Array.from()` for splitting so UTF-16 surrogate pairs (most
 * emoji, supplementary-plane scripts) survive as one unit rather than
 * getting torn in half. ZWJ-combined sequences (multi-codepoint
 * grapheme clusters) will still split into their component code
 * points — acceptable for the typical username case, and avoiding
 * the heavier `Intl.Segmenter` keeps this hot in chat rendering.
 */
export function buildUsernameSpan(displayName: string): string {
  return Array.from(displayName)
    .map((ch, i) => `<span data-i="${i}">${escapeHtml(ch)}</span>`)
    .join("");
}

/**
 * Apply every placeholder substitution defined above to `template` and
 * return the merged HTML string. The caller is responsible for the
 * subsequent DOMPurify sanitization pass.
 *
 * Order matters: `{username-span}` is replaced first so its expansion
 * (which contains literal substrings like `data-i="0"`) cannot be
 * misread as a partial `{username}` match. In practice neither
 * placeholder is a substring of the other, but the explicit ordering
 * keeps the substitution future-proof against new placeholders.
 */
export function applyNameStylePlaceholders(template: string, displayName: string): string {
  const escaped = escapeHtml(displayName);
  const spanned = buildUsernameSpan(displayName);
  return template
    .replace(/\{username-span\}/g, spanned)
    .replace(/\{username\}/g, escaped);
}
