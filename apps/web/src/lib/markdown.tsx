import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { canonicalizeNameForLookup, CHK_SPAN_RE, customCmdCssToStyle, decodeCheckMarker, dynamicMarkerFor, resolveMessageColor, resolveUiRoute, VMARK_SPAN_RE, type CheckResultData, type MentionRef, type UiRoute } from "@thekeep/shared";
import { useEmoticons } from "../state/emoticons.js";
import { EmoticonSprite } from "../components/emoticons/EmoticonSprite.js";
import { openUiRoute } from "./uiRouteOpen.js";
import { resolveDynamicChipLabel } from "./uiRouteDynamicLabel.js";
import { UiRouteIcon } from "./uiRouteIcons.js";
import { splitMentions } from "./mentions.js";
import { useActiveTheme } from "./theme.js";
import { LazyMediaEmbed } from "./LazyMediaEmbed.js";

/**
 * Inline markdown renderer for chat message bodies.
 *
 * GFM-flavored inline subset:
 *   **bold** / __bold__              → <strong>
 *   *italic* / _italic_              → <em>
 *   ***both*** / ___both___          → <strong><em>
 *   ~~strikethrough~~                → <s>
 *   ||spoiler||                      → click-to-reveal hidden text
 *   `code`                           → <code>
 *   [text](https://url)              → <a>  (http/https only)
 *   ![alt](https://image-url)        → image with "Show image" toggle
 *   bare http(s)://url autolink      → <a>, with a "Show image" toggle when the
 *                                       URL ends in a common image extension,
 *                                       or a "Show video" toggle when the URL
 *                                       is a recognized YouTube / Vimeo link
 *   @mention                         → handled separately by splitMentions
 *
 * Block-level markdown (#, lists, tables, blockquotes, fenced code) is NOT
 * supported - chat messages are inline content, capped at maxMessageLength
 * and rendered on a single visual line. Newlines pass through as text and
 * the surrounding `<div>` style respects them with `whitespace-pre-wrap`.
 *
 * Safety contract:
 *   1. Output is a tree of React elements; no `dangerouslySetInnerHTML`.
 *   2. `[...](url)`, `![...](url)`, and bare autolinks ALL require `http://` or
 *      `https://`. `javascript:` / `data:` / `file:` schemes never reach
 *      `<a href>` or `<img src>`.
 *   3. Unmatched syntax falls through as plain text - `**unclosed` stays
 *      visible rather than being silently swallowed.
 *   4. The recursion depth on nested emphasis is capped (see `MAX_DEPTH`)
 *      so a hostile message of `*****x*****` can't blow the stack.
 *
 * Underscore boundaries follow GFM "no intraword `_`":
 *   `snake_case_var`   → renders as text (no italics)
 *   `it _works_ now`   → "works" italicized
 *   `__bold here__`    → bold
 * Asterisks DO permit intraword (matching GitHub's behavior):
 *   `f**oo**bar`       → "oo" bolded
 */

const MAX_DEPTH = 8;

/**
 * Try every token pattern at position `i`. Returns the matched length and
 * a React node, or null if no token starts here. Order matters - the more
 * specific patterns (image, link, triple-emphasis) are checked before less
 * specific ones (single emphasis).
 */
interface TokenMatch {
  /** Index in `text` of the first character AFTER the consumed token. */
  end: number;
  node: ReactNode;
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}

function isLeftBoundary(text: string, i: number): boolean {
  // Underscore emphasis can open only at start-of-string or after a
  // non-word character. Prevents `snake_case_var` from rendering "case"
  // in italics.
  return i === 0 || !isWordChar(text[i - 1]);
}

function isRightBoundary(text: string, end: number): boolean {
  return end >= text.length || !isWordChar(text[end]);
}

/**
 * Scan for a closing delimiter at a word boundary. Returns the index of
 * the first character of the closing delimiter, or -1.
 */
function findUnderscoreClose(text: string, start: number, delim: "_" | "__"): number {
  const len = delim.length;
  let i = start;
  while (i < text.length) {
    const idx = text.indexOf(delim, i);
    if (idx < 0) return -1;
    // Reject if this run of underscores is longer than we want (so `___`
    // isn't accidentally consumed as `__` + leftover `_`).
    const charBefore = text[idx - 1];
    const charAfter = text[idx + len];
    // For closing delimiter: must NOT be followed by word char (so the
    // run ends at a word boundary externally), and the character before
    // must be non-space (so `_foo _` doesn't close on the second `_`).
    if (charBefore && /\S/.test(charBefore) && !isWordChar(charAfter)) {
      // Also reject runs longer than expected
      if (delim === "_" && text[idx + 1] === "_") {
        i = idx + 1;
        continue;
      }
      if (delim === "__" && text[idx + 2] === "_") {
        i = idx + 1;
        continue;
      }
      return idx;
    }
    i = idx + 1;
  }
  return -1;
}

/**
 * Closing search for asterisk emphasis. Asterisks permit intraword, so the
 * boundary rule is just: the character immediately before the closing
 * delimiter must be non-whitespace (rules out `* foo *` as italic).
 */
function findAsteriskClose(text: string, start: number, delim: "*" | "**" | "***"): number {
  const len = delim.length;
  let i = start;
  while (i < text.length) {
    const idx = text.indexOf(delim, i);
    if (idx < 0) return -1;
    const charBefore = text[idx - 1];
    // A closer normally needs non-whitespace right before it (rules out
    // `2 * 3 * 4` becoming italic). One deliberate exception: a closer at
    // END of line/text may follow a space — writers habitually type
    // `*…all doubt. *`, and at line end there's no multiplication
    // ambiguity to protect, so dropping the whole line's emphasis over
    // the stray space is worse than accepting it.
    const looseLineEnd =
      !!charBefore && /[ \t]/.test(charBefore) &&
      (idx + len >= text.length || text[idx + len] === "\n");
    if ((charBefore && /\S/.test(charBefore)) || looseLineEnd) {
      // Reject if this is part of a longer run than we want - e.g. don't
      // close `*foo*` on the first asterisk of `**bar**`.
      if (delim === "*" && text[idx + 1] === "*") {
        i = idx + 1;
        continue;
      }
      if (delim === "**" && text[idx + 2] === "*") {
        i = idx + 1;
        continue;
      }
      return idx;
    }
    i = idx + 1;
  }
  return -1;
}

