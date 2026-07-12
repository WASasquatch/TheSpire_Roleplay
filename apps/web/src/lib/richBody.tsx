import DOMPurify from "dompurify";
import type { CSSProperties, ReactNode } from "react";
import {
  RICH_ALIGN_TAGS,
  RICH_ALLOWED_TAGS,
  RICH_SPOILER_CLASS,
  normalizeRichColor,
  normalizeRichFontSize,
  normalizeRichTextAlign,
} from "@thekeep/shared";
import { SpoilerSpan } from "./markdown.js";

/**
 * Render-side pipeline for rich-HTML message bodies (format 'html').
 *
 * Defense in depth over the server's ingest sanitizer: the stored body
 * is re-sanitized here with DOMPurify against the SAME shared whitelist
 * (RICH_* in @thekeep/shared), then converted to React elements — never
 * dangerouslySetInnerHTML — with attribute VALUES re-validated during
 * the walk (only whitelisted style declarations survive; only the
 * spoiler class survives; hrefs must be http(s)). Text nodes are handed
 * to the caller so the chat feed can run its mention / emoticon / token
 * renderers over them (parity with md bodies).
 */

const ALIGN_TAG_SET = new Set<string>(RICH_ALIGN_TAGS);

/** Blocks / marks that map 1:1 to a plain React element. */
const PLAIN_TAGS = new Set([
  "p", "br", "h1", "h2", "h3",
  "strong", "b", "em", "i", "u", "s", "code",
  "pre", "blockquote", "ul", "ol", "li",
]);

export function sanitizeRichClient(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...RICH_ALLOWED_TAGS],
    ALLOWED_ATTR: ["href", "style", "class", "rel", "target"],
    ALLOW_DATA_ATTR: false,
  });
}

/** Validated inline style for an element the walker admits. */
function styleFor(el: Element): CSSProperties | undefined {
  const style = (el as HTMLElement).style;
  if (!style) return undefined;
  const out: CSSProperties = {};
  const tag = el.tagName.toLowerCase();
  if (tag === "span") {
    const color = style.color ? normalizeRichColor(style.color) : null;
    if (color) out.color = color;
    const size = style.fontSize ? normalizeRichFontSize(style.fontSize) : null;
    if (size) out.fontSize = size;
  } else if (ALIGN_TAG_SET.has(tag)) {
    const align = style.textAlign ? normalizeRichTextAlign(style.textAlign) : null;
    if (align && align !== "left") out.textAlign = align;
  }
  return Object.keys(out).length ? out : undefined;
}

function walk(
  node: Node,
  key: number,
  renderText: (text: string, key: string) => ReactNode,
): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue ?? "";
    return text ? renderText(text, `t${key}`) : null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const children: ReactNode[] = [];
  let i = 0;
  for (const child of Array.from(el.childNodes)) {
    children.push(walk(child, i++, renderText));
  }

  if (tag === "br") return <br key={key} />;
  if (tag === "a") {
    const href = el.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) return <span key={key}>{children}</span>;
    return (
      <a
        key={key}
        href={href}
        target="_blank"
        rel="noopener noreferrer ugc"
        className="break-all text-keep-action underline hover:text-keep-action/80"
      >
        {children}
      </a>
    );
  }
  if (tag === "span") {
    const classes = (el.getAttribute("class") ?? "").split(/\s+/);
    if (classes.includes(RICH_SPOILER_CLASS)) {
      return <SpoilerSpan key={key}>{children}</SpoilerSpan>;
    }
    const style = styleFor(el);
    return <span key={key} {...(style ? { style } : {})}>{children}</span>;
  }
  if (PLAIN_TAGS.has(tag)) {
    const Tag = tag as keyof JSX.IntrinsicElements;
    const style = styleFor(el);
    return <Tag key={key} {...(style ? { style } : {})}>{children}</Tag>;
  }
  // Anything else (shouldn't survive DOMPurify): keep the text, drop
  // the element.
  return <span key={key}>{children}</span>;
}

/**
 * Sanitized rich body → React tree. `renderText` receives every text
 * node so the caller can run the chat's inline token renderers
 * (mentions, emoticon stickers, world links, autolinks) over it.
 */
export function richBodyToReact(
  html: string,
  renderText: (text: string, key: string) => ReactNode,
): ReactNode[] {
  const clean = sanitizeRichClient(html);
  const tpl = document.createElement("template");
  tpl.innerHTML = clean;
  const out: ReactNode[] = [];
  let i = 0;
  for (const child of Array.from(tpl.content.childNodes)) {
    out.push(walk(child, i++, renderText));
  }
  return out;
}
