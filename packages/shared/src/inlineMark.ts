/**
 * Verification markers for server-expanded inline commands.
 *
 * Real inline-command expansions are wrapped in these sentinels by
 * `expandInlineCommands` so the client renderer can show a checkmark
 * tooltip indicating the span is authentic command output, not a user
 * typing "( rolls 🎲 1d20: 20 )" verbatim into chat to fake a roll.
 *
 * The character choice:
 *   - U+2063 INVISIBLE SEPARATOR opens and closes each tag. Zero-width,
 *     not produced by ordinary input, and stripped by terminal clients
 *     that don't understand it (no visible artifact for non-supporting
 *     viewers).
 *   - U+27E6 / U+27E7 MATHEMATICAL WHITE SQUARE BRACKETS bracket the
 *     "cmd:NAME" / "/cmd" payload. Uncommon enough to make a collision
 *     with user-typed text basically a non-issue, while still being
 *     easy to spot in raw payloads when debugging.
 *
 * Optional CSS payload: when the underlying command has a sanitized
 * CSS declaration list, it's URI-encoded and stitched into the start
 * marker after a `|` separator — `⁣⟦cmd:NAME|encoded%20css⟧⁣`. The
 * renderer decodes it and applies the resulting style to the verified
 * span so an inline `!cmd` call inherits the same look as its
 * standalone `/cmd` form (e.g. an admin-marked italic+red command
 * stays italic+red when spliced mid-sentence). When no CSS is
 * attached, the bare `⁣⟦cmd:NAME⟧⁣` form is emitted to keep
 * payloads compact.
 *
 * URI-encoding the CSS guarantees the separator (`|`) and the closing
 * bracket (`⟧`) can't appear inside the payload — that's what lets
 * the regex below stay non-greedy without ambiguity.
 *
 * Strip-before-expand is load-bearing for the security claim: the
 * server runs {@link stripVerificationMarkers} over the user-typed
 * body BEFORE any expansion runs, so the only way these tokens reach a
 * recipient is via a real expansion the server just produced. A user
 * who pastes the literal characters into chat has them removed before
 * the renderer ever sees them.
 */
export const VMARK_START_PREFIX = "⁣⟦cmd:";
export const VMARK_START_SUFFIX = "⟧⁣";
export const VMARK_END = "⁣⟦/cmd⟧⁣";

/** Pattern that matches BOTH the start and end tags (with or without a CSS
 *  payload after the name). Used to scrub user input. */
export const VMARK_ANY_RE =
  /⁣⟦\/?cmd(?::[A-Za-z0-9_-]{1,32}(?:\|[^⟧]*)?)?⟧⁣/g;

/** Pattern that captures a complete verified span: start + name + (optional
 *  URI-encoded css) + content + end. */
export const VMARK_SPAN_RE =
  /⁣⟦cmd:(?<name>[A-Za-z0-9_-]{1,32})(?:\|(?<css>[^⟧]*))?⟧⁣(?<content>[\s\S]*?)⁣⟦\/cmd⟧⁣/g;

/**
 * Wrap a single expansion in verification markers. `name` is sanitized
 * to the command-name alphabet so an unexpected character never ends
 * up inside the marker (defense in depth — the server only feeds
 * command names here, but the regex above expects this shape).
 *
 * `css` is the sanitized CSS declaration list to apply to the rendered
 * span, or null/undefined to emit a bare marker. Caller is responsible
 * for having already run the input through `sanitizeCustomCmdCss`;
 * this helper does NOT re-validate.
 */
export function markVerified(name: string, content: string, css?: string | null): string {
  const safeName = name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "cmd";
  const cssPart = css && css.trim() ? `|${encodeURIComponent(css.trim())}` : "";
  return `${VMARK_START_PREFIX}${safeName}${cssPart}${VMARK_START_SUFFIX}${content}${VMARK_END}`;
}

/**
 * Remove every verification marker (start or end) from `body`. Idempotent;
 * runs on user input BEFORE `expandInlineCommands` to make sure a user
 * can't smuggle in a fake `⁣⟦cmd:roll⟧…⁣⟦/cmd⟧` and have it
 * read as authentic. The expansion pass then re-introduces clean markers
 * around its own output.
 */
export function stripVerificationMarkers(body: string): string {
  return body.replace(VMARK_ANY_RE, "");
}