const URL_RE = /^https?:\/\/[^\s<>"]+/;

/**
 * Standard trailing punctuation that's almost never URL-meaningful,
 * stripped unconditionally so a URL at the end of a sentence
 * (`see https://example.com.`) doesn't eat the period.
 *
 * `)` is handled separately because it's both common in URLs
 * (Wikipedia disambiguation: `/wiki/Cusp_(astrology)`, MDN reference
 * pages: `/Window/innerWidth)`, etc.) AND a common wrapping
 * character (`see (https://example.com)`). The simple "always strip"
 * rule lops the closing paren off legitimate URLs; we walk the URL
 * backward instead and only strip `)` when there are more `)` than
 * `(` in the string, i.e. when the trailing paren is part of the
 * surrounding prose rather than the URL itself.
 */
const STD_TRAILING_PUNCT = ".,;:!?]'\"";

function trimTrailingPunct(url: string): { url: string; trailing: string } {
  let cutFromEnd = 0;
  while (cutFromEnd < url.length) {
    const idx = url.length - cutFromEnd - 1;
    const ch = url[idx];
    if (!ch) break;
    if (STD_TRAILING_PUNCT.includes(ch)) {
      cutFromEnd++;
      continue;
    }
    if (ch === ")") {
      // Count parens in the URL up to AND INCLUDING this `)`. If the
      // closes still outnumber the opens, this `)` is wrapping prose
      // (e.g. `see (https://x.com)`); strip it. Otherwise it's a
      // balanced paren that belongs to the URL, keep it and stop.
      const head = url.slice(0, idx + 1);
      let opens = 0;
      let closes = 0;
      for (const c of head) {
        if (c === "(") opens++;
        else if (c === ")") closes++;
      }
      if (closes > opens) {
        cutFromEnd++;
        continue;
      }
    }
    break;
  }
  if (cutFromEnd === 0) return { url, trailing: "" };
  return {
    url: url.slice(0, -cutFromEnd),
    trailing: url.slice(-cutFromEnd),
  };
}

/**
 * HTML-tag aliases for chat formatting. A small allow-list of inline
 * tags that double as synonyms for the existing markdown, lets users
 * coming from phpMyChat / older HTML-based chats format the way they're
 * already used to. The mapping is intentionally narrow: only inline
 * text-style tags that have a markdown equivalent (or a clear
 * accessibility need, like <u>).
 *
 * Implementation contract:
 *   - Recognized at the same level as markdown tokens (see `tryToken`).
 *   - Tag matching is case-insensitive (<b>, <B>, <Bold> wouldn't match
 *     since "bold" isn't in the table, only the listed names).
 *   - Inner content is recursed through `parseInline` so nested
 *     formatting works regardless of syntax mix:
 *       `<b>**italic**</b>` → bold containing italic
 *       `**<i>both</i>**`   → bold containing italic
 *   - Unmatched / unknown tags fall through as plain text. They're
 *     never rendered as raw HTML. Output is still a React tree,
 *     `dangerouslySetInnerHTML` is not used.
 *   - Attributes on the opening tag are deliberately not parsed. A
 *     pasted `<b class="foo">` falls through as text; if the writer
 *     wants styling, the profile bio sanitizer is the right surface.
 */
const HTML_TAG_ALIASES: Record<string, (children: ReactNode[]) => ReactNode> = {
  b: (c) => <strong>{c}</strong>,
  strong: (c) => <strong>{c}</strong>,
  i: (c) => <em>{c}</em>,
  em: (c) => <em>{c}</em>,
  u: (c) => <u>{c}</u>,
  s: (c) => <s>{c}</s>,
  strike: (c) => <s>{c}</s>,
  del: (c) => <s>{c}</s>,
  code: (c) => (
    <code className="rounded bg-keep-panel/60 px-1 font-mono text-[0.95em]">{c}</code>
  ),
};

const HTML_OPEN_RE = /^<([a-zA-Z]+)>/;
/** Opener for `<font color="#rrggbb">` / `<font color='#rgb'>`. Single-
 *  attribute only, that's the one attribute users actually reach for in
 *  IRC-era HTML and it keeps the parser tiny. The color value is required
 *  and must be a 3- or 6-digit hex literal; anything else falls through
 *  to the literal-text path. */
const FONT_OPEN_RE = /^<font\s+color\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>/i;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

/** Opener for `<span style="...">`, single `style` attribute (quoted). The
 *  declarations are sanitized to a safe whitelist below before they reach a
 *  real `style` object — see `sanitizeChatStyle`. */
const SPAN_STYLE_OPEN_RE = /^<span\s+style\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>/i;

/**
 * CSS properties a user's `<span style>` in CHAT is allowed to set. This is
 * deliberately a small TEXT-STYLING whitelist. Chat is multi-user, so an
 * unrestricted inline style would let one person break everyone else's
 * layout, overlay the page (position/z-index), pull remote resources
 * (background-image: url), or run effects — none of which belong in a chat
 * line. Anything not listed here is dropped. Values are further screened by
 * `UNSAFE_STYLE_VALUE_RE`.
 */
const SAFE_CHAT_STYLE_PROPS = new Set([
  "color",
  "background-color",
  "font-weight",
  "font-style",
  "font-family",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-style",
  "text-shadow",
  "letter-spacing",
  "text-transform",
]);
/** Reject any value that loads a resource, runs an expression, or smuggles
 *  markup / another declaration. (Declarations are already split on `;`.) */
const UNSAFE_STYLE_VALUE_RE = /url\s*\(|expression|javascript:|image-set|@import|[<>{}\\]/i;

/** Parse a raw `style="..."` string into a SAFE React style object, keeping
 *  only whitelisted properties with screened values. Returns null when
 *  nothing safe survives (caller renders an unstyled span). */
function sanitizeChatStyle(raw: string): CSSProperties | null {
  const style: Record<string, string> = {};
  for (const decl of raw.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (!SAFE_CHAT_STYLE_PROPS.has(prop)) continue;
    if (!value || value.length > 120 || UNSAFE_STYLE_VALUE_RE.test(value)) continue;
    const camel = prop.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());
    style[camel] = value;
  }
  return Object.keys(style).length ? (style as CSSProperties) : null;
}

/** Self-closing `<icon src="..."/>` (or `<icon src="...">`) tag used to
 *  embed a small inline image at text-line height. Server-emitted by the
 *  `{icon}` placeholder substitution in item command templates; also
 *  available to authors who want to splice a site icon into chat. The
 *  URL gate (`ICON_URL_RE` below) is the safety contract: only same-
 *  origin `/assets/...` paths and `http(s)://` absolute URLs reach
 *  `<img src>`. `javascript:` / `data:` / `file:` schemes never match.
 *  Attributes other than `src` are deliberately ignored, there's no
 *  width/height knob; sizing is controlled by the renderer's CSS so
 *  the icon stays consistent across every place this tag appears. */
const ICON_OPEN_RE = /^<icon\s+src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>/]+))\s*\/?\s*>/i;
const ICON_URL_RE = /^(?:\/assets\/[^\s"'<>]+|https?:\/\/[^\s"'<>]+)$/i;

function tryHtmlTag(text: string, i: number, depth: number): TokenMatch | null {
  if (text[i] !== "<") return null;

  // <icon src="..."/>, inline item icon. Self-closing void element; no
  // inner content, no closing tag. URL must point at a same-origin
  // asset OR an http(s) absolute URL. Failing the URL gate falls
  // through to the literal-text path so the user sees what they typed
  // instead of a silent drop.
  const iconOpen = ICON_OPEN_RE.exec(text.slice(i));
  if (iconOpen) {
    const raw = (iconOpen[1] ?? iconOpen[2] ?? iconOpen[3] ?? "").trim();
    if (ICON_URL_RE.test(raw)) {
      return {
        end: i + iconOpen[0].length,
        node: (
          <img
            src={raw}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            // 1.75em renders the icon as a small inline thumbnail,
            // clearly recognizable as the actual item art rather than
            // a tiny punctuation-sized hint. align-middle keeps it
            // centered against the text baseline; the row's
            // line-height absorbs the extra height without breaking
            // single-line message rhythm.
            className="inline-block h-[1.75em] w-auto rounded-sm align-middle"
          />
        ),
      };
    }
  }

  // <font color="...">, special-cased first since the generic
  // HTML_OPEN_RE requires zero attributes and would otherwise miss it.
  const fontOpen = FONT_OPEN_RE.exec(text.slice(i));
  if (fontOpen) {
    const raw = (fontOpen[1] ?? fontOpen[2] ?? fontOpen[3] ?? "").trim();
    if (!HEX_COLOR_RE.test(raw)) return null;
    const openLen = fontOpen[0].length;
    const closeRe = /<\/font\s*>/i;
    const rest = text.slice(i + openLen);
    const closeMatch = closeRe.exec(rest);
    if (!closeMatch) return null;
    const closeStart = i + openLen + closeMatch.index;
    const closeEnd = closeStart + closeMatch[0].length;
    const inner = text.slice(i + openLen, closeStart);
    return {
      end: closeEnd,
      node: <span style={{ color: raw }}>{parseInline(inner, depth + 1)}</span>,
    };
  }

  // <span style="..."> — honored with the SAFE whitelist only (see
  // sanitizeChatStyle). Arbitrary CSS is intentionally NOT applied. When no
  // safe declarations survive we still render the inner content (unstyled)
  // so the text isn't dropped.
  const spanStyle = SPAN_STYLE_OPEN_RE.exec(text.slice(i));
  if (spanStyle) {
    const openLen = spanStyle[0].length;
    const closeRe = /<\/span\s*>/i;
    const rest = text.slice(i + openLen);
    const closeMatch = closeRe.exec(rest);
    if (!closeMatch) return null;
    const closeStart = i + openLen + closeMatch.index;
    const closeEnd = closeStart + closeMatch[0].length;
    const inner = text.slice(i + openLen, closeStart);
    const style = sanitizeChatStyle(spanStyle[1] ?? spanStyle[2] ?? "");
    return {
      end: closeEnd,
      node: style
        ? <span style={style}>{parseInline(inner, depth + 1)}</span>
        : <span>{parseInline(inner, depth + 1)}</span>,
    };
  }

  const open = HTML_OPEN_RE.exec(text.slice(i));
  if (!open) return null;
  const tag = open[1]!.toLowerCase();
  const render = HTML_TAG_ALIASES[tag];
  if (!render) return null;
  const openLen = open[0].length;
  // Case-insensitive close-tag search. Without the `i` flag a user who
  // typed `<B>...</b>` (mixed case) would land on a parse miss and
  // their formatting would render as raw text.
  const closeRe = new RegExp(`</${tag}>`, "i");
  const rest = text.slice(i + openLen);
  const closeMatch = closeRe.exec(rest);
  if (!closeMatch) return null;
  const closeStart = i + openLen + closeMatch.index;
  const closeEnd = closeStart + closeMatch[0].length;
  const inner = text.slice(i + openLen, closeStart);
  return {
    end: closeEnd,
    node: render(parseInline(inner, depth + 1)),
  };
}

/**
 * Sticky regex matching a single Unicode emoji "grapheme", a base
 * pictographic codepoint, optionally followed by a variation selector
 * (U+FE0F) or skin-tone modifier, optionally extended with any number
 * of ZWJ continuation segments. Covers single emoji (😀), variation-
 * selected presentation (#\uFE0F⃣ → `#` + VS16), skin-toned (👍🏽), and ZWJ
 * sequences (👨\u200D👩\u200D👧 → family).
 *
 * Sticky `y` flag lets tryToken anchor the match at the current
 * cursor without slicing the input, set `lastIndex = i` and call
 * `exec` once. Module-scoped so we don't re-compile per call.
 */
const EMOJI_AT_RE =
  /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/uy;

/**
 * Markdown-significant characters that a leading backslash can escape.
 * Covers every delimiter `tryToken` would otherwise consume, asterisk,
 * underscore, tilde, pipe, backtick, the link/image brackets, the HTML
 * tag opener, the `@` (mention) and `!` (inline-command / image) triggers,
 * and the backslash itself (so users can type a literal `\` without it
 * being read as the start of an escape). This is what lets old-school
 * IRC-style actions like `\*boinks Kaal\*` survive into the rendered line
 * with their asterisks intact.
 *
 * `@` and `!` only matter when this renderer is the one reading them
 * (e.g. messenger DMs, where there's no upstream mention/command pass);
 * for chat and forum bodies, `splitMentions` and the server-side inline-
 * command expander honor the same escapes before this code runs and
 * already strip the leading backslash. Including them here keeps the
 * escape contract uniform across every surface.
 */
const MD_ESCAPABLE = new Set("*_~|`[]()!<>\\@");

function tryToken(text: string, i: number, depth: number): TokenMatch | null {
  // Verified inline command, wins over everything else so the ✓
  // tooltip stays attached to authentic server output. The marker uses
  // U+2063 + U+27E6/U+27E7 brackets (see packages/shared/src/inlineMark.ts);
  // the strip-before-expand pass on the server ensures the only way
  // these characters reach the renderer is through `expandInlineCommands`.
  if (text.charCodeAt(i) === 0x2063) {
    // Anchor the marker regex at this position by slicing and resetting
    // lastIndex; matchAll's iterator is fine but exec is cheaper for a
    // single attempt.
    VMARK_SPAN_RE.lastIndex = 0;
    const m = VMARK_SPAN_RE.exec(text.slice(i));
    if (m && m.index === 0) {
      const name = m.groups?.name ?? "cmd";
      const content = m.groups?.content ?? "";
      // Optional CSS + color payloads: URI-encoded on the wire (so the
      // `|` separator and `⟧` close-bracket can never appear inside
      // either value). decodeURIComponent can throw on a malformed
      // payload (an inline marker the user managed to forge before the
      // server's strip pass, or a corrupt round-trip); fall back to
      // null in that case rather than losing the whole verified span.
      let css: string | null = null;
      const rawCss = m.groups?.css;
      if (rawCss) {
        try { css = decodeURIComponent(rawCss); }
        catch { css = null; }
      }
      let color: string | null = null;
      const rawColor = m.groups?.color;
      if (rawColor) {
        try { color = decodeURIComponent(rawColor); }
        catch { color = null; }
      }
      return {
        end: i + m[0].length,
        node: (
          <VerifiedInline cmd={name} css={css} color={color}>
            {parseInline(content, depth + 1)}
          </VerifiedInline>
        ),
      };
    }
  }

  // Resolved <check> / <roll> block. A self-contained marker the server
  // minted from a `<check>…</check>` or `<roll:NdM:DC>…</roll>` block
  // (see packages/shared/src/dynamicCheck.ts). It opens with the same
  // U+2063 separator as the verification marker but carries the `chk:`
  // tag, so VMARK_SPAN_RE above won't have matched it. Decoded into a
  // collapsible Pass/Fail card. Like /roll output, the result is
  // authoritative, the client only renders, never re-rolls.
  if (text.charCodeAt(i) === 0x2063) {
    CHK_SPAN_RE.lastIndex = 0;
    const m = CHK_SPAN_RE.exec(text.slice(i));
    if (m && m.index === 0) {
      const data = decodeCheckMarker(m[1] ?? "");
      if (data) {
        return {
          end: i + m[0].length,
          node: <CheckResultBlock data={data} depth={depth} />,
        };
      }
    }
  }

  // UI route shortcut chip, `{token}` patterns like `{rules}`,
  // `{modal:earning}`, `{scriptorium:latest}` get replaced with a
  // small clickable chip that dispatches a `tk:open-ui-route` event
  // the chat shell listens for. Unknown tokens (anything matching the
  // bracket+letter shape but not in the catalog) fall through to the
  // literal text path so legitimate roleplay usage of `{nervously}` /
  // `{stage direction}` stays untouched. The author-role gate already
  // ran server-side, so by the time we're rendering we trust the
  // viewer can see whatever made it onto the wire.
  if (text[i] === "{") {
    const m = /^\{([a-z][a-z0-9-]*(?::[a-z0-9-]+)*)\}/i.exec(text.slice(i));
    if (m) {
      const token = m[1]!.toLowerCase();
      const entry = resolveUiRoute(token);
      if (entry) {
        return {
          end: i + m[0].length,
          node: <UiRouteChip entry={entry} />,
        };
      }
    }
  }

  // Backslash escape: `\X` where X is a markdown-special char renders
  // as the literal X with the backslash itself stripped. Highest-
  // priority check (after the verification marker) so an escape always
  // wins over the matching delimiter's normal interpretation,
  // regardless of context (italic, bold, code, etc.). A lone trailing
  // backslash falls through and renders as itself via the plain-text
  // path.
  if (text[i] === "\\") {
    const next = text[i + 1];
    if (next && MD_ESCAPABLE.has(next)) {
      return { end: i + 2, node: next };
    }
  }

  // Check HTML tag aliases before markdown tokens. Cheap (single-char
  // discriminator on `<`) and lets `<b>x</b>` win over any markdown
  // delimiter that happens to be inside it.
  const htmlMatch = tryHtmlTag(text, i, depth);
  if (htmlMatch) return htmlMatch;

  // Inline emoticon token: `:slug:idx:`, produced by the emoticon
  // picker button when the user inserts a sprite into a message body.
  // The slug must start with a letter (rules out `:42:end:` ratios
  // and the like); the idx is plain digits. Looked up at render time
  // against the emoticon store so a missing sheet falls back to the
  // literal text rather than a broken image.
  if (text[i] === ":") {
    const m = /^:([a-z][a-z0-9_-]*):(\d+):/.exec(text.slice(i));
    if (m) {
      const slug = m[1]!;
      const idx = parseInt(m[2]!, 10);
      return {
        end: i + m[0].length,
        node: <InlineEmoticon slug={slug} cellIndex={idx} />,
      };
    }
  }

  // Inline Unicode emoji, wrap a base pictographic codepoint
  // (plus any variation selector / skin-tone modifier / ZWJ
  // continuation segments) in a hover-zoom span so users can read
  // the glyph at a larger size without copying it out. Mirrors the
  // sticker `.inline-emoticon` hover affordance for parity between
  // the two emoji surfaces.
  //
  // Cheap-reject the ASCII fast path before running the unicode
  // regex: all interesting emoji sit at codepoint >= U+2000, so
  // anything below that is just text and skips the test entirely.
  const code = text.codePointAt(i);
  if (code !== undefined && code >= 0x2000) {
    EMOJI_AT_RE.lastIndex = i;
    const em = EMOJI_AT_RE.exec(text);
    if (em && em.index === i && em[0].length > 0) {
      return {
        end: i + em[0].length,
        node: <InlineEmoji glyph={em[0]} />,
      };
    }
  }

  const ch = text[i];
  const ch2 = text[i + 1] ?? "";
  const ch3 = text[i + 2] ?? "";

  // Image: ![alt](https://url)
  if (ch === "!" && ch2 === "[") {
    const closeB = text.indexOf("]", i + 2);
    if (closeB > 0 && text[closeB + 1] === "(") {
      const closeP = text.indexOf(")", closeB + 2);
      if (closeP > 0) {
        const url = text.slice(closeB + 2, closeP).trim();
        if (/^https?:\/\//i.test(url)) {
          const alt = text.slice(i + 2, closeB);
          return {
            end: closeP + 1,
            node: <UrlOrMedia url={url} alt={alt} forceImage />,
          };
        }
      }
    }
  }

  // Link: [text](https://url)
  if (ch === "[") {
    const closeB = text.indexOf("]", i + 1);
    if (closeB > i + 1 && text[closeB + 1] === "(") {
      const closeP = text.indexOf(")", closeB + 2);
      if (closeP > 0) {
        const url = text.slice(closeB + 2, closeP).trim();
        if (/^https?:\/\//i.test(url)) {
          const label = text.slice(i + 1, closeB);
          return {
            end: closeP + 1,
            node: (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer ugc"
                className="break-all text-keep-action underline hover:text-keep-action/80"
              >
                {parseInline(label, depth + 1)}
              </a>
            ),
          };
        }
        // Composer-fill reference: [label](compose:/go <name>), emitted by
        // the `/myrooms` recreate links. Renders as a chip that dispatches a
        // DOM event the chat shell listens for, replacing the composer's
        // contents with the payload so the user can review (and tweak, e.g.
        // add a password) before sending. parseInline stays pure (no callback
        // props); the payload is deliberately restricted to a `/go ` command
        // so a hostile message can't pre-load a destructive command into
        // someone's input — the worst it can do is offer to join a room, and
        // nothing sends without the user pressing enter.
        const composeRef = /^compose:(\/go .+)$/is.exec(url);
        if (composeRef) {
          const payload = composeRef[1]!;
          const label = text.slice(i + 1, closeB);
          return {
            end: closeP + 1,
            node: (
              <button
                type="button"
                title="Tap to load this command into your message box"
                onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(
                    new CustomEvent("spire:compose-set", { detail: { text: payload } }),
                  );
                }}
                className="rounded font-medium text-keep-action underline decoration-dotted underline-offset-2 hover:text-keep-action/80"
              >
                {parseInline(label, depth + 1)}
              </button>
            ),
          };
        }
        // Quoted-post reference: [wrote:](msg:<messageId>), emitted by the
        // forum Quote button. Renders as a jump chip that dispatches a DOM
        // event; the Forums Catalog listens and scrolls/flashes the quoted
        // post. parseInline stays pure — no callback props — and the id
        // charset is locked down, so no URL ever reaches an href.
        const msgRef = /^msg:([A-Za-z0-9_-]{4,64})$/.exec(url);
        if (msgRef) {
          const messageId = msgRef[1]!;
          const label = text.slice(i + 1, closeB);
          return {
            end: closeP + 1,
            node: (
              <button
                type="button"
                data-quote-ref={messageId}
                title="Jump to the quoted post"
                onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(new CustomEvent("spire:quote-ref", { detail: { messageId } }));
                }}
                className="rounded text-keep-action underline decoration-dotted underline-offset-2 hover:text-keep-action/80"
              >
                {parseInline(label, depth + 1)}
              </button>
            ),
          };
        }
      }
    }
  }

  // Fenced code block: ```optional-lang\n...content...\n```
  //
  // Checked BEFORE the single-backtick inline rule so a triple-fence
  // isn't mistaken for three empty inline spans. Content is literal,
  // no further markdown / mention / autolink parsing happens inside.
  // The optional language hint (the run of non-newline chars after the
  // opening ```) is stripped from the rendered output but its presence
  // marks the opener as "fenced" rather than "three inline backticks
  // back-to-back."
  if (ch === "`" && ch2 === "`" && ch3 === "`") {
    const close = text.indexOf("```", i + 3);
    if (close >= i + 3) {
      // Strip the language hint that runs from `i+3` to the first
      // newline (if any). When there's no newline before the close,
      // treat the whole opener as a single-line fence.
      let contentStart = i + 3;
      const firstNl = text.indexOf("\n", contentStart);
      if (firstNl >= 0 && firstNl < close) {
        contentStart = firstNl + 1;
      }
      // Trim one trailing newline before the closing fence so the
      // rendered block doesn't carry an empty final line.
      const contentEnd = close > 0 && text[close - 1] === "\n" ? close - 1 : close;
      return {
        end: close + 3,
        node: (
          <pre className="my-1 overflow-x-auto rounded bg-keep-panel/60 px-2 py-1 font-mono text-[0.9em]">
            <code>{text.slice(contentStart, contentEnd)}</code>
          </pre>
        ),
      };
    }
  }

  // Code: `text`. Content is literal - no nested emphasis.
  if (ch === "`") {
    const close = text.indexOf("`", i + 1);
    if (close > i + 1) {
      return {
        end: close + 1,
        node: (
          <code className="rounded bg-keep-panel/60 px-1 font-mono text-[0.95em]">
            {text.slice(i + 1, close)}
          </code>
        ),
      };
    }
  }

  // Strikethrough: ~~text~~
  if (ch === "~" && ch2 === "~") {
    const close = text.indexOf("~~", i + 2);
    if (close > i + 2) {
      return {
        end: close + 2,
        node: <s>{parseInline(text.slice(i + 2, close), depth + 1)}</s>,
      };
    }
  }

  // Spoiler: ||hidden text||. Click to reveal. Same shape as ~~, paired
  // delimiter, no boundary rules; nested formatting inside still parses.
  if (ch === "|" && ch2 === "|") {
    const close = text.indexOf("||", i + 2);
    if (close > i + 2) {
      return {
        end: close + 2,
        node: <SpoilerSpan>{parseInline(text.slice(i + 2, close), depth + 1)}</SpoilerSpan>,
      };
    }
  }

  // ***bold-italic*** (asterisks)
  if (ch === "*" && ch2 === "*" && ch3 === "*") {
    const close = findAsteriskClose(text, i + 3, "***");
    if (close > i + 3) {
      return {
        end: close + 3,
        node: (
          <strong>
            <em>{parseInline(text.slice(i + 3, close), depth + 1)}</em>
          </strong>
        ),
      };
    }
    // No literal *** closer. CommonMark treats `***` as a SPLITTABLE
    // delimiter run, so the two mixed-closer shapes must still parse:
    //   ***bold** then rest*  → <em><strong>bold</strong> then rest</em>
    //   ***both* then rest**  → <strong><em>both</em> then rest</strong>
    // Without this, the `**` branch below swallows the third `*` into the
    // bold's content (`<strong>*bold</strong>`) and the line-spanning
    // emphasis is silently lost — the exact "title bolds but the rest of
    // the line won't italicize" report.
    const boldClose = findAsteriskClose(text, i + 3, "**");
    if (boldClose > i + 3) {
      const italicClose = findAsteriskClose(text, boldClose + 2, "*");
      if (italicClose > 0) {
        return {
          end: italicClose + 1,
          node: (
            <em>
              <strong>{parseInline(text.slice(i + 3, boldClose), depth + 1)}</strong>
              {parseInline(text.slice(boldClose + 2, italicClose), depth + 1)}
            </em>
          ),
        };
      }
    }
    const italicClose = findAsteriskClose(text, i + 3, "*");
    if (italicClose > i + 3) {
      const boldClose2 = findAsteriskClose(text, italicClose + 1, "**");
      if (boldClose2 > 0) {
        return {
          end: boldClose2 + 2,
          node: (
            <strong>
              <em>{parseInline(text.slice(i + 3, italicClose), depth + 1)}</em>
              {parseInline(text.slice(italicClose + 1, boldClose2), depth + 1)}
            </strong>
          ),
        };
      }
    }
  }

  // ___bold-italic___ (underscores, word-boundary)
  if (ch === "_" && ch2 === "_" && ch3 === "_" && isLeftBoundary(text, i)) {
    const close = findUnderscoreClose(text, i + 3, "_");
    // Must close with three underscores at a word boundary
    if (
      close > i + 3 &&
      text[close + 1] === "_" &&
      text[close + 2] === "_" &&
      isRightBoundary(text, close + 3)
    ) {
      return {
        end: close + 3,
        node: (
          <strong>
            <em>{parseInline(text.slice(i + 3, close), depth + 1)}</em>
          </strong>
        ),
      };
    }
  }

  // **bold** (asterisks)
  if (ch === "*" && ch2 === "*") {
    const close = findAsteriskClose(text, i + 2, "**");
    if (close > i + 2) {
      return {
        end: close + 2,
        node: <strong>{parseInline(text.slice(i + 2, close), depth + 1)}</strong>,
      };
    }
  }

  // __bold__ (underscores, word-boundary)
  if (ch === "_" && ch2 === "_" && isLeftBoundary(text, i)) {
    const close = findUnderscoreClose(text, i + 2, "__");
    if (close > i + 2 && isRightBoundary(text, close + 2)) {
      return {
        end: close + 2,
        node: <strong>{parseInline(text.slice(i + 2, close), depth + 1)}</strong>,
      };
    }
  }

  // *italic* (asterisks). Reject `* x` (whitespace right after opener).
  if (ch === "*" && ch2 !== "*" && /\S/.test(ch2)) {
    const close = findAsteriskClose(text, i + 1, "*");
    if (close > i + 1) {
      return {
        end: close + 1,
        node: <em>{parseInline(text.slice(i + 1, close), depth + 1)}</em>,
      };
    }
  }

  // _italic_ (underscores, word-boundary on both sides).
  if (ch === "_" && ch2 !== "_" && /\S/.test(ch2) && isLeftBoundary(text, i)) {
    const close = findUnderscoreClose(text, i + 1, "_");
    if (close > i + 1 && isRightBoundary(text, close + 1)) {
      return {
        end: close + 1,
        node: <em>{parseInline(text.slice(i + 1, close), depth + 1)}</em>,
      };
    }
  }

  // Autolink: bare http(s)://... at a word boundary
  if ((ch === "h" || ch === "H") && (i === 0 || !isWordChar(text[i - 1]))) {
    const tail = text.slice(i);
    const m = URL_RE.exec(tail);
    if (m) {
      const { url, trailing } = trimTrailingPunct(m[0]);
      // Reserve the trailing punct as a separate text node - it falls back
      // to the normal text-flush path because we only consume `url` here.
      return {
        end: i + url.length,
        node: <UrlOrMedia url={url} />,
        // (`trailing` is intentionally NOT consumed; the outer parseInline
        // loop emits it as plain text after the autolink.)
      };
    }
  }

  return null;
}

