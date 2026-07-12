import {
  FONT_SIZE_EM,
  cssColorToHex,
  type ComposerDoc,
  type ComposerLine,
  type ComposerSpan,
  type ComposerTextSize,
} from "./composerDoc.js";
import { escapeHtml, escapeHtmlAttr } from "./html.js";

/* =============================================================
 * Rich-HTML chat message format (messages.format = 'html')
 *
 * Chat messages carry a second body format alongside the historic
 * markdown grammar: sanitized rich HTML. The whitelist below is the
 * SINGLE contract every enforcement point derives from:
 *
 *   - the server-side ingest sanitizer (sanitize-html) in
 *     apps/server/src/lib/richHtml.ts,
 *   - the client-side render re-sanitizer (DOMPurify) in
 *     apps/web/src/lib/richBody.tsx,
 *   - the composer's wire serializer (ComposerEditor.tsx), which only
 *     ever EMITS constructs on this list.
 *
 * Anything outside the whitelist is dropped at ingest, and dropped
 * again at render (defense in depth). Old messages keep format 'md'
 * and never touch any of this.
 * ============================================================= */

/** Body format discriminator persisted on `messages.format`. Absent on
 *  the wire (or 'md') = the historic markdown pipeline. */
export type ChatMessageFormat = "md" | "html";

/**
 * Raw-HTML byte ceiling for an incoming 'html' body, enforced BEFORE
 * sanitizing. The visible-character cap (maxMessageLength over the
 * derived plaintext) bounds what readers see; this bounds markup bloat
 * a client could smuggle around it (a 4000-char message wrapped in
 * per-character spans).
 */
export const RICH_HTML_MAX_BYTES = 24 * 1024;

/** The one class token allowed on `<span>`: click-to-reveal spoilers. */
export const RICH_SPOILER_CLASS = "spoiler";

/** Element whitelist. No img / iframe / script / svg / style / table —
 *  formatting only. `div` is deliberately absent: alignment lives on
 *  paragraphs and headings via text-align. */
export const RICH_ALLOWED_TAGS = [
  "p", "br",
  "h1", "h2", "h3",
  "strong", "b", "em", "i", "u", "s", "code",
  "pre", "blockquote",
  "ul", "ol", "li",
  "a",
  "span",
] as const;

/** Block tags that may carry a validated `text-align` style. */
export const RICH_ALIGN_TAGS = ["p", "h1", "h2", "h3"] as const;

/** The only font-size values a rich body may carry: the composer's
 *  bucket em constants (small / large / huge). Never raw px. */
export const RICH_FONT_SIZE_EMS: readonly string[] = Object.values(FONT_SIZE_EM);

/**
 * Validate/normalize a `color:` style value for a rich body. Accepts
 * hex / rgb() / the shared named-color table, returns the stored hex;
 * anything else (gradients, var(), url(), hostile payloads) → null →
 * the declaration is dropped.
 */
export function normalizeRichColor(value: string): string | null {
  return cssColorToHex(value);
}

/** Validate a `font-size:` style value: ONLY the exact bucket em
 *  constants pass (the composer normalizes pasted sizes to buckets
 *  before they ever reach the wire). */
export function normalizeRichFontSize(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/\s+/g, "");
  return RICH_FONT_SIZE_EMS.includes(v) ? v : null;
}

/** Validate a `text-align:` style value on a block tag. */
export function normalizeRichTextAlign(value: string): "left" | "center" | "right" | null {
  const v = value.trim().toLowerCase();
  return v === "left" || v === "center" || v === "right" ? v : null;
}

/** Reverse of FONT_SIZE_EM: the exact bucket a stored `font-size` em
 *  value maps back to (editor hydration of a persisted rich body). */
export function richFontSizeEmToBucket(value: string): ComposerTextSize | null {
  const v = value.trim().toLowerCase().replace(/\s+/g, "");
  for (const [bucket, em] of Object.entries(FONT_SIZE_EM)) {
    if (em === v) return bucket as ComposerTextSize;
  }
  return null;
}

/* =============================================================
 * ComposerDoc → rich-HTML wire serializer
 *
 * The composer's send path: when the document carries constructs the
 * chat-markdown wire cannot express (headings, alignment), the client
 * serializes it through THIS function and ships `format: "html"`.
 * Every construct emitted here is on the RICH_* whitelist above by
 * construction, so the server's ingest sanitizer is a no-op for
 * honest clients and a hard gate for everyone else. No DOM — runs
 * under the node test harness.
 * ============================================================= */

/** True when the doc needs the rich-HTML wire format: it carries a
 *  heading or a non-default alignment. Everything else ships as the
 *  historic chat markdown, byte-identical. */
export function composerDocNeedsRichFormat(doc: ComposerDoc): boolean {
  return doc.lines.some((l) => !!l.block || !!l.align);
}

