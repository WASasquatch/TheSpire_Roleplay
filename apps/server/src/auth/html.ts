import sanitizeHtml from "sanitize-html";

/**
 * What we let writers paste into a bio / world page / admin HTML block.
 *
 * The bar: "primitive formatting HTML." Anything visual that helps a
 * profile read well is in; anything that can execute, fetch, navigate,
 * or break our chrome is out. The disallow side is enforced by what we
 * DON'T list here (sanitize-html discards everything outside the
 * allow-list): no <script>, <iframe>, <form>, <input>, <object>,
 * <embed>, <style>, <link>, <meta>. Event-handler attributes (onClick,
 * onLoad, etc.) are stripped by sanitize-html's defaults regardless of
 * what's in `allowedAttributes`. `javascript:` and `data:` schemes are
 * blocked at the scheme allow-list below.
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
];

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
 * IDEMPOTENT. Re-running on a previously-saved bio first strips the
 * `<br>` tags this pass placed immediately before a newline, then
 * re-applies the rule on the cleaned source. Without this, every
 * round-trip through save was concatenating another `<br>` onto each
 * paragraph break — the source of the "my profile keeps gaining blank
 * lines on every save" report.
 */
function nlToBrForPlainText(input: string): string {
  const hasParagraphStructure = /<(?:p|div|blockquote|pre)\b/i.test(input);
  if (hasParagraphStructure) return input;
  let s = input.replace(/\r\n?/g, "\n");
  // Strip any auto-added <br> tags directly before a "\n" (or at the
  // end of input). `[ \t]*` instead of `\s*` between BRs so we don't
  // accidentally span across a separate paragraph break.
  s = s.replace(/(?:<br\s*\/?>[ \t]*)+(?=\n|$)/gi, "");
  // Each "\n\n+" run becomes one source newline plus (count-1) `<br>`s.
  // Persisting one trailing `\n` keeps the stored HTML human-readable.
  s = s.replace(/\n{2,}/g, (run) => "<br>".repeat(run.length - 1) + "\n");
  return s;
}

/**
 * Reverse of {@link nlToBrForPlainText} for the bio editor: undo the
 * `<br>`-padded paragraph breaks the save pass produced so the
 * textarea shows clean source text instead of literal `<br>` strings.
 * Each run of N `<br>` tags immediately before a `\n` (or at end of
 * input) expands back to N+1 source newlines, mirroring the save rule
 * exactly. Paragraph-structured bios (with `<p>` / `<div>` /
 * `<blockquote>` / `<pre>`) skip the transform — those were never
 * touched on save, so there's nothing to undo.
 *
 * Used by the owner-only GET paths that feed the editor; viewer-facing
 * read paths still see the persisted HTML with breaks intact.
 */
export function bioHtmlForEdit(html: string): string {
  if (!html) return html;
  const hasParagraphStructure = /<(?:p|div|blockquote|pre)\b/i.test(html);
  if (hasParagraphStructure) return html;
  const normalized = html.replace(/\r\n?/g, "\n");
  return normalized.replace(/((?:<br\s*\/?>[ \t]*)+)(\n|$)/gi, (_m, brs: string) => {
    const count = (brs.match(/<br/gi) ?? []).length;
    return "\n".repeat(count + 1);
  });
}

/** Sanitize a profile/bio HTML body. Used on save AND on read. */
export function sanitizeBio(html: string): string {
  return sanitizeHtml(nlToBrForPlainText(html), {
    allowedTags: ALLOWED_TAGS,
    // `style` and `class` ride on every allowed element. The actual
    // power of `style` is constrained by `allowedStyles` below — only
    // listed properties with values matching the listed regexes survive
    // sanitization, so opening this up doesn't broaden the attack
    // surface, it just lets writers style any element instead of
    // wrapping everything in <span style="…">.
    //
    // Tag-specific attributes (href, src, colspan, etc.) layer ON TOP
    // of the wildcard set — sanitize-html merges them per element.
    allowedAttributes: {
      "*": ["class", "style", "title"],
      a: ["href", "title", "name"],
      img: ["src", "alt", "title", "width", "height"],
      // Tables: colspan/rowspan are pure layout, no security cost.
      // `scope` on th helps screen readers; cheap to allow.
      table: ["class", "style", "title"],
      td: ["class", "style", "title", "colspan", "rowspan", "headers"],
      th: ["class", "style", "title", "colspan", "rowspan", "scope", "headers"],
      // `open` on details lets writers ship a section pre-expanded.
      details: ["class", "style", "title", "open"],
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
    // Inline-style allow-list. Each property has a value regex; styles
    // that don't match are silently dropped. The intent: rich
    // typography + alignment + color, no positioning / sizing tricks
    // that could break out of the modal or overlay the chrome.
    allowedStyles: {
      "*": {
        // Colors — hex (#abc or #aabbcc), rgb(), rgba(). Same regex
        // matrix applies to color and background-color.
        color: [/^#(?:[0-9a-fA-F]{3}){1,2}$/, /^rgb\(/, /^rgba\(/],
        "background-color": [/^#(?:[0-9a-fA-F]{3}){1,2}$/, /^rgb\(/, /^rgba\(/],
        // Typography
        "font-weight": [/^(?:bold|normal|lighter|bolder|[1-9]00)$/],
        "font-style": [/^(?:italic|normal|oblique)$/],
        "font-family": [/^[\w\s"',\-]{1,200}$/], // family names + commas + spaces
        // Bounded font-size: 8-72px / 0.5em-4em / 50%-400%. Capped to
        // keep a writer from breaking the modal with `font-size: 1000px`.
        "font-size": [
          /^(?:[1-9]|[1-6]\d|7[0-2])px$/,                  // 1px..72px
          /^(?:0\.[5-9]|[1-3](?:\.\d+)?|4)em$/,            // 0.5em..4em
          /^(?:[5-9]\d|[1-3]\d{2}|400)%$/,                 // 50%..400%
          /^(?:xx-small|x-small|small|medium|large|x-large|xx-large)$/,
        ],
        "line-height": [/^(?:0?\.\d+|[1-3](?:\.\d+)?)$/, /^(?:1[0-9]|[2-6]\d)px$/],
        // Decoration
        "text-decoration": [/^(?:underline|line-through|overline|none)$/],
        "text-align": [/^(?:left|right|center|justify)$/],
        // Lists
        "list-style-type": [/^(?:disc|circle|square|decimal|lower-roman|upper-roman|lower-alpha|upper-alpha|none)$/],
        // Vertical-align on inline elements / table cells
        "vertical-align": [/^(?:baseline|top|middle|bottom|sub|super)$/],
      },
    },
    disallowedTagsMode: "discard",
  });
}