/**
 * Recursive descent parser. Walks `text` once, trying tokens at each
 * position; falls back to plain-text on no match. `depth` caps recursion
 * so deeply nested emphasis can't blow the stack.
 */
export function parseInline(text: string, depth: number = 0): ReactNode[] {
  if (!text) return [];
  if (depth > MAX_DEPTH) return [text];

  const out: ReactNode[] = [];
  let i = 0;
  let textStart = 0;
  let nodeIdx = 0;

  while (i < text.length) {
    const m = tryToken(text, i, depth);
    if (m) {
      if (textStart < i) {
        out.push(<Fragment key={`t${nodeIdx++}`}>{text.slice(textStart, i)}</Fragment>);
      }
      out.push(<Fragment key={`n${nodeIdx++}`}>{m.node}</Fragment>);
      i = m.end;
      textStart = i;
    } else {
      i++;
    }
  }
  if (textStart < text.length) {
    out.push(<Fragment key={`t${nodeIdx++}`}>{text.slice(textStart)}</Fragment>);
  }
  return out;
}

/**
 * Wrapper for a server-verified inline command expansion. The text
 * inside `children` came from `expandInlineCommands` on the server (the
 * marker is stripped from user input before expansion, so anything
 * reaching the renderer inside the verification brackets is guaranteed
 * authentic). The visible affordance is a small ✓ that appears at the
 * end of the span; the tooltip names the underlying command so a
 * reader hovering "( rolls 🎲 1d20: 12 )" sees "Verified: this came
 * from the /roll command" rather than having to take the rolling
 * player's word for it.
 *
 * The span itself doesn't change typography, the inline output should
 * read naturally with the surrounding sentence. The ✓ is rendered as
 * a faint superscript glyph after the content so it doesn't push other
 * tokens around.
 */
