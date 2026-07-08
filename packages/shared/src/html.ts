/**
 * Shared HTML-escaping helpers.
 *
 * A single `&`-first core covers every escaper variant that used to live
 * as a private copy across the server + web + template-generation modules.
 * Escaping `&` before the others is what avoids double-escaping the
 * entities introduced by later replacements; the order among `<`, `>`,
 * `"`, `'` is irrelevant to the output because none of those characters
 * appear in another replacement's output, so a fixed canonical order
 * reproduces every prior copy byte-for-byte regardless of the order that
 * copy happened to use.
 *
 * Variants (each maps to a former inline copy, output-identical):
 *  - `escapeHtml(s)` .......................... `& < >`      (text nodes)
 *  - `escapeHtml(s, { doubleQuote: true })` ... `& < > "`    (text + dbl-quoted attr)
 *  - `escapeHtmlAttr(s)` ...................... `& < > " '`  (any attribute value)
 *  - `{ collapseWhitespace: true }` ........... collapse `\s+`→" " BEFORE escaping
 */
export interface EscapeHtmlOptions {
  /** Also escape `"` → `&quot;` (safe inside a double-quoted attribute). */
  doubleQuote?: boolean;
  /** Also escape `'` → `&#39;` (safe inside a single-quoted attribute). */
  singleQuote?: boolean;
  /**
   * Collapse runs of whitespace to a single space *before* escaping.
   * Used for single-line contexts like `<meta>` tags where a multi-line
   * value would silently truncate in some crawlers.
   */
  collapseWhitespace?: boolean;
}

/**
 * Escape a string for HTML. By default escapes only `&`, `<`, `>` (safe
 * for text-node context). Opt into quote escaping via options to make the
 * value safe inside quoted attribute values.
 */
export function escapeHtml(s: string, opts?: EscapeHtmlOptions): string {
  let out = opts?.collapseWhitespace ? s.replace(/\s+/g, " ") : s;
  out = out
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (opts?.doubleQuote) out = out.replace(/"/g, "&quot;");
  if (opts?.singleQuote) out = out.replace(/'/g, "&#39;");
  return out;
}

/**
 * Escape a string for use in any HTML attribute value: the full set
 * `& < > " '`. Equivalent to `escapeHtml(s, { doubleQuote: true,
 * singleQuote: true })`.
 */
export function escapeHtmlAttr(s: string): string {
  return escapeHtml(s, { doubleQuote: true, singleQuote: true });
}
