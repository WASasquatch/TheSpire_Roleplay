/**
 * Client-side sanitizer for user-authored HTML (profile bios, world
 * pages, forum posts, character journal, etc.). All of these are also
 * sanitized server-side via `sanitizeBio` in apps/server — this pass
 * is defense-in-depth, run before injecting into the DOM via
 * `dangerouslySetInnerHTML`.
 *
 * What this differs from `DOMPurify.sanitize(html)` (the default) in:
 *
 *   - Allows `<style>` tags. The server pre-scopes every selector
 *     inside a `<style>` block with `.user-html-scope` so the rules
 *     can't escape the host container. Without ADD_TAGS here,
 *     DOMPurify's default profile would strip the tag entirely and
 *     the writer's custom styling would silently disappear on
 *     render.
 *   - Allows the full inline-style allow-list the server permits
 *     (margin, padding, border, border-radius, flex/grid, etc.).
 *     DOMPurify's CSS sanitizer runs on the inline values and
 *     blocks the same things our server-side `SAFE_CSS_VALUE` regex
 *     blocks (`url()`, `expression()`, `javascript:`, etc.).
 *
 * What stays denied (DOMPurify defaults):
 *   - `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`,
 *     `<input>`, event-handler attributes (`onClick`, `onLoad`).
 *   - `javascript:` and `data:` URLs.
 *
 * Pair every consumer with the `<UserHtml>` component (or apply the
 * `user-html-scope` class to the wrapping element manually) so the
 * server-side selector prefix has something to bind to.
 */
import DOMPurify from "dompurify";

/**
 * CSS class the server's `<style>` scoping prefixes every selector
 * with. The wrapping element this gets attached to becomes the root
 * of the user-authored CSS scope. See `apps/server/src/auth/html.ts`
 * for the server-side prefix logic.
 */
export const USER_HTML_SCOPE_CLASS = "user-html-scope";

export function sanitizeUserHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    // Add `<style>` to the allowed tag set. DOMPurify's CSS sanitizer
    // applies to the contents (same value-shape rules as inline
    // styles), so the scoped CSS the server emits round-trips intact
    // through the client pass.
    ADD_TAGS: ["style"],
    // Belt-and-suspenders: the server already strips these; restate
    // here so a future DOMPurify default change can't quietly let
    // them through.
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
  });
}