function VerifiedInline({
  cmd,
  css,
  color,
  children,
}: {
  cmd: string;
  /** Optional sanitized CSS declaration list to paint the body span.
   *  Already URL-decoded by parseInline; null when the command had no
   *  CSS override. Parsed into a React style object here so the same
   *  per-command palette an admin sees on the standalone `/cmd` form
   *  also fires when the command is spliced inline via `!cmd`. */
  css: string | null;
  /** Optional admin-picked color from the `/cmd` form, either a
   *  `#rrggbb` hex literal or a `theme:<slot>` token. Resolved through
   *  the same `resolveMessageColor` the standalone `cmd` kind uses, so
   *  a `theme:system` token becomes the system-slot CSS variable on
   *  both surfaces and a stored hex gets the legibility nudge against
   *  the viewer's theme bg. Null when the admin left the color unset
   *  (chip inherits the surrounding chat line's color, same as the
   *  standalone form would). */
  color: string | null;
  children: ReactNode;
}) {
  // Read the viewer's theme so an admin-picked color inside the CSS
  // gets legibility-nudged the same way per-user chat colors do.
  // Subtle: the verification ring (`bg-keep-system-100/40`) already
  // tints the surrounding span, but the body text underneath still
  // needs to contrast with the chat's main background, which is
  // approximately `theme.bg`.
  const themeBg = useActiveTheme().bg;
  const inlineStyle = customCmdCssToStyle(css, themeBg);
  const resolvedColor = resolveMessageColor(color, themeBg);
  // The color slot wins over any `color` declaration the user CSS
  // might have set, `color` is the admin's explicit "this command is
  // this color" pick, while `css` is the broader style declaration;
  // an admin who set both intends the color slot to take precedence
  // on each render path the same way the standalone form does.
  const finalStyle = resolvedColor
    ? { ...(inlineStyle ?? {}), color: resolvedColor }
    : inlineStyle;
  return (
    <span
      className="rounded bg-keep-system-100/40 px-0.5 ring-1 ring-inset ring-keep-system/40"
      title={`Verified: ran the /${cmd} command`}
      style={finalStyle ?? undefined}
    >
      {children}
      <span aria-hidden className="ml-0.5 align-super text-[0.7em] text-keep-system">✓</span>
      <span className="sr-only"> (verified /{cmd} output)</span>
    </span>
  );
}

