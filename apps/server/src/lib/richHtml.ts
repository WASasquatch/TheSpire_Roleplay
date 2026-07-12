import sanitizeHtml from "sanitize-html";
import {
  RICH_ALIGN_TAGS,
  RICH_ALLOWED_TAGS,
  RICH_SPOILER_CLASS,
  normalizeRichColor,
  normalizeRichFontSize,
  normalizeRichTextAlign,
} from "@thekeep/shared";

/**
 * Ingest sanitizer for rich-HTML chat bodies (messages.format = 'html').
 *
 * Posture is the OPPOSITE of the bio sanitizer (auth/html.ts): bios are
 * mini-webpages behind a deny list; a chat body is formatting-only
 * behind a strict ALLOW list (the shared RICH_* whitelist). Everything
 * this function lets through, the client's DOMPurify pass re-admits at
 * render, and nothing else — a stored body that somehow bypassed this
 * function still can't paint markup outside the whitelist.
 *
 * Style attributes survive ONLY as re-emitted validated declarations:
 *   - span:      color (hex/rgb()/named table → stored hex),
 *                font-size (the exact bucket em constants, never px)
 *   - p / h1-h3: text-align (left | center | right)
 * The emitted value is the VALIDATOR's output, never author bytes, so
 * url() / expression() / var() payloads cannot survive by construction.
 *
 * Class attributes survive only as the literal spoiler token on span.
 * Links are forced to http(s) + rel="noopener noreferrer ugc" +
 * target="_blank".
 */

/** Tags whose CONTENT is dropped along with the tag (a stripped
 *  `<script>` must not leave its source as visible text). */
const DROP_CONTENT_TAGS = ["script", "style", "textarea", "option", "iframe", "noscript", "svg", "math", "object", "embed", "title"];

const ALIGN_TAG_SET = new Set<string>(RICH_ALIGN_TAGS);

/** One declaration's value out of a raw style attribute. Boundary guard
 *  so `background-color` can't satisfy a `color` lookup. */
function styleDecl(style: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(style);
  if (!m) return null;
  return m[1]!.replace(/\s*!important\s*$/i, "").trim() || null;
}

/** Rebuild a style attribute from ONLY the validated declarations the
 *  tag may carry. Returns null when nothing validates (attr dropped).
 *  `blocksDisabled` (the reduced per-room profile) drops `text-align`
 *  entirely — alignment is a rich-only construct. */
function filterRichStyle(tagName: string, rawStyle: string | undefined, blocksDisabled: boolean): string | null {
  if (!rawStyle) return null;
  const decls: string[] = [];
  // Declaration format matches sanitize-html's normalized emission
  // (`prop:value`, `;`-joined) so stored bytes are stable across
  // repeated sanitize passes.
  if (tagName === "span") {
    const color = styleDecl(rawStyle, "color");
    const hex = color ? normalizeRichColor(color) : null;
    if (hex) decls.push(`color:${hex}`);
    const size = styleDecl(rawStyle, "font-size");
    const em = size ? normalizeRichFontSize(size) : null;
    if (em) decls.push(`font-size:${em}`);
  } else if (!blocksDisabled && ALIGN_TAG_SET.has(tagName)) {
    const align = styleDecl(rawStyle, "text-align");
    const validated = align ? normalizeRichTextAlign(align) : null;
    // `left` is the default flow; emitting it would just be noise.
    if (validated && validated !== "left") decls.push(`text-align:${validated}`);
  }
  return decls.length ? decls.join(";") : null;
}

/**
 * Sanitizer options. `blocksDisabled` is the REDUCED profile for rooms with
 * `rich_text_disabled` (migration 0354): h1-h3 unwrap to paragraphs and
 * `text-align` strips, so a rich-disabled room can never persist a heading
 * or an alignment no matter what a client sends — the inline whitelist
 * (marks, color, size, spoiler, links, lists, quotes) is untouched.
 */
export interface SanitizeRichOptions {
  blocksDisabled?: boolean;
}

export function sanitizeRichMessageHtml(raw: string, opts?: SanitizeRichOptions): string {
  const blocksDisabled = opts?.blocksDisabled ?? false;
  return sanitizeHtml(raw, {
    allowedTags: [...RICH_ALLOWED_TAGS],
    allowedAttributes: {
      a: ["href", "rel", "target"],
      span: ["style", "class"],
      p: ["style"],
      h1: ["style"],
      h2: ["style"],
      h3: ["style"],
    },
    allowedClasses: { span: [RICH_SPOILER_CLASS] },
    // http(s) only; javascript: / data: / vbscript: hrefs drop.
    allowedSchemes: ["http", "https"],
    disallowedTagsMode: "discard",
    nonTextTags: DROP_CONTENT_TAGS,
    transformTags: {
      // One wildcard transform (a per-tag entry would SHADOW it, not
      // stack): rebuild every tag's attribute map from scratch so only
      // validated values survive. allowedAttributes above still gates
      // afterwards; this pass owns VALUE validation.
      "*": (rawTagName, attribs) => {
        // Reduced profile: headings unwrap to paragraphs BEFORE the
        // attribute rebuild, so an aligned heading loses both constructs
        // in one pass (the paragraph's align then strips below).
        const tagName = blocksDisabled && (rawTagName === "h1" || rawTagName === "h2" || rawTagName === "h3")
          ? "p"
          : rawTagName;
        const out: Record<string, string> = {};
        if (tagName === "a") {
          if (attribs.href) out.href = attribs.href; // scheme-gated by allowedSchemes
          out.rel = "noopener noreferrer ugc";
          out.target = "_blank";
        }
        if (tagName === "span" && typeof attribs.class === "string") {
          // Only the literal spoiler token survives; any other class
          // (or a smuggled multi-class run) is dropped wholesale.
          if (attribs.class.split(/\s+/).includes(RICH_SPOILER_CLASS)) {
            out.class = RICH_SPOILER_CLASS;
          }
        }
        const style = filterRichStyle(tagName, attribs.style, blocksDisabled);
        if (style) out.style = style;
        return { tagName, attribs: out };
      },
    },
  });
}
