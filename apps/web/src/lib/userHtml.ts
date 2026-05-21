/**
 * Client-side sanitizer + render-time CSS scoper for user-authored
 * HTML (profile bios, world pages, character journal, etc.). All of
 * these are also sanitized server-side via `sanitizeBio` in
 * apps/server — this pass is defense-in-depth, run before injecting
 * into the DOM via `dangerouslySetInnerHTML`.
 *
 * Two transforms happen here:
 *
 *   1. `DOMPurify.sanitize` with `<style>` added to the allow-list.
 *      DOMPurify's default profile strips `<style>` entirely; without
 *      ADD_TAGS the writer's custom CSS would silently disappear.
 *
 *   2. `scopeAndNonceStyleBlocks` (from `./cssScope`) prefixes every
 *      selector inside each `<style>` block with `.user-html-scope`
 *      AND stamps the per-request CSP nonce on the `<style>` tag.
 *      The scope keeps user CSS from escaping the bio container; the
 *      nonce keeps the browser from rejecting the inline stylesheet
 *      under our strict `style-src 'self' 'nonce-{N}'` policy.
 *
 * The DB stores user CSS VERBATIM (unscoped, no nonce). Scoping and
 * nonce-stamping happen here at render. That keeps the editor
 * textarea showing the writer's original CSS and prevents the
 * `.user-html-scope` prefix from compounding on re-saves.
 *
 * What stays denied (DOMPurify defaults):
 *   - `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`,
 *     `<input>`, event-handler attributes (`onClick`, `onLoad`).
 *   - `javascript:` / `data:` URLs in href/src.
 *
 * Pair every consumer with the `user-html-scope` class on the
 * wrapping element so the selector prefix has something to bind to.
 */
import DOMPurify from "dompurify";
import { scopeAndNonceStyleBlocks } from "./cssScope.js";

/**
 * CSS class every user-HTML render site wraps its container in. The
 * client-side `<style>` scope pass prefixes every selector with this
 * (as a class selector — `.user-html-scope ${original}`) so user CSS
 * rules can only match descendants of the wrapper. Keep in sync with
 * the value passed to `scopeAndNonceStyleBlocks` in this file.
 */
export const USER_HTML_SCOPE_CLASS = "user-html-scope";

export function sanitizeUserHtml(html: string): string {
  const purified = DOMPurify.sanitize(html, {
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
    // FORCE_BODY tells DOMPurify to wrap the input in <body>, so the
    // HTML parser keeps a top-level `<style>` block as a body child
    // instead of relocating it to <head> (the spec-default placement
    // for `<style>` in a fragment). DOMPurify strips head content
    // after parsing, which is what was silently eating user CSS.
    FORCE_BODY: true,
  });
  return scopeAndNonceStyleBlocks(purified, `.${USER_HTML_SCOPE_CLASS}`);
}