/* Pass/Fail accent colors for the check card. Raw "r g b" triplets so
 * they compose into `rgb(... / a)` for tints at any opacity. Emerald /
 * rose, chosen to read as "good / bad" across every theme background
 * without depending on a theme slot. */
const CHK_PASS_RGB = "16 185 129";
const CHK_FAIL_RGB = "244 63 94";

/**
 * Rendered form of a resolved `<check>` / `<roll>` block. Shows a verdict
 * chip (the server's authoritative outcome + the mechanical detail line)
 * above two collapsible branches, "Pass" and "Fail". The winning branch
 * is auto-expanded and tinted with its accent color; the losing branch is
 * collapsed and, when opened, rendered at reduced emphasis so the actual
 * outcome stays visually dominant. Both branches stay independently
 * toggleable so a curious reader can peek at the road not taken.
 *
 * The block is `display:block` so it sits on its own lines like a card
 * rather than inline with the surrounding action text.
 */
function CheckResultBlock({ data, depth }: { data: CheckResultData; depth: number }) {
  const passWon = data.outcome === "pass";
  const accent = passWon ? CHK_PASS_RGB : CHK_FAIL_RGB;
  return (
    <span className="my-1 block overflow-hidden rounded-lg border border-keep-rule/60 bg-keep-panel/30 text-[0.95em]">
      {/* Verdict chip. The badge carries the accent; the detail line
          (dice math) sits beside it muted. */}
      <span
        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 py-1.5"
        style={{ background: `rgb(${accent} / 0.12)` }}
      >
        <span
          className="rounded px-1.5 py-0.5 text-[0.85em] font-bold uppercase tracking-wide"
          style={{ background: `rgb(${accent} / 0.2)`, color: `rgb(${accent})` }}
        >
          {passWon ? "✓ Pass" : "✗ Fail"}
        </span>
        {data.detail ? (
          <span className="font-mono text-[0.85em] text-keep-muted">{data.detail}</span>
        ) : null}
      </span>
      {data.pass ? (
        <CheckBranch label="Pass" rgb={CHK_PASS_RGB} active={passWon} startOpen={passWon} glyph="✓">
          {parseInline(data.pass, depth + 1)}
        </CheckBranch>
      ) : null}
      {data.fail ? (
        <CheckBranch label="Fail" rgb={CHK_FAIL_RGB} active={!passWon} startOpen={!passWon} glyph="✗">
          {parseInline(data.fail, depth + 1)}
        </CheckBranch>
      ) : null}
    </span>
  );
}

/**
 * One collapsible branch of a {@link CheckResultBlock}. The active (winning)
 * branch gets a faint accent-tinted background and full-emphasis prose; the
 * inactive branch carries no tint and renders its prose at reduced opacity
 * so it reads as the alternative that didn't happen.
 */
