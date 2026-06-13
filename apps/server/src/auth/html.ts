import sanitizeHtml from "sanitize-html";

/**
 * What we let writers paste into a bio / world page / admin HTML block.
 *
 * Posture: profiles are mini-webpages. Allow EVERYTHING except a small
 * deny list of tags that either execute code, load arbitrary external
 * content, or create phishing surfaces. Allow all attributes except
 * event handlers (`on*`). Restrict URL schemes in href/src to
 * http/https/mailto. Scrub `url(javascript:|data:|vbscript:)` and
 * `expression(...)` from inline style values.
 *
 * Specifically blocked:
 *   - `<script>`, `<noscript>`, XSS / inline execution.
 *   - `<object>`, `<embed>`, `<applet>`, plugin loaders, mostly
 *     deprecated, no good reason to allow.
 *   - `<base>`, `<link>`, `<meta>`, `<title>`, `<head>`, `<body>`,
 *     `<html>`, document-level tags that would mutate the entire
 *     page (a `<base>` injection could rewrite every relative URL).
 *   - `<frame>`, `<frameset>`, deprecated framesets.
 *   - `<form>`, `<input>`, `<button>`, `<select>`, `<textarea>`,
 *     `<option>`, `<optgroup>`, `<fieldset>`, `<legend>`,
 *     `<datalist>`, `<output>`, phishing surface (fake credential
 *     prompts). Allow on request once we have a use case.
 *
 * Specifically ALLOWED (despite occasional concerns):
 *   - `<iframe>`, CSP `frame-src` restricts which origins can load,
 *     so an iframe pointing at an unlisted origin just shows a blank
 *     box. Useful for embeds.
 *   - `<style>`, server preserves contents VERBATIM (storage
 *     policy). Client renders scope each selector with
 *     `.user-html-scope` via `scopeAndNonceStyleBlocks` and stamps
 *     the per-request CSP nonce so the inline stylesheet is
 *     actually applied.
 *   - SVG / MathML, XSS-relevant tags inside these (script, on*)
 *     are removed by the same passes that handle HTML.
 *
 * Storage policy: we store the writer's HTML close to verbatim.
 * Server-side scrubbing handles deny-list tags, event handlers, and
 * dangerous CSS values. Selector scoping + CSP nonce stamping happens
 * at RENDER time on the client, see `apps/web/src/lib/cssScope.ts`.
 */
const DENIED_TAGS = new Set([
  "script", "noscript",
  "object", "embed", "applet",
  "base", "link", "meta", "title", "head", "body", "html",
  "frame", "frameset",
  "form", "input", "button", "select", "textarea",
  "option", "optgroup", "fieldset", "legend", "datalist", "output",
]);

/**
 * Marker attribute the auto-paragraph pass stamps onto every `<br>` it
 * emits. The save-side strip + the read-side reverse both gate on it
 * so a `<br>` typed by hand (no marker) sails through every round-trip
 * untouched, the bug this fixes was that the previous shape-based
 * strip ("any `<br>` followed by `\n`") couldn't tell user-typed BRs
 * apart from auto-emitted ones and ate the writer's manual breaks on
 * save.
 *
 * The marker is just `<br data-auto-br>` (empty value, present-or-
 * absent semantics). Browsers ignore unknown data-* attributes, so
 * the marker is invisible at render time.
 */
const AUTO_BR = '<br data-auto-br>';
/** Match an auto-emitted BR regardless of how sanitize-html normalized
 *  the tag shape (`<br data-auto-br>`, `<br data-auto-br />`, with or
 *  without quoted value). Case-insensitive. */
const AUTO_BR_RE = /<br\b[^>]*\bdata-auto-br\b[^>]*>/i;

