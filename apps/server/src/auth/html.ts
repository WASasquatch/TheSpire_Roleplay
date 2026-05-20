import sanitizeHtml from "sanitize-html";

/**
 * What we let writers paste into a bio / world page / admin HTML block.
 *
 * Posture: "let users style their own surface freely, deny anything
 * that could reach OUTSIDE the surface." The allow-list is broad; the
 * deny side is two-pronged:
 *
 *   1. Tag/attribute allow-list rejects everything not listed —
 *      `<script>`, `<iframe>`, `<form>`, `<input>`, `<object>`,
 *      `<embed>`, `<link>`, `<meta>` never round-trip. Event-handler
 *      attributes (onClick, onLoad, etc.) are stripped by
 *      sanitize-html's defaults regardless of what's in
 *      `allowedAttributes`.
 *   2. Schemes for href/src are restricted to http/https/mailto —
 *      `javascript:` and `data:` schemes are blocked at the
 *      allowedSchemes layer.
 *
 * `<style>` IS allowed, but every selector gets prefixed with
 * `.user-html-scope` so the rules can only ever target descendants of
 * the host container. A user-authored bio rule like
 * `body { display: none }` becomes `.user-html-scope body { ... }` —
 * which matches nothing (there's no `<body>` inside the scope) — so
 * page chrome stays safe. See `scopeStyleBlocks` below.
 *
 * Inline styles use a value-shape regex (`SAFE_CSS_VALUE`) that
 * blocks `url(`, `javascript:`, `data:`, `expression(`, `@import`,
 * and the structural break-out chars `<>{};`. Layered on top of a
 * property allow-list that excludes positioning (`position`, `top`,
 * `left`, etc.), `z-index`, `transform`, `animation` — properties
 * which could otherwise be used to overlay site chrome (chat shell,
 * close button) when a profile modal is open.
 */
const ALLOWED_TAGS = [
  // Inline text
  "b", "i", "u", "em", "strong", "s", "mark", "small", "sub", "sup",
  "code", "kbd", "var", "samp", "abbr", "cite", "q",
  // Inline links / images / generic spans
  "a", "img", "span", "br",
  // Block structure
  "p", "div", "blockquote", "pre", "hr",
  "figure", "figcaption",
  // Headings — h1/h2 reserved for the chrome (site banner, modal titles)
  // so writer content tops out at h3 to avoid heading-rank collisions
  // with the surrounding UI hierarchy.
  "h3", "h4", "h5", "h6",
  // Lists
  "ul", "ol", "li",
  "dl", "dt", "dd",
  // Collapsible disclosure (good for spoilers / NSFW gating in bios)
  "details", "summary",
  // Tables — useful for stat blocks, schedules, contact info grids.
  // No <colgroup>/<col> deliberately; complicate styling without
  // adding expressive power most users will reach for.
  "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
  // Scoped stylesheet. Contents get auto-prefixed with
  // `.user-html-scope` before sanitization so selectors can only
  // match inside the host container. See `scopeStyleBlocks`.
  "style",
];

/**
 * Marker attribute the auto-paragraph pass stamps onto every `<br>` it
 * emits. The save-side strip + the read-side reverse both gate on it
 * so a `<br>` typed by hand (no marker) sails through every round-trip
 * untouched — the bug this fixes was that the previous shape-based
 * strip ("any `<br>` followed by `\n`") couldn't tell user-typed BRs
 * apart from auto-emitted ones and ate the writer's manual breaks on
 * save.
 *
 * The marker is just `<br data-auto-br>` (empty value — present-or-
 * absent semantics). sanitize-html is configured to keep this
 * attribute on `<br>` only; the renderer treats it as a no-op (the
 * browser ignores unknown data-* attributes and paints a regular
 * line break).
 */
const AUTO_BR = '<br data-auto-br>';
/** Match an auto-emitted BR regardless of how sanitize-html normalized
 *  the tag shape (`<br data-auto-br>`, `<br data-auto-br />`, with or
 *  without quoted value). Case-insensitive. */
const AUTO_BR_RE = /<br\b[^>]*\bdata-auto-br\b[^>]*>/i;