function CheckBranch({
  label,
  rgb,
  active,
  startOpen,
  glyph,
  children,
}: {
  label: string;
  rgb: string;
  active: boolean;
  startOpen: boolean;
  glyph: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <span className="block border-t border-keep-rule/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[0.85em]"
        style={active ? { background: `rgb(${rgb} / 0.1)` } : undefined}
      >
        <span aria-hidden style={{ color: `rgb(${rgb})` }}>{glyph}</span>
        <span className={active ? "font-semibold text-keep-text" : "text-keep-muted"}>{label}</span>
        <span aria-hidden className="ml-auto text-[0.8em] text-keep-muted">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <span
          className={`block px-2.5 py-1.5 ${active ? "" : "opacity-60"}`}
          style={active ? { background: `rgb(${rgb} / 0.05)` } : undefined}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Click-to-reveal span for `||spoiler||` markdown. Renders as a muted
 * blocked-out chip until clicked; the underlying text is in the DOM so screen
 * readers and copy/paste still work, but it's visually masked. Once revealed
 * it stays revealed for that render.
 */
function SpoilerSpan({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (revealed) {
    return (
      <span
        className="rounded bg-keep-panel/50 px-1"
        title="Spoiler revealed - click to hide"
        onClick={() => setRevealed(false)}
      >
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setRevealed(true)}
      // Tailwind `[color:transparent]` zeros the text colour so the children
      // characters reserve layout space (preventing reflow on reveal) but
      // can't be read. The background covers them; selection still leaks
      // them, which is intentional - this is a courtesy mask, not a secret.
      className="rounded bg-keep-text/85 px-1 text-keep-text [color:transparent] hover:bg-keep-text/70"
      title="Spoiler - click to reveal"
    >
      {children}
    </button>
  );
}

/**
 * Block-level body renderer for forum posts. Splits the body by
 * newlines and groups consecutive lines that start with `> ` (or just
 * `>`) into a single `<blockquote>` element so quoted replies render
 * with the usual left-border / muted-bg styling. Non-quote lines
 * render inline via parseInline + the mention splitter, same as
 * before.
 *
 * Chat lines (flat-room rendering) deliberately don't use this, they
 * stay single-visual-line. Forum posts opt in via ForumPostBody.
 *
 * Why a manual pre-pass instead of upgrading parseInline:
 *   - parseInline is inline-only by design (no block-level state). It
 *     handles emphasis/code/links inside a single line.
 *   - Blockquote is block-level: groups span newlines. Adding it to
 *     parseInline would muddle the inline-vs-block contract and risk
 *     regressions in chat rendering.
 *
 * Grouping rule: any line whose first non-whitespace run is `>` is
 * part of a quote. Adjacent quote lines fuse into one blockquote;
 * the `> ` prefix (or just `>`) is stripped from each line before
 * the inline parser runs on the body.
 *
 * Quote membership is a LINE (block-level) decision, so the grouping runs
 * over the raw body lines directly — NOT over a `splitOnCode` of it. That
 * distinction matters: an INLINE `` `code` `` span sits inside a single
 * line, and splitting the body on it first used to chop a quoted line into
 * three segments ("> …or ", "`/help`", " command? …") that each re-ran the
 * quote pass — so everything after the inline code lost its `>` and spilled
 * OUT of the blockquote. Inline code is now left in place and rendered by
 * parseInline within its line's group. Only multi-line fenced ```blocks```
 * are genuinely block-level: we track the fence state so their lines (and
 * any `>` inside them) aren't reclassified as quotes, and render each fence
 * as its own segment. A stray (unclosed) ``` stays inline, matching the old
 * `splitOnCode` lenience.
 */
export function renderForumBody(
  body: string,
  onMentionClick: (name: string) => void,
  onWorldClick: (slug: string) => void,
  /**
   * Lower-cased names that identify the current viewer (master username
   * plus any active character). Mentions matching these names render
   * with a distinct "you got tagged" highlight rather than the regular
   * keep-action color. Optional, when omitted no self-detection runs.
   */
  selfNames: ReadonlyArray<string> = [],
  /**
   * Lowercased set of names known to resolve to a real profile.
   * Mentions not in this set (and not in `selfNames`) render as plain
   * text. When omitted, every mention is styled, fallback for
   * callers that don't subscribe to the mention cache.
   */
  knownMentions?: ReadonlySet<string> | null,
  /**
   * Snapshot of resolved `@id:`/`@cid:` mentions for this post. When a mention
   * chip matches one (by displayed name), clicking opens the exact identity by
   * id and the chip is always treated as known/clickable.
   */
  mentions: ReadonlyArray<MentionRef> = [],
): ReactNode {
  const out: ReactNode[] = [];
  // Block-level grouping over the RAW body lines (see the header note on
  // why we don't pre-split on inline code). Three group kinds: "quote"
  // (`>`-prefixed lines), "fence" (a closed multi-line ```block```), and
  // "normal" (everything else). Inline `` `code` `` stays within its line.
  const rawLines = body.split("\n");
  type Group = { kind: "quote" | "normal" | "fence"; lines: string[] };
  const groups: Group[] = [];
  const isFenceDelim = (l: string) => /^\s*```/.test(l);
  const pushLine = (kind: "quote" | "normal", line: string) => {
    const last = groups[groups.length - 1];
    if (last && last.kind === kind) last.lines.push(line);
    else groups.push({ kind, lines: [line] });
  };
  for (let li = 0; li < rawLines.length; li++) {
    const line = rawLines[li]!;
    if (isFenceDelim(line)) {
      // Opening fence — only when a CLOSING fence exists later; an
      // unmatched ``` stays a normal/quote line so a stray triple-backtick
      // doesn't swallow the rest of the post.
      let close = -1;
      for (let lj = li + 1; lj < rawLines.length; lj++) {
        if (isFenceDelim(rawLines[lj]!)) { close = lj; break; }
      }
      if (close !== -1) {
        groups.push({ kind: "fence", lines: rawLines.slice(li, close + 1) });
        li = close;
        continue;
      }
    }
    pushLine(/^\s*>/.test(line) ? "quote" : "normal", line);
  }
  groups.forEach((g, idx) => {
    if (g.kind === "fence") {
      // Hand the raw fence to parseInline so the same <pre>/<code> styling
      // fires whether the post is in a forum or a chat line.
      out.push(<Fragment key={`f${idx}`}>{parseInline(g.lines.join("\n"))}</Fragment>);
      return;
    }
    if (g.kind === "quote") {
      // Strip the leading `>` (and one optional following space) from
      // every line so the inner text reads cleanly. Leaves any existing
      // markdown inside the quote intact — `> **bold**` renders the bold,
      // and `> a `code` b` keeps the inline code in line.
      const stripped = g.lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n");
      const parts = splitMentions(stripped);
      out.push(
        <blockquote
          key={`q${idx}`}
          className="my-1 whitespace-pre-wrap border-l-2 border-keep-action/50 bg-keep-banner/40 px-3 py-1 text-keep-muted italic"
        >
          {renderPartsInline(parts, onMentionClick, onWorldClick, selfNames, knownMentions, mentions)}
        </blockquote>,
      );
      return;
    }
    const joined = g.lines.join("\n");
    const parts = splitMentions(joined);
    out.push(
      <Fragment key={`p${idx}`}>
        {renderPartsInline(parts, onMentionClick, onWorldClick, selfNames, knownMentions, mentions)}
      </Fragment>,
    );
  });
  return out;
}

/**
 * Internal: render the array returned by `splitMentions` into nodes.
 * Mirrors the renderer that lives in MessageList, duplicated here as
 * a lightweight helper so `renderForumBody` doesn't need a circular
 * import. The behavior is identical: text segments → parseInline,
 * mentions → button stubs, world chips → world-link buttons.
 */
function renderPartsInline(
  parts: ReturnType<typeof splitMentions>,
  onMentionClick: (name: string) => void,
  onWorldClick: (slug: string) => void,
  selfNames: ReadonlyArray<string> = [],
  knownMentions?: ReadonlySet<string> | null,
  mentions: ReadonlyArray<MentionRef> = [],
): ReactNode[] {
  // Normalize NBSP to a real space so a mention rendered with the "fake space"
  // matches a self name or a snapshot ref typed with a regular space. Shared
  // `canonicalizeNameForLookup` folds NBSP + lowercases (same fold the server
  // name lookups use), keeping self-highlight and chip resolution in lockstep.
  const norm = (s: string) => canonicalizeNameForLookup(s);
  // Lowercase + Set for O(1) per-mention lookup. Cheap to rebuild
  // per render; selfNames is typically 0–2 entries.
  const selfSet = new Set(selfNames.map(norm));
  const mentionMap = new Map(mentions.map((m) => [norm(m.name), m]));
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (p.kind === "text") {
      out.push(<Fragment key={i}>{parseInline(p.text)}</Fragment>);
    } else if (p.kind === "world-mention") {
      out.push(
        <button
          key={i}
          type="button"
          onClick={() => onWorldClick(p.slug)}
          className="rounded border border-keep-action/40 bg-keep-action/10 px-1 text-[0.95em] font-semibold text-keep-action hover:bg-keep-action/20 focus:outline-none focus:ring-1 focus:ring-keep-action"
          title={`Open the ${p.slug} world`}
        >
          @world:{p.slug}
        </button>,
      );
    } else {
      // Snapshot ref pins the exact identity (from an `@id:`/`@cid:` token):
      // click opens it by id, and a ref always counts as a known mention.
      const ref = mentionMap.get(norm(p.name));
      const isSelf = selfSet.has(norm(p.name));
      const isKnown = isSelf || !!ref || (knownMentions ? knownMentions.has(p.name) : true);
      if (!isKnown) {
        out.push(<Fragment key={i}>@{p.raw}</Fragment>);
        return;
      }
      out.push(renderMentionButton(p.raw, p.name, isSelf, ref, onMentionClick, i));
    }
  });
  return out;
}

/**
 * Render a single @user mention. When `name` matches one of the viewer's
 * identities (master username / active character, all lower-cased into
 * `selfSet`), the chip gets the "you got tagged" treatment: a light
 * variant of the theme's `system` slot for the background, with the
 * darker ramp step for the text. Otherwise it falls back to the regular
 * `keep-action` link styling.
 *
 * Implementation note: the highlighted variant uses the auto-generated
 * 5-step ramp (`keep-system-100` lighter, `keep-system-500` darker) so
 * the contrast holds across every theme without per-theme tuning.
 */