/**
 * Pre-pass: convert PARAGRAPH-break newlines to `<br>` for inputs that
 * look like plain text. Only runs of 2+ newlines emit `<br>`s, one
 * per newline in the run, so hitting Enter once is invisible
 * (HTML collapses the lone newline to whitespace) and hitting Enter
 * twice gives one blank line. Each `<br>` is a single line break in
 * HTML; two stacked `<br>`s render as the blank line a writer who
 * pressed Enter twice expects to see. The earlier rule emitted
 * `run.length - 1` BRs, which gave a single line break for a double-
 * Enter input, visually identical to a single Enter, so the writer's
 * paragraph break disappeared on display.
 *
 * Skipped entirely when the input carries paragraph-level wrappers
 * (`<p>`, `<div>`, `<blockquote>`, `<pre>`), those already define their
 * own vertical rhythm. Inline tags (`<br>`, `<b>`, `<i>`), lists, and
 * headings do NOT count as paragraph structure: a writer who typed
 * `<h3>Title</h3>` followed by two newlines of prose still expects the
 * paragraph rule to fire.
 *
 * IDEMPOTENT, and surgical about it. The strip phase only touches
 * `<br>` tags carrying the `data-auto-br` marker, so a `<br>` the
 * writer typed (even at end-of-line, the shape that previously looked
 * indistinguishable from our auto-emit) survives the round-trip
 * untouched.
 *
 * `<style>` blocks are pulled to placeholders first so CSS contents
 * (which have legitimate `\n\n` between rules) don't get BR-padded.
 */
function nlToBrForPlainText(input: string): string {
  const styleBlocks: string[] = [];
  const STYLE_TOKEN = " STYLE_BLOCK_TOKEN ";
  const bodyOnly = input.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => {
    styleBlocks.push(m);
    return STYLE_TOKEN;
  });
  const hasParagraphStructure = /<(?:p|div|blockquote|pre)\b/i.test(bodyOnly);
  if (hasParagraphStructure) {
    return restoreStyles(bodyOnly, styleBlocks, STYLE_TOKEN);
  }
  let s = bodyOnly.replace(/\r\n?/g, "\n");
  // Strip ONLY the auto-emitted BRs that ride directly before a "\n"
  // (or end-of-input). The marker attribute is what distinguishes them
  // from a `<br>` the user typed. `[ \t]*` (not `\s*`) between BRs so
  // we don't accidentally span across a separate paragraph break.
  s = s.replace(
    new RegExp(
      `(?:${AUTO_BR_RE.source}[ \\t]*)+(?=\\n|$)`,
      "gi",
    ),
    "",
  );
  s = s.replace(/\n{2,}/g, (run) => AUTO_BR.repeat(run.length) + "\n");
  return restoreStyles(s, styleBlocks, STYLE_TOKEN);
}

function restoreStyles(body: string, blocks: string[], token: string): string {
  if (blocks.length === 0) return body;
  let out = body;
  for (const block of blocks) {
    out = out.replace(token, block);
  }
  return out;
}

/**
 * Reverse of {@link nlToBrForPlainText} for the bio editor: undo the
 * marked `<br>`-padded paragraph breaks the save pass produced so the
 * textarea shows clean source text instead of literal `<br>` strings.
 * Each run of N marked `<br>` tags immediately before a `\n` (or at
 * end of input) expands back to N+1 source newlines, mirroring the
 * save rule exactly.
 *
 * Only marked BRs are reversed. A `<br>` the writer typed by hand (no
 * `data-auto-br` attribute) stays in the editor textarea exactly as
 * they wrote it.
 *
 * Paragraph-structured bios (with `<p>` / `<div>` / `<blockquote>` /
 * `<pre>`) skip the transform, those were never touched on save, so
 * there's nothing to undo.
 *
 * Used by the owner-only GET paths that feed the editor; viewer-facing
 * read paths still see the persisted HTML with breaks intact.
 */
export function bioHtmlForEdit(html: string): string {
  if (!html) return html;
  const hasParagraphStructure = /<(?:p|div|blockquote|pre)\b/i.test(html);
  if (hasParagraphStructure) return html;
  const normalized = html.replace(/\r\n?/g, "\n");
  return normalized.replace(
    new RegExp(
      `((?:${AUTO_BR_RE.source}[ \\t]*)+)(\\n|$)`,
      "gi",
    ),
    (_m, brs: string) => {
      const count = (brs.match(/<br/gi) ?? []).length;
      return "\n".repeat(count);
    },
  );
}