/**
 * Pre-pass: convert PARAGRAPH-break newlines to `<br>` for inputs that
 * look like plain text. Only runs of 2+ newlines emit `<br>`s — one
 * per extra newline past the first — so hitting Enter once is invisible
 * (HTML collapses the lone newline to whitespace) and hitting Enter
 * twice gives one blank line. The earlier rule emitted a `<br>` for
 * every `\n`, which made a casual textarea wrap show up as a paragraph
 * break and ballooned bios with vertical air the writer never asked for.
 *
 * Skipped entirely when the input carries paragraph-level wrappers
 * (`<p>`, `<div>`, `<blockquote>`, `<pre>`) — those already define their
 * own vertical rhythm. Inline tags (`<br>`, `<b>`, `<i>`), lists, and
 * headings do NOT count as paragraph structure: a writer who typed
 * `<h3>Title</h3>` followed by two newlines of prose still expects the
 * paragraph rule to fire.
 *
 * IDEMPOTENT — and surgical about it. The strip phase only touches
 * `<br>` tags carrying the `data-auto-br` marker, so a `<br>` the
 * writer typed (even at end-of-line, the shape that previously looked
 * indistinguishable from our auto-emit) survives the round-trip
 * untouched. Without the marker, every re-save was either compounding
 * `<br>` tags on each paragraph break OR — once we added the
 * shape-based strip to fix that — silently eating manually-typed
 * inline `<br>`s.
 */
function nlToBrForPlainText(input: string): string {
  // `<style>` counts as paragraph-level structure here even though it
  // renders no visible content. Without that gate, the newline-to-br
  // pass would happily inject `<br data-auto-br>` INTO CSS rule bodies
  // (between rules, around braces), corrupting the stylesheet at
  // render time. Writers with a `<style>` block presumably author
  // their own paragraph structure too — the implicit-paragraph rule
  // is for casual textarea-typed bios with no markup.
  const hasParagraphStructure = /<(?:p|div|blockquote|pre|style)\b/i.test(input);
  if (hasParagraphStructure) return input;
  let s = input.replace(/\r\n?/g, "\n");
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
  // Each "\n\n+" run becomes one source newline plus (count-1) marked
  // <br>s. Persisting one trailing `\n` keeps the stored HTML
  // human-readable.
  s = s.replace(/\n{2,}/g, (run) => AUTO_BR.repeat(run.length - 1) + "\n");
  return s;
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
 * they wrote it — same reason as the save-side strip: shape alone
 * can't tell ours from theirs, so we use the marker as the explicit
 * tell.
 *
 * Paragraph-structured bios (with `<p>` / `<div>` / `<blockquote>` /
 * `<pre>`) skip the transform — those were never touched on save, so
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
      return "\n".repeat(count + 1);
    },
  );
}

/**
 * CSS class every user-HTML render site wraps its container in. Used
 * by `scopeStyleBlocks` to confine `<style>` rules so a user-authored
 * `body { display: none }` lands as `.user-html-scope body { ... }`
 * (which matches no `<body>` inside the scope, and therefore does
 * nothing globally). Importing surfaces (ProfileModal bio render,
 * forum post body, world page body, welcome HTML) must put this class
 * on the element wrapping the `dangerouslySetInnerHTML` output.
 */
export const USER_HTML_SCOPE_CLASS = "user-html-scope";

/**
 * Value-shape regex for inline `style="..."` properties. Permissive:
 * any value EXCEPT one containing the deny tokens listed below
 * (case-insensitive). The negative lookahead is what makes the rule —
 * `url(`, `expression(`, `javascript:`, `data:`, `@import`,
 * `behavior:`, `-moz-binding` would all carry external-load or
 * script-execution semantics. The structural breakouts (`<`, `>`,
 * `{`, `}`, `;`) are blocked from appearing literally so a value
 * can't end the style attribute and inject more.
 *
 * Note `;` blocking means callers can't pass multi-property values
 * within a SINGLE entry. That's correct: sanitize-html splits the
 * `style` attribute into per-property entries before applying this
 * regex per-value, so a user-authored `padding: 1em; margin: 2em`
 * lands as two separate validations.
 */
