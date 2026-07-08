/**
 * Render-time CSS scoping for user-authored `<style>` blocks.
 *
 * The DB stores user CSS verbatim, `.userlist { … }` is preserved
 * exactly as the writer typed it. At render time, we transform every
 * selector inside each `<style>` block to be prefixed with a wrapper
 * class (`.user-html-scope`) so the rules can only ever match
 * descendants of the host container. `.userlist { … }` becomes
 * `.user-html-scope .userlist { … }` for the duration of the render;
 * the stored CSS is unchanged.
 *
 * Why render-time, not save-time:
 *   - The editor textarea shows the writer's original CSS. No surprise
 *     `.user-html-scope` prefix in their source.
 *   - Re-saves don't compound prefixes. Each save → DB stores
 *     unchanged; each render → scope applied once.
 *   - Different containers can use different scope classes if a future
 *     surface needs that (e.g. a forum post's `.forum-html-scope`).
 *
 * Idempotency: selectors that ALREADY start with the scope class get
 * left alone. Protects against bios stored by a previous version of
 * the sanitizer that scoped at save time, re-rendering them through
 * this pass doesn't double up.
 */

import { scrubCssUrlSchemes } from "@thekeep/shared";

import { CSP_NONCE } from "./cspNonce.js";

/**
 * Marker attribute stamped on every user-bio `<style>` block by
 * {@link scopeAndNonceStyleBlocks}. Lets the host modal sweep for
 * orphaned bio styles on unmount as a belt-and-suspenders cleanup
 * (React's portal teardown should remove them automatically, but a
 * report of "the profile's custom CSS leaked into the login modal
 * after closing the public profile view" pinned down a path where a
 * leftover block was still parsed against the new tree). Anyone
 * rendering scoped user HTML that wants the same cleanup just queries
 * the document for `style[${USER_HTML_STYLE_MARKER}]` and removes
 * them when their owning surface unmounts.
 */
export const USER_HTML_STYLE_MARKER = "data-tk-user-bio-style";

/**
 * Scope every `<style>` block inside `html` to `scopeClass`, and stamp
 * the current request's CSP nonce on each so the browser doesn't
 * reject the inline stylesheet under our strict `style-src` policy.
 *
 * `scopeClass` should be a class selector (e.g. `.user-html-scope`).
 * `html` is the sanitized user HTML, we run AFTER the main HTML
 * sanitizer so this pass only has to think about CSS, not nested
 * tag-allow-list concerns.
 */
export function scopeAndNonceStyleBlocks(html: string, scopeClass: string): string {
  if (!html.includes("<style")) return html;
  const nonce = CSP_NONCE;
  return html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attrs: string, cssRaw: string) => {
    const scoped = scopeCss(scrubCssUrlSchemes(cssRaw), scopeClass);
    // Stamp the nonce on the tag itself. Strict CSP (`style-src 'self'
    // 'nonce-{N}'`) rejects inline `<style>` blocks that don't carry
    // the request nonce. Server-rendered styles get the nonce stamped
    // by the SEO renderer; user-bio `<style>` tags inserted via
    // `dangerouslySetInnerHTML` need it stamped here at the same
    // render step. Without this stamp, the browser silently drops the
    // block and the writer's CSS never applies, exactly the
    // "custom CSS doesn't work" symptom.
    const safeAttrs = attrs.replace(/\bnonce\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, "")
      // Defense against an upstream block that pre-stamped the marker:
      // we want exactly ONE marker attribute on the tag.
      .replace(new RegExp(`\\s*${USER_HTML_STYLE_MARKER}\\s*=\\s*("[^"]*"|'[^']*'|\\S+)`, "gi"), "")
      .trim();
    const nonceAttr = nonce ? ` nonce="${escapeAttr(nonce)}"` : "";
    return `<style${safeAttrs ? ` ${safeAttrs}` : ""}${nonceAttr} ${USER_HTML_STYLE_MARKER}="1">${scoped}</style>`;
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Walk a CSS string, prefix every selector with `scope`, recurse into
 * `@media` / `@supports` / `@container` / `@layer` block bodies, and
 * strip `@import` / `@charset` / `@namespace` (external-load
 * directives we don't want).
 *
 * Idempotent: selectors that already start with `scope` (a
 * legitimately self-prefixed user selector or, more commonly, a
 * leftover from an older sanitizer that scoped at save time) pass
 * through without a second prefix.
 */
function scopeCss(css: string, scope: string): string {
  const src = stripCssComments(css);
  let i = 0;
  let out = "";
  while (i < src.length) {
    if (/\s/.test(src[i]!)) {
      out += src[i++]!;
      continue;
    }
    if (src[i] === "@") {
      let j = i;
      let depth = 0;
      while (j < src.length) {
        const c = src[j]!;
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (depth === 0 && (c === "{" || c === ";")) break;
        j++;
      }
      const prelude = src.slice(i, j);
      const lower = prelude.toLowerCase().trimStart();
      if (src[j] === ";") {
        // Single-line at-rule. Strip `@import`/`@charset`/`@namespace`
        //, they all carry external-load semantics. Other top-level
        // at-rules (rare; `@layer name;` declarations etc.) pass.
        const drop = /^@(?:import|charset|namespace)\b/.test(lower);
        if (!drop) out += `${prelude};`;
        i = j + 1;
        continue;
      }
      if (src[j] === "{") {
        const bodyStart = j + 1;
        const bodyEnd = matchingBrace(src, j);
        if (bodyEnd === -1) {
          out += src.slice(i);
          return out;
        }
        const body = src.slice(bodyStart, bodyEnd);
        const wraps = /^@(?:media|supports|container|layer|document)\b/.test(lower);
        if (wraps) {
          out += `${prelude}{${scopeCss(body, scope)}}`;
        } else {
          // @keyframes / @font-face / @page / @property, inner
          // selectors aren't DOM selectors, leave the body alone.
          out += `${prelude}{${body}}`;
        }
        i = bodyEnd + 1;
        continue;
      }
      out += src.slice(i);
      return out;
    }
    if (src[i] === "}") {
      out += src[i++]!;
      continue;
    }
    let j = i;
    let depth = 0;
    while (j < src.length) {
      const c = src[j]!;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (depth === 0 && c === "{") break;
      j++;
    }
    if (j >= src.length) return out;
    const selectorList = src.slice(i, j).trim();
    const bodyStart = j + 1;
    const bodyEnd = matchingBrace(src, j);
    if (bodyEnd === -1) {
      out += src.slice(i);
      return out;
    }
    const body = src.slice(bodyStart, bodyEnd);
    const scopedSelectors = selectorList
      .split(",")
      .map((sel) => {
        const trimmed = sel.trim();
        // Idempotent: an already-scoped selector (matches `scope ` at
        // the start) passes through. Tolerates extra whitespace.
        if (trimmed === scope || trimmed.startsWith(`${scope} `)) return trimmed;
        return `${scope} ${trimmed}`;
      })
      .join(", ");
    out += `${scopedSelectors}{${body}}`;
    i = bodyEnd + 1;
  }
  return out;
}

function matchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