function renderMentionButton(
  raw: string,
  name: string,
  isSelf: boolean,
  ref: MentionRef | undefined,
  onMentionClick: (nameOrToken: string) => void,
  key: number | string,
): ReactNode {
  // When the mention resolved to a snapshot identity, click by its exact token
  // so the right profile opens even when a name is shared or contains spaces.
  // Otherwise fall back to the display name (legacy hand-typed mentions).
  const clickTarget = ref
    ? (ref.characterId ? `@cid:${ref.characterId}` : `@id:${ref.userId}`)
    : name;
  const className = isSelf
    ? "rounded bg-keep-system-100 px-1 font-semibold text-keep-system-500 ring-1 ring-keep-system/40 hover:bg-keep-system-200 focus:outline-none focus:ring-2"
    : "rounded px-0.5 font-semibold text-keep-action hover:underline focus:outline-none focus:ring-1 focus:ring-keep-action";
  return (
    <button
      key={key}
      type="button"
      onClick={() => onMentionClick(clickTarget)}
      className={className}
      title={isSelf ? `You were mentioned (${raw})` : `View ${raw}'s profile`}
    >
      @{raw}
    </button>
  );
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:\?[^\s]*)?(?:#[^\s]*)?$/i;

/**
 * Known image-CDN subdomains where every URL serves a direct media
 * file regardless of path extension. Twitter's media CDN
 * (`pbs.twimg.com`) is the canonical example, its URLs use opaque
 * media ids with the format encoded in the query string
 * (`?format=jpg&name=small`), so the extension regex above misses
 * them entirely. Each of these subdomains is the CDN host, not the
 * main site domain (we don't want `twitter.com/user` to look like an
 * image, only `pbs.twimg.com/media/...` does).
 *
 * Matching ANY URL on these hosts as "probably an image" is safe
 * because:
 *   1. The render is opt-in, the user has to click "Show image" to
 *      load it, so a false positive just shows an inert button.
 *   2. These hosts only serve media; even if the specific path turns
 *      out to be HTML or a different content type, the <img> would
 *      simply 404 / broken-image and the chat doesn't break.
 */
const IMAGE_HOST_RE =
  /^https:\/\/(?:pbs\.twimg\.com|i\.imgur\.com|i\.redd\.it|preview\.redd\.it|media\.tenor\.com)\//i;

/**
 * Generic "image format encoded in the query string" detector. Catches
 * URLs like `https://host/media/abc?format=jpg` regardless of the
 * hostname, handy for the long tail of CDNs that hash their paths
 * but stamp the format in a query param. Mirrors the extension list
 * above so adding a new format upstream stays a one-line change.
 */
const IMAGE_QUERY_FORMAT_RE = /[?&]format=(?:png|jpe?g|gif|webp|avif)\b/i;

/**
 * "Does this URL probably point at an image we should offer to
 * preview?", three signals, any of which is enough:
 *   1. Path ends in a known image extension (most cases).
 *   2. Hostname is a known image-only CDN (Twitter media, etc.).
 *   3. Query string explicitly names an image format.
 *
 * Used by UrlOrMedia to decide whether to render the "Show image"
 * toggle next to the link. False positives cost the user nothing
 * (button is inert until clicked, then either loads or shows a
 * broken-image icon); false negatives cost the user a missed inline
 * preview, so we bias toward returning true.
 */
function looksLikeImageUrl(url: string): boolean {
  return (
    IMAGE_EXT_RE.test(url) ||
    IMAGE_HOST_RE.test(url) ||
    IMAGE_QUERY_FORMAT_RE.test(url)
  );
}

interface VideoEmbed {
  /** Which provider this URL belongs to, drives the iframe title for a11y. */
  provider: "youtube" | "vimeo";
  /**
   * The fully-formed embed URL we'll drop into the iframe `src`. Always
   * constructed from a parsed video id (and, for unlisted Vimeo videos, the
   * required hash), never the raw user URL, so an attacker can't smuggle
   * `?autoplay=1&jsapi=1&...` style payloads into the iframe by pasting a
   * crafted link.
   */
  src: string;
}

// Video ids: YouTube uses 11-char `[A-Za-z0-9_-]`, but the embed endpoint
// accepts any non-empty id, and we want to be tolerant of provider changes.
// Floor at 6 chars to reject obvious garbage like `/watch?v=a`.
const VIDEO_ID_RE = /^[\w-]{6,}$/;
const VIMEO_HASH_RE = /^[\w-]{4,}$/;

/**
 * Detect embeddable video URLs and return a sanitized embed src, or null
 * when the URL isn't a recognized video link. Mirrors `IMAGE_EXT_RE`'s role
 * in `UrlOrMedia`, gates whether the "Show video" toggle appears.
 *
 * Supported shapes:
 *   YouTube watch:   https://(www.|m.)youtube.com/watch?v=ID[&...]
 *   YouTube short:   https://youtu.be/ID[?...]
 *   YouTube shorts:  https://(www.)youtube.com/shorts/ID[?...]
 *   YouTube embed:   https://(www.)youtube.com/embed/ID[?...]
 *   Vimeo:           https://vimeo.com/ID[/HASH]
 *   Vimeo player:    https://player.vimeo.com/video/ID[?h=HASH...]
 *
 * Privacy: YouTube videos go through `youtube-nocookie.com` and Vimeo gets
 * `?dnt=1` so the viewer's IP/cookies aren't shared with the provider's
 * tracking pipeline beyond what's strictly needed to play the video. The
 * iframe itself only loads once the user clicks "Show video", same as the
 * existing image toggle, so a paste of `youtu.be/...` doesn't auto-ping
 * YouTube on every chat render.
 */
export function parseVideoEmbed(url: string): VideoEmbed | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^www\./, "").toLowerCase();

  // YouTube, short link form.
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0] ?? "";
    if (VIDEO_ID_RE.test(id)) {
      return { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/${id}` };
    }
    return null;
  }

  // YouTube, long-form watch / shorts / direct embed.
  if (host === "youtube.com" || host === "m.youtube.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v") ?? "";
      if (VIDEO_ID_RE.test(id)) {
        return { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/${id}` };
      }
      return null;
    }
    const shortsMatch = u.pathname.match(/^\/shorts\/([\w-]+)/);
    if (shortsMatch && VIDEO_ID_RE.test(shortsMatch[1]!)) {
      return { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/${shortsMatch[1]}` };
    }
    const embedMatch = u.pathname.match(/^\/embed\/([\w-]+)/);
    if (embedMatch && VIDEO_ID_RE.test(embedMatch[1]!)) {
      return { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/${embedMatch[1]}` };
    }
    return null;
  }

  // Vimeo, public video page (and unlisted videos that carry a hash in the
  // path after the numeric id, like vimeo.com/123456789/abcd1234).
  if (host === "vimeo.com") {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 1 && /^\d+$/.test(parts[0]!)) {
      const id = parts[0]!;
      const hash = parts[1] && VIMEO_HASH_RE.test(parts[1]) ? parts[1] : null;
      const src = hash
        ? `https://player.vimeo.com/video/${id}?h=${hash}&dnt=1`
        : `https://player.vimeo.com/video/${id}?dnt=1`;
      return { provider: "vimeo", src };
    }
    return null;
  }

  // Vimeo, direct player URL (already an embed). Rebuild from the parsed
  // id rather than passing the user URL through, so query/fragment payloads
  // can't piggy-back into the iframe src.
  if (host === "player.vimeo.com") {
    const m = u.pathname.match(/^\/video\/(\d+)/);
    if (m) {
      const id = m[1]!;
      const hash = u.searchParams.get("h");
      const src = hash && VIMEO_HASH_RE.test(hash)
        ? `https://player.vimeo.com/video/${id}?h=${hash}&dnt=1`
        : `https://player.vimeo.com/video/${id}?dnt=1`;
      return { provider: "vimeo", src };
    }
    return null;
  }

  return null;
}

/**
 * Truncate a URL to a readable display form for autolinks. The full URL
 * stays in the `href` (and in the `title` tooltip), only the visible
 * text shrinks. Right-click → "Copy link" still copies the full URL.
 *
 * Heuristic:
 *   - Below the threshold: show the URL verbatim. Most pasted links are
 *     short enough that compression adds noise.
 *   - Above the threshold: parse via the URL constructor and show
 *     `host` + an ellipsis-tailed path. The host is what users
 *     actually identify ("oh, that's a youtube link"); the path tail
 *     usually carries the slug or id that hints at the content.
 *   - On parse failure (rare, bare autolinks already pass URL_RE),
 *     fall back to a simple first-N + … + last-N truncation.
 *
 * Threshold picked at 60, fits comfortably on a 360px mobile viewport
 * in the chat font without forcing wrap, while leaving most "normal"
 * pasted URLs unshortened.
 */
const URL_DISPLAY_MAX = 60;
export function compactUrl(url: string): string {
  if (url.length <= URL_DISPLAY_MAX) return url;
  try {
    const u = new URL(url);
    const host = u.host;
    const tail = (u.pathname === "/" ? "" : u.pathname) + u.search + u.hash;
    if (!tail) return host;
    // Reserve roughly `URL_DISPLAY_MAX - host.length - 2` chars for the
    // tail (the 2 covers the leading slash + ellipsis). Floor at 12 so
    // the host name doesn't eat the whole budget on a long subdomain.
    const budget = Math.max(12, URL_DISPLAY_MAX - host.length - 2);
    if (tail.length <= budget) return host + tail;
    return host + "/…" + tail.slice(-budget);
  } catch {
    return url.slice(0, 40) + "…" + url.slice(-15);
  }
}

interface UrlOrMediaProps {
  url: string;
  /**
   * Optional alt text - supplied only by explicit `![alt](url)` markdown.
   * For bare-URL autolinks alt remains undefined and we use empty string.
   */
  alt?: string;
  /**
   * When true, treat as image regardless of file extension. Triggered by
   * `![...](...)` syntax where the user has explicitly asked for an image.
   * Suppresses video detection, the explicit syntax wins.
   */
  forceImage?: boolean;
}

/**
 * URL renderer with optional inline preview for images and embeddable
 * videos. The preview is opt-in (the "Show image" / "Show video" toggle)
 * so a paste of `youtu.be/...` or a `.png` URL doesn't immediately leak
 * the viewer's IP to whoever hosts it. For images, `referrerPolicy=
 * "no-referrer"` blocks the chat URL from leaking via Referer when the
 * image IS shown; for videos, the iframe loads `youtube-nocookie.com` /
 * `player.vimeo.com?dnt=1` so the provider's tracking surface is the
 * minimum needed to play the file.
 *
 * Image dimensions are capped via CSS (max 60vh tall, 30vw wide on md+,
 * object-contain) so a hostile or careless paster can't blow out the
 * message column with a 4k image. Video previews share the same 480px
 * desktop cap but lock to a 16:9 aspect so the iframe doesn't squash on
 * narrow viewports. We can't enforce file-byte-size client-side without
 * a proxy, so the caps are purely visual.
 *
 * Image and video detection are mutually exclusive in practice (no host
 * serves a `.png` from `youtube.com/watch?v=...`); when both somehow
 * match, image wins, mirroring the precedence in `tryToken` where
 * explicit `![alt](url)` markdown sets `forceImage`.
 */
