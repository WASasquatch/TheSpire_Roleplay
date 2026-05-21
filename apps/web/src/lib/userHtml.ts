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
import { parseVideoEmbed } from "./markdown.js";

/**
 * Custom `<youtube>https://youtu.be/ID</youtube>` shortcut tag. Replaced
 * with a sandboxed iframe pointed at `youtube-nocookie.com/embed/ID`
 * BEFORE DOMPurify runs, so the writer doesn't have to paste raw
 * iframe markup. URL is parsed via the same `parseVideoEmbed` chat /
 * markdown uses, so any YouTube URL shape (watch, short, shorts, embed)
 * is accepted; vimeo URLs are rejected — those would belong to a
 * separate `<vimeo>` tag if we add one later.
 *
 * Inner text is the only thing read — attributes on the `<youtube>` tag
 * are ignored. Invalid URLs (typos, non-YouTube hosts) drop the tag
 * entirely rather than render a broken embed.
 *
 * The output iframe is wrapped in `<div class="user-yt-embed">` which
 * styles.css sizes to 100% width on mobile and 50% on large viewports
 * (16:9 aspect-ratio so the iframe stays the right shape at every size).
 */
function transformYoutubeTags(html: string): string {
  if (!html.toLowerCase().includes("<youtube")) return html;
  return html.replace(/<youtube\b[^>]*>([\s\S]*?)<\/youtube>/gi, (_match, body: string) => {
    const url = body.trim();
    if (!url) return "";
    const embed = parseVideoEmbed(url);
    if (!embed || embed.provider !== "youtube") return "";
    return `<div class="user-yt-embed"><iframe src="${embed.src}" frameborder="0" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin" title="YouTube video"></iframe></div>`;
  });
}

/**
 * CSS class every user-HTML render site wraps its container in. The
 * client-side `<style>` scope pass prefixes every selector with this
 * (as a class selector — `.user-html-scope ${original}`) so user CSS
 * rules can only match descendants of the wrapper. Keep in sync with
 * the value passed to `scopeAndNonceStyleBlocks` in this file.
 */
export const USER_HTML_SCOPE_CLASS = "user-html-scope";

export function sanitizeUserHtml(html: string): string {
  const purified = DOMPurify.sanitize(transformYoutubeTags(html), {
    // `iframe` is in ADD_TAGS so the `<youtube>` → iframe transform
    // above survives. Arbitrary iframes are still gated by the strict
    // CSP `frame-src` allowlist (`youtube-nocookie.com`, `vimeo.com`,
    // self) — a pasted `<iframe src="http://evil">` parses fine but
    // the browser refuses to load it, so the surface is the URL set
    // CSP already trusts.
    ADD_TAGS: ["style", "iframe"],
    ADD_ATTR: ["allowfullscreen", "allow", "frameborder", "referrerpolicy", "loading"],
    FORBID_TAGS: ["script", "object", "embed", "form", "input"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
    FORCE_BODY: true,
  });
  return scopeAndNonceStyleBlocks(purified, `.${USER_HTML_SCOPE_CLASS}`);
}