/**
 * Strip dangerous URL schemes and `expression()` calls from an inline
 * `style="..."` attribute value. We accept everything else verbatim,
 * the user picks their own positioning / sizing / animations / etc.,
 * matching the "profile is a mini-webpage" posture. The structural
 * break-out chars `<>{}` are also blocked from appearing literally so
 * a value can't end the style attribute and inject more markup.
 *
 * `;` is intentionally NOT scrubbed at this layer, sanitize-html
 * splits the style attribute into per-property entries before calling
 * us, so a `;` in a single value is already a delimiter, not a
 * payload.
 */
function scrubStyleAttrValue(value: string): string {
  return value
    // url(...) with dangerous scheme. The inner-group regex handles
    // ONE level of nested parens (e.g. `url(javascript:alert(1))`) by
    // alternating `[^()]` (non-paren chars) with `\([^()]*\)` (a
    // balanced inner pair). A flat `[^)]*` would stop at the first
    // `)` and leave a stray `)` in the output.
    .replace(/url\s*\(((?:[^()]|\([^()]*\))*)\)/gi, (match, inner: string) => {
      const trimmed = inner.trim().replace(/^['"]/, "").replace(/['"]$/, "").trim().toLowerCase();
      if (trimmed.startsWith("javascript:") || trimmed.startsWith("data:") || trimmed.startsWith("vbscript:") || trimmed.startsWith("file:")) {
        return "url('')";
      }
      return match;
    })
    // CSS expression() (old IE inline script execution). Balanced-
    // paren matcher so `expression(alert(1))` is consumed whole
    // instead of leaving the outer `)` behind.
    .replace(/expression\s*\((?:[^()]|\([^()]*\))*\)/gi, "")
    // CSS behavior: (old IE)
    .replace(/behavior\s*:\s*[^;]+/gi, "")
    // -moz-binding (old Firefox XBL)
    .replace(/-moz-binding\s*:\s*[^;]+/gi, "")
    // Structural break-outs that could end the style attribute early
    .replace(/[<>{}]/g, "");
}

/**
 * Storage-layer scrub for `<style>` block contents. Same intent as
 * `scrubStyleAttrValue` (block external/inline scripts via CSS
 * urls + expression()), applied to the body of every `<style>` tag.
 * Selectors are NOT touched here, the writer's CSS is preserved
 * verbatim in the DB and the client scopes selectors at render time.
 */
function scrubStyleBlocks(html: string): string {
  if (!html.includes("<style")) return html;
  return html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, css: string) => {
    const safe = css
      // Same balanced-paren url() matcher as `scrubStyleAttrValue`.
      .replace(/url\s*\(((?:[^()]|\([^()]*\))*)\)/gi, (match, inner: string) => {
        const trimmed = inner.trim().replace(/^['"]/, "").replace(/['"]$/, "").trim().toLowerCase();
        if (trimmed.startsWith("javascript:") || trimmed.startsWith("data:") || trimmed.startsWith("vbscript:") || trimmed.startsWith("file:")) {
          return 'url("")';
        }
        return match;
      })
      // Same balanced-paren matcher as `scrubStyleAttrValue`.
      .replace(/expression\s*\((?:[^()]|\([^()]*\))*\)/gi, "");
    return `<style>${safe}</style>`;
  });
}

/**
 * Drop the attributes that DOMPurify / sanitize-html otherwise let
 * through under an allow-all (`allowedAttributes: false`) config:
 *   - event handlers (`on*`)
 *   - style attribute values: scrub dangerous CSS via
 *     `scrubStyleAttrValue`
 *
 * Returns a new attribs map; the original is left untouched (so
 * sanitize-html's downstream filters operate on the cleaned copy).
 */
function cleanAttribs(attribs: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(attribs)) {
    const lower = k.toLowerCase();
    if (lower.startsWith("on")) continue;
    if (lower === "style") {
      safe[k] = scrubStyleAttrValue(v);
      continue;
    }
    safe[k] = v;
  }
  return safe;
}

/**
 * Strip document-structure WRAPPERS (`<html>` / `<head>` / `<body>`) while
 * keeping their children. A bio is a document fragment, so these tags are
 * denied — but the sanitizer's `exclusiveFilter` discards a denied tag's
 * CHILDREN along with it, which silently wipes an entire bio when an editor
 * wraps its export in `<body>…</body>` (GrapesJS's `getHtml()` does exactly
 * this). Unwrapping here keeps the content; any genuinely unsafe head children
 * (`meta`/`link`/`base`/`title`) are still individually denied below.
 */
function stripDocumentWrappers(html: string): string {
  return html.replace(/<\/?(?:html|head|body)(?:\s[^>]*)?>/gi, "");
}

/** Sanitize a profile/bio HTML body. Used on save AND on read. */
export function sanitizeBio(html: string): string {
  return sanitizeHtml(scrubStyleBlocks(nlToBrForPlainText(stripDocumentWrappers(html))), {
    // Allow EVERY tag, the deny list runs via `exclusiveFilter`
    // below. Posture: profiles are mini-webpages; the writer gets
    // structural HTML freedom (semantic tags, layout containers,
    // tables, lists, deprecated-but-common presentational tags like
    // `<center>` and `<font>`, plus `<style>` for stylesheets).
    allowedTags: false,
    // Allow EVERY attribute. The `transformTags` wildcard below strips
    // event handlers (`on*`) and scrubs `style` attribute values. URL
    // schemes for href/src are restricted by `allowedSchemes` /
    // `allowedSchemesByTag` below, sanitize-html applies those
    // independent of `allowedAttributes`.
    allowedAttributes: false,
    // URL scheme restriction. `javascript:` and `data:` URLs are
    // dropped from href/src attributes (user's explicit ask).
    // `mailto:` allowed so writers can drop a contact address.
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    // Drop the *content* of these tags when sanitize-html removes
    // them. Without this, a stripped `<script>` would leave its
    // body as visible text in the bio.
    nonTextTags: ["script", "noscript", "iframe-disabled-content", "style", "textarea"],
    // Per-tag deny list. Returns true → tag (and its content, per
    // nonTextTags) is dropped. Everything not in the deny list is
    // kept.
    exclusiveFilter: (frame) => DENIED_TAGS.has(frame.tag.toLowerCase()),
    transformTags: {
      // Strip event handlers + scrub style values on EVERY tag.
      // sanitize-html doesn't auto-strip on* attrs when
      // `allowedAttributes: false`, so this wildcard does it.
      "*": (tagName, attribs) => ({ tagName, attribs: cleanAttribs(attribs) }),
      // <a> tags: same cleaning, plus the standard outbound-link
      // safety (rel=noopener+noreferrer+ugc, target=_blank).
      a: (tagName, attribs) => ({
        tagName: "a",
        attribs: {
          ...cleanAttribs(attribs),
          rel: "noopener noreferrer ugc",
          target: "_blank",
        },
      }),
    },
    disallowedTagsMode: "discard",
    // Silence the stderr warning about `<style>` in the allow set,
    // we're knowingly allowing it; client-side render-time scoping +
    // CSP nonce stamping handle the XSS surface (see
    // `apps/web/src/lib/cssScope.ts`).
    allowVulnerableTags: true,
  });
}

/**
 * Strip `<aside class="margin-note">…</aside>` blocks from a Scriptorium
 * chapter body. Margin notes are collaborator-side drafting comments
 * (per the Phase 5 spec) that MUST NOT survive publish, readers never
 * see them, and unpublishing a chapter doesn't restore them.
 *
 * Matches any `<aside>` whose class attribute contains `margin-note`
 * as a whitespace-separated token. Case-insensitive. The strip is
 * non-nesting: an `<aside class="margin-note">` containing another
 * `<aside>` would close at the OUTER tag's first `</aside>` which is
 * a reasonable trade, the editor doesn't nest notes in practice.
 *
 * Pure string transform; no DOM parser needed server-side.
 */
export function stripMarginNotes(html: string): string {
  if (!html || !/<aside\b/i.test(html)) return html;
  return html.replace(
    /<aside\b[^>]*\bclass\s*=\s*(?:"[^"]*\bmargin-note\b[^"]*"|'[^']*\bmargin-note\b[^']*')[^>]*>[\s\S]*?<\/aside>/gi,
    "",
  );
}