function UrlOrMedia({ url, alt, forceImage }: UrlOrMediaProps) {
  const [shown, setShown] = useState(false);
  const looksLikeImage = forceImage || looksLikeImageUrl(url);
  // Skip video detection when the URL is already claimed by an image, saves
  // a URL-parse on every chat line, and respects `forceImage` from `![](...)`.
  const video = !looksLikeImage ? parseVideoEmbed(url) : null;
  // Only compact bare autolinks (no alt). Explicit `[label](url)` links go
  // through tryToken's [link] branch, they never reach UrlOrMedia. An
  // `![alt](image-url)` does reach here with alt set, and we leave the alt
  // text alone since the author chose it deliberately.
  const display = alt || compactUrl(url);
  const isCompacted = !alt && display !== url;

  const link = (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer ugc"
      className="break-all text-keep-action underline hover:text-keep-action/80"
      title={isCompacted ? url : undefined}
    >
      {display}
    </a>
  );

  if (!looksLikeImage && !video) return link;

  const buttonLabel = shown ? "Hide" : looksLikeImage ? "Show image" : "Show video";
  const buttonTitle = shown
    ? "Hide the inline preview"
    : looksLikeImage
      ? "Load and display this image inline"
      : "Load and play this video inline";

  return (
    <span>
      {link}{" "}
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        className="rounded border border-keep-rule bg-keep-panel/60 px-1.5 py-0 text-[10px] uppercase tracking-widest text-keep-muted hover:bg-keep-panel hover:text-keep-text"
        title={buttonTitle}
      >
        {buttonLabel}
      </button>
      {shown && looksLikeImage ? (
        // `md-inline-media` is a layout hook (no styles of its own): the
        // chat row uses it to indent the embed into line with an
        // OpenGraph card when one is present, see MessageList.
        <span className="md-inline-media mt-1 block">
          {/*
            Viewport-relative cap: 95% of the screen width on mobile so
            a portrait image isn't pushed off the gutter, narrowing to
            30% of the viewport on md+ so a single image can't dominate
            the chat column. `max-h-` is in vh units for the same
            "always fits on screen without scrolling the whole image"
            posture. object-contain keeps the natural aspect ratio
            inside whichever cap binds first.

            LazyMediaEmbed adds IntersectionObserver-based detach when
            the image scrolls far enough off-screen so a long chat
            log with many shown images doesn't hold every decoded
            bitmap in memory. The placeholder keeps the same size so
            the scroll buffer doesn't reflow on attach/detach.
          */}
          <LazyMediaEmbed
            kind="img"
            src={url}
            alt={alt ?? ""}
            className="block max-h-[60vh] max-w-[95vw] rounded border border-keep-rule object-contain md:max-w-[30vw]"
            placeholderLabel="image (offscreen)"
          />
        </span>
      ) : null}
      {shown && video ? (
        // Sizing rules per device/orientation:
        //   - Phone in portrait: `w-full` fills the chat column (which
        //     is the screen). Full-screen-on-mobile-portrait.
        //   - Phone in landscape: cap at 854px (16:9 → 480p height).
        //     `max-md:landscape:` scopes this to below-md + landscape
        //     so it doesn't also catch iPads in landscape.
        //   - Desktop / tablet: cap at 1280px (16:9 → 720p height).
        <span className="md-inline-media mt-1 block w-full max-md:landscape:max-w-[854px] md:max-w-[1280px]">
          {/*
            16:9 aspect via `aspect-video` keeps the iframe shape regardless
            of how wide the chat column is. `referrerPolicy=
            "strict-origin-when-cross-origin"` is the minimum YouTube /
            Vimeo accept; "no-referrer" makes the player refuse to load on
            some YouTube videos. `allowFullScreen` lets the user pop the
            video out without leaving the page.

            LazyMediaEmbed's offscreen-detach is the bigger win here,
            an autoplay YouTube iframe keeps the player running (and
            consuming CPU + bandwidth) when scrolled away unless we
            tear it down. The remount on scroll-back restarts the
            video, but the alternative (silent CPU eater) is worse.
          */}
          <LazyMediaEmbed
            kind="iframe"
            src={video.src}
            title={video.provider === "youtube" ? "YouTube video player" : "Vimeo video player"}
            iframeReferrerPolicy="strict-origin-when-cross-origin"
            iframeAllow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            iframeAllowFullScreen
            className="block aspect-video w-full rounded border border-keep-rule"
            placeholderLabel="video (offscreen)"
          />
        </span>
      ) : null}
    </span>
  );
}

/**
 * Detect "this whole message body is a single emoticon token" so
 * the message renderer can promote it to a sticker (84px) instead
 * of the inline 24px sprite. Mirrors the inline-emoticon regex in
 * parseInline above, but anchored with `$` so trailing prose (or
 * a second emoticon) opts the message OUT of sticker treatment.
 * Trim is intentional, common chat ergonomics is "hit enter on
 * a lone emoji", so trailing whitespace shouldn't disqualify.
 */
export function solitaryEmoticonToken(body: string): { slug: string; cellIndex: number } | null {
  const m = /^\s*:([a-z][a-z0-9_-]*):(\d+):\s*$/.exec(body);
  if (!m) return null;
  return { slug: m[1]!, cellIndex: parseInt(m[2]!, 10) };
}

/* =============================================================
 *  InlineEmoticon, renders a `:slug:idx:` token as the matching
 *  sprite, or falls through to the literal text when the sheet
 *  isn't in the emoticon store (admin removed it, or the sheet
 *  index hasn't loaded yet on a cold start). The component
 *  subscribes to the emoticon store so a sheet hot-swap renders
 *  through to existing message bodies without a refresh.
 * ============================================================= */
/* =============================================================
 *  UiRouteChip, inline button for `{rules}` / `{modal:earning}` /
 *  `{scriptorium:latest}` etc. The catalog entry is resolved before
 *  this component renders (the parser hands us the resolved entry)
 *  so we don't re-look-up. Click → `openUiRoute(token)` →
 *  `tk:open-ui-route` event → Chat shell's listener calls the
 *  matching modal setter.
 *
 *  Visually: a small action-tinted pill that reads like a chat
 *  callout but stays inline with surrounding prose. The icon (when
 *  declared on the catalog entry) sits before the label as a
 *  decorative glyph; aria-label uses the description so screen
 *  readers announce the destination clearly.
 * ============================================================= */
function UiRouteChip({ entry }: { entry: UiRoute }) {
  // Dynamic-resolved chips fetch their label at mount and re-render
  // with the resolved title (e.g. "Latest story" → "📖 The Hollow
  // Hour"). The static `entry.label` is the skeleton shown while the
  // fetch is in flight, and remains the fallback if the lookup
  // returns null. The fetcher is shared + memoized so multiple chips
  // on the same surface coalesce on one request.
  const [dynamicLabel, setDynamicLabel] = useState<string | null>(null);
  useEffect(() => {
    // Only chips the catalog marks dynamic resolve a live label; the
    // rest (and `random` member picks) keep their static catalog label.
    if (!dynamicMarkerFor(entry)) return;
    let cancelled = false;
    void resolveDynamicChipLabel(entry).then((label) => {
      if (!cancelled && label) setDynamicLabel(label);
    });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  const renderedLabel = dynamicLabel ?? entry.label;
  return (
    <button
      type="button"
      onClick={(e) => {
        // Prevent the click from bubbling to a parent message bubble's
        // tap-to-reveal-timestamp handler (DM bubbles, scene banners)
        //, the chip is its own interaction.
        e.stopPropagation();
        openUiRoute(entry.token);
      }}
      title={entry.description}
      aria-label={entry.description}
      className="mx-1.5 inline-flex items-center gap-1 rounded border border-keep-action/50 bg-keep-action/10 px-1 py-0 align-baseline text-[1em] text-keep-action transition hover:border-keep-action hover:bg-keep-action/20"
    >
      <UiRouteIcon name={entry.icon} />
      <span>{renderedLabel}</span>
    </button>
  );
}

function InlineEmoticon({ slug, cellIndex }: { slug: string; cellIndex: number }) {
  const sheet = useEmoticons((s) => s.sheets.find((sh) => sh.slug === slug));
  if (!sheet || cellIndex < 0 || cellIndex >= sheet.cells.length) {
    return <>{`:${slug}:${cellIndex}:`}</>;
  }
  const label = sheet.cells[cellIndex] || "";
  return (
    <span className="inline-emoticon" title={label || undefined}>
      <EmoticonSprite sheetSlug={slug} cellIndex={cellIndex} size={24} />
    </span>
  );
}

/* =============================================================
 *  InlineEmoji, wraps a Unicode emoji grapheme so the shared
 *  `.inline-emoji` CSS can apply the same hover-zoom affordance
 *  sticker emoticons get. Without this, raw Unicode emoji fell
 *  through as plain text nodes and stayed tiny + un-zoomable,
 *  which made small or detailed glyphs hard to read inline.
 * ============================================================= */
function InlineEmoji({ glyph }: { glyph: string }) {
  return (
    <span className="inline-emoji" aria-label={glyph}>
      {glyph}
    </span>
  );
}