const SAFE_CSS_VALUE = /^(?!.*(?:url\s*\(|expression\s*\(|javascript:|data:|@import|behavior\s*:|-moz-binding))[^<>{};]+$/i;

/**
 * Inline-style property allow-list. Every listed property accepts the
 * `SAFE_CSS_VALUE` regex above, so the surface here is: "user can
 * paint any safe value on these properties." Properties NOT listed
 * are silently dropped. Notable omissions:
 *
 *   position, top, left, right, bottom, z-index
 *     — would let a bio overlay site chrome (the close button, the
 *       chat shell when the profile is opened as a modal). The visual
 *       break-out attack.
 *   transform, transform-origin, perspective
 *     — same overlay risk via translate().
 *   animation, animation-*, transition, will-change
 *     — repetitive motion / scroll-jacking; intentional restraint.
 *   cursor
 *     — minor but distracting; not worth the deception surface (e.g.
 *       `cursor: not-allowed` on a working button).
 *
 * If a property is missing from this list that should be allowed,
 * the bar is "doesn't let the bio escape its container or interfere
 * with sibling UI." Add it freely; the SAFE_CSS_VALUE regex still
 * guards the value side.
 */
const ALLOWED_STYLE_PROPS = [
  // Colors
  "color", "background-color", "background", "background-image",
  "background-position", "background-size", "background-repeat",
  "background-attachment", "background-origin", "background-clip",
  "border-color", "outline-color",
  // Borders
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-style", "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-width", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-radius", "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
  "border-collapse", "border-spacing",
  "outline", "outline-style", "outline-width", "outline-offset",
  // Spacing
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "gap", "row-gap", "column-gap",
  // Sizing — bounded by value shape but allowed widely. Worst case
  // is horizontal scroll inside the modal body, which is overflow-
  // contained by the parent (overflow-x-auto on the body div).
  "width", "min-width", "max-width",
  "height", "min-height", "max-height",
  "box-sizing", "aspect-ratio",
  // Typography
  "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "font-stretch", "line-height", "letter-spacing", "word-spacing",
  "text-align", "text-align-last", "text-indent", "text-decoration",
  "text-decoration-line", "text-decoration-style", "text-decoration-color",
  "text-decoration-thickness", "text-underline-offset",
  "text-transform", "text-shadow", "text-overflow", "white-space",
  "word-break", "word-wrap", "overflow-wrap", "hyphens", "tab-size",
  "vertical-align", "writing-mode", "direction",
  // Lists
  "list-style", "list-style-type", "list-style-position", "list-style-image",
  // Display + flex/grid layout (essentials)
  "display", "visibility",
  "flex", "flex-direction", "flex-wrap", "flex-flow", "flex-grow", "flex-shrink", "flex-basis",
  "justify-content", "justify-items", "justify-self",
  "align-items", "align-content", "align-self", "place-items", "place-content", "place-self",
  "order",
  "grid", "grid-template", "grid-template-columns", "grid-template-rows", "grid-template-areas",
  "grid-auto-columns", "grid-auto-rows", "grid-auto-flow",
  "grid-column", "grid-column-start", "grid-column-end",
  "grid-row", "grid-row-start", "grid-row-end",
  "grid-area", "grid-gap", "grid-column-gap", "grid-row-gap",
  // Overflow / clipping
  "overflow", "overflow-x", "overflow-y", "overflow-wrap",
  // Visual effects
  "opacity", "box-shadow", "filter", "backdrop-filter", "mix-blend-mode",
  "object-fit", "object-position",
  // Float / clear (legacy but cheap)
  "float", "clear",
];

const ALLOWED_STYLES_FOR_STAR = Object.fromEntries(
  ALLOWED_STYLE_PROPS.map((p) => [p, [SAFE_CSS_VALUE]]),
);

/**
 * Auto-scope `<style>...</style>` blocks so their rules can only match
 * inside an element bearing `USER_HTML_SCOPE_CLASS`. Walks the CSS as
 * a simple character stream:
 *
 *   - Strip CSS comments (`/* ... *​/`) before any other work, so
 *     bracketed content inside comments doesn't confuse the brace
 *     tracker.
 *   - At top level: when we hit a non-whitespace, non-`@`, non-`}`,
 *     non-`{` character, it starts a selector. Read up to the next
 *     `{`, prefix the selector(s) (handling comma-lists), then walk
 *     the body to the matching `}`.
 *   - `@import`, `@charset`, `@namespace` rules are stripped
 *     unconditionally — they all carry external-load semantics.
 *   - `@media (...) { ... }`, `@supports (...) { ... }`,
 *     `@container (...) { ... }`, `@layer (...) { ... }` recurse
 *     into the inner block.
 *   - `@keyframes`, `@font-face`, `@page`, `@font-feature-values`
 *     pass through with no selector rewrite (their inner selectors
 *     don't target page elements).
 *
 * Limitations of the regex-free walker:
 *   - Doesn't validate CSS syntactically; malformed input may
 *     produce nothing or pass through garbage that the browser
 *     ignores at render time. That's fine — bad CSS is the writer's
 *     problem, and a malformed `<style>` can't escape its container
 *     even with bad content because the scope prefix still wraps it.
 *   - Doesn't strip `url()` from CSS values inside `<style>` (the
 *     inline-style sanitizer does for inline attributes). For now,
 *     a writer could in theory pull a remote background image via
 *     `background: url(https://evil.example/track.png)`. Accepted
 *     trade-off: same risk as `<img src="...">` which we already
 *     allow.
 *
 * Returns the same HTML with every `<style>` block's selectors
 * scoped. Non-`<style>` content is passed through unchanged.
 */
function scopeStyleBlocks(html: string): string {
  if (!html.includes("<style")) return html;
  // Case-insensitive `<style ...>` ... `</style>` matcher. The body
  // is captured non-greedily so multiple `<style>` blocks each scope
  // independently. We don't try to honor `type` / `media` attrs on
  // the tag — sanitize-html drops attrs not in the allow-list anyway.
  return html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, cssRaw: string) => {
    const stripped = stripDangerousCssUrls(cssRaw);
    const scoped = scopeCss(stripped, `.${USER_HTML_SCOPE_CLASS}`);
    return `<style>${scoped}</style>`;
  });
}