function richSpanHtml(span: ComposerSpan): string {
  let out = escapeHtml(span.text);
  const marks = new Set(span.marks ?? []);
  // Innermost-out, mirroring the render CSS nesting expectations.
  if (marks.has("code")) out = `<code>${out}</code>`;
  if (marks.has("underline")) out = `<u>${out}</u>`;
  if (marks.has("strike")) out = `<s>${out}</s>`;
  if (marks.has("italic")) out = `<em>${out}</em>`;
  if (marks.has("bold")) out = `<strong>${out}</strong>`;
  const decls: string[] = [];
  const color = span.color ? normalizeRichColor(span.color) : null;
  // Declaration format matches sanitize-html's normalized re-emission
  // (`prop:value`, `;`-joined, no spaces) so serializer output is a
  // byte-level fixed point of the ingest sanitizer.
  if (color) decls.push(`color:${color}`);
  if (span.size) decls.push(`font-size:${FONT_SIZE_EM[span.size]}`);
  if (decls.length) out = `<span style="${decls.join(";")}">${out}</span>`;
  if (marks.has("spoiler")) out = `<span class="${RICH_SPOILER_CLASS}">${out}</span>`;
  if (span.link && /^https?:\/\//i.test(span.link)) {
    out = `<a href="${escapeHtmlAttr(span.link)}" rel="noopener noreferrer ugc" target="_blank">${out}</a>`;
  }
  return out;
}

/** Alignment style attribute for a block tag; empty for default flow. */
function richAlignAttr(line: ComposerLine): string {
  return line.align ? ` style="text-align:${line.align}"` : "";
}

/** Inline content of one line; an empty line keeps a visible break. */
function richLineContent(line: ComposerLine): string {
  const inner = line.spans.map(richSpanHtml).join("");
  return inner || "<br />";
}

export function composerDocToRichHtml(doc: ComposerDoc): string {
  const lines = doc.lines;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === "quote") {
      const paras: string[] = [];
      while (i < lines.length && lines[i]!.kind === "quote") {
        paras.push(`<p${richAlignAttr(lines[i]!)}>${richLineContent(lines[i]!)}</p>`);
        i++;
      }
      out.push(`<blockquote>${paras.join("")}</blockquote>`);
      continue;
    }
    if (line.kind === "bullet") {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.kind === "bullet") {
        // `li` carries no style in the whitelist — bullet alignment
        // intentionally drops rather than smuggling a denied attr.
        items.push(`<li>${richLineContent(lines[i]!)}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    const tag = line.block ?? "p";
    out.push(`<${tag}${richAlignAttr(line)}>${richLineContent(line)}</${tag}>`);
    i++;
  }
  return out.join("");
}

/* =============================================================
 * Sanitized-HTML text utilities
 *
 * These operate on SANITIZER OUTPUT only. sanitize-html (and the
 * composer's serializer) entity-escape `<` and `>` inside text and
 * attribute values, so a `/(<[^>]*>)/` split is an exact tag/text
 * partition — no DOM needed, which keeps them usable server-side and
 * in the node test harness.
 * ============================================================= */

/** Decode the entity set the sanitizer/serializer emit in text nodes. */
export function decodeRichEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos|nbsp));/g, (m, dec, hex, named) => {
    if (dec) {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    if (hex) {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    switch (named) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      case "nbsp": return " ";
      default: return m;
    }
  });
}

/**
 * Map every TEXT node of a sanitized rich body through `fn`, leaving
 * tags byte-identical. Used for transforms that must never touch
 * markup: mention-token rewriting, the minor language mask.
 */
export function mapRichHtmlTextNodes(html: string, fn: (text: string) => string): string {
  const parts = html.split(/(<[^>]*>)/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part && !part.startsWith("<")) parts[i] = fn(part);
  }
  return parts.join("");
}

/** Concatenated text content of a sanitized rich body (no block
 *  breaks, entities still encoded). Internal building block. */
function richHtmlTextSegments(html: string): string[] {
  return html.split(/(<[^>]*>)/).filter((p) => p && !p.startsWith("<"));
}

/**
 * Derive the VISIBLE plaintext of a sanitized rich body: block
 * boundaries become newlines, tags drop, entities decode. This is
 * what `messages.body_text` stores and what every plaintext consumer
 * (search, automod, notification snippets, caps) reads.
 */
export function richHtmlToText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|h1|h2|h3|li|blockquote|pre|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeRichEntities(withBreaks)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "");
}

/** Every http(s) href carried by a sanitized rich body, in document
 *  order (entity-decoded). Feeds the link-unfurl scan, which otherwise
 *  only sees visible text. */
export function richHtmlLinkHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /<a\s[^>]*href\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = decodeRichEntities(m[1]!);
    if (/^https?:\/\//i.test(href)) out.push(href);
  }
  return out;
}