/**
 * Neutralize any `url()` value inside `<style>` CSS that carries a
 * `javascript:` or `data:` scheme. Same intent as the inline-style
 * `SAFE_CSS_VALUE` regex — block external/inline scripts and arbitrary
 * payloads — applied here because the CSS-block path doesn't pass
 * through that regex. We replace the whole `url(...)` token with an
 * empty `url("")` so the CSS rule survives syntactically (a malformed
 * rule could be parsed by the browser as a different rule) but the
 * URL load is neutered.
 *
 * Other `url()` schemes (http, https, relative) ride through. A user
 * who wants a remote image background can still write
 * `background-image: url(https://...);` inside their `<style>`. The
 * scheme allowlist matches the `<img src>` policy elsewhere.
 */
function stripDangerousCssUrls(css: string): string {
  return css.replace(/url\s*\(\s*(['"]?)([^'"\s)]*)\1\s*\)/gi, (match, _quote: string, raw: string) => {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.startsWith("javascript:") || trimmed.startsWith("data:") || trimmed.startsWith("vbscript:")) {
      return 'url("")';
    }
    return match;
  });
}

function stripCssComments(css: string): string {
  // `/* ... */` non-greedy. Multiline-friendly because `.` doesn't
  // match newlines by default — we use `[\s\S]` so it does.
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Walk a CSS string, prefix every selector with `scope`, recurse into
 * `@media` / `@supports` / `@container` / `@layer` block bodies, and
 * strip `@import` / `@charset` / `@namespace`. See `scopeStyleBlocks`
 * for the full design notes.
 */
function scopeCss(css: string, scope: string): string {
  const src = stripCssComments(css);
  let i = 0;
  let out = "";
  while (i < src.length) {
    // Skip whitespace at top level — but emit it so the output keeps
    // its rough shape for readability when re-saved by an editor.
    if (/\s/.test(src[i]!)) {
      out += src[i++]!;
      continue;
    }
    if (src[i] === "@") {
      // At-rule. Read up to `{` or `;`, whichever comes first.
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
        // Single-line at-rule (no block). `@import`, `@charset`,
        // `@namespace` get DROPPED; everything else passes through.
        const drop = /^@(?:import|charset|namespace)\b/.test(lower);
        if (!drop) out += `${prelude};`;
        i = j + 1;
        continue;
      }
      if (src[j] === "{") {
        // Block at-rule. For wrapping at-rules (media/supports/etc.)
        // we recurse into the body and re-emit. For containing at-
        // rules (keyframes/font-face/page), we emit the body as-is.
        const bodyStart = j + 1;
        const bodyEnd = matchingBrace(src, j);
        if (bodyEnd === -1) {
          // Unmatched brace — bail with the rest as-is. Browser
          // would skip the malformed rule anyway.
          out += src.slice(i);
          return out;
        }
        const body = src.slice(bodyStart, bodyEnd);
        const wraps = /^@(?:media|supports|container|layer|document)\b/.test(lower);
        if (wraps) {
          out += `${prelude}{${scopeCss(body, scope)}}`;
        } else {
          // @keyframes, @font-face, @page, @font-feature-values,
          // @property, @counter-style — their inner selectors are
          // not DOM selectors (e.g. `from`/`to` in keyframes), so
          // leave the body alone.
          out += `${prelude}{${body}}`;
        }
        i = bodyEnd + 1;
        continue;
      }
      // Reached end of input mid-at-rule. Pass through unchanged.
      out += src.slice(i);
      return out;
    }
    if (src[i] === "}") {
      // Stray closing brace at top level — emit and continue (lets a
      // malformed input degrade gracefully instead of dropping the
      // remainder).
      out += src[i++]!;
      continue;
    }
    // Selector list followed by a block. Read up to `{`.
    let j = i;
    let depth = 0;
    while (j < src.length) {
      const c = src[j]!;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (depth === 0 && c === "{") break;
      j++;
    }
    if (j >= src.length) {
      // No block — orphan selector. Drop it.
      return out;
    }
    const selectorList = src.slice(i, j).trim();
    const bodyStart = j + 1;
    const bodyEnd = matchingBrace(src, j);
    if (bodyEnd === -1) {
      // Unmatched brace; bail with the rest as-is.
      out += src.slice(i);
      return out;
    }
    const body = src.slice(bodyStart, bodyEnd);
    // Comma-split the selector list. CSS doesn't allow commas inside
    // simple selectors (commas only separate selector groups), so a
    // plain split is correct for our purposes. Pseudo-element/class
    // names don't contain commas either.
    const scopedSelectors = selectorList
      .split(",")
      .map((s) => `${scope} ${s.trim()}`)
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

/** Sanitize a profile/bio HTML body. Used on save AND on read. */
export function sanitizeBio(html: string): string {
  // Scope <style> contents BEFORE sanitize-html runs. sanitize-html
  // would otherwise preserve the <style> text but not understand its
  // contents — leaving a global stylesheet in place. Scoping first
  // means the body that sanitize-html sees + emits is already safe.
  const scoped = scopeStyleBlocks(nlToBrForPlainText(html));
  return sanitizeHtml(scoped, {
    allowedTags: ALLOWED_TAGS,
    // `style` and `class` ride on every allowed element. The actual
    // power of `style` is constrained by `allowedStyles` below — only
    // listed properties whose values pass `SAFE_CSS_VALUE` survive
    // sanitization.
    //
    // Tag-specific attributes (href, src, colspan, etc.) layer ON TOP
    // of the wildcard set — sanitize-html merges them per element.
    allowedAttributes: {
      "*": ["class", "style", "title"],
      a: ["href", "title", "name"],
      img: ["src", "alt", "title", "width", "height"],
      // `data-auto-br` rides on the BR tags that `nlToBrForPlainText`
      // auto-emits for paragraph breaks. The save-side strip and the
      // read-side reverse both gate on this marker so a `<br>` the
      // writer typed by hand stays put through round-trips. Browsers
      // ignore unknown `data-*` attributes at render time, so the
      // marker is invisible to readers.
      br: ["data-auto-br"],
      // Tables: colspan/rowspan are pure layout, no security cost.
      // `scope` on th helps screen readers; cheap to allow.
      table: ["class", "style", "title"],
      td: ["class", "style", "title", "colspan", "rowspan", "headers"],
      th: ["class", "style", "title", "colspan", "rowspan", "scope", "headers"],
      // `open` on details lets writers ship a section pre-expanded.
      details: ["class", "style", "title", "open"],
      // <style> tags don't need user-set attributes; `type`/`media`
      // get dropped (we don't honor them anyway — scoping happens
      // pre-sanitize).
      style: [],
    },
    // mailto is allowed so users can drop a contact address on the
    // profile. `tel:` is intentionally omitted — RP context, no need.
    // `javascript:` and `data:` are NOT in this list; they're blocked.
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    transformTags: {
      // Outbound links always open in a new tab with the security-
      // recommended rel set. `ugc` is the "user-generated content"
      // signal search engines use to discount the link.
      a: sanitizeHtml.simpleTransform("a", {
        rel: "noopener noreferrer ugc",
        target: "_blank",
      }),
    },
    allowedStyles: {
      "*": ALLOWED_STYLES_FOR_STAR,
    },
    disallowedTagsMode: "discard",
  });
}
