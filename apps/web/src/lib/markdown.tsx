import { Fragment, useState, type ReactNode } from "react";
import { customCmdCssToStyle, splitOnCode, VMARK_SPAN_RE } from "@thekeep/shared";
import { splitMentions } from "./mentions.js";
import { useActiveTheme } from "./theme.js";
import { useEmoticons } from "../state/emoticons.js";
import { EmoticonSprite } from "../components/EmoticonSprite.js";
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
    if (charBefore && /\S/.test(charBefore)) {
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
const TRAILING_PUNCT_RE = /[.,;:!?)\]'"]+$/;

function trimTrailingPunct(url: string): { url: string; trailing: string } {
  const m = url.match(TRAILING_PUNCT_RE);
  if (!m) return { url, trailing: "" };
  return { url: url.slice(0, -m[0].length), trailing: m[0] };
}

/**
 * HTML-tag aliases for chat formatting. A small allow-list of inline
 * tags that double as synonyms for the existing markdown — lets users
 * coming from phpMyChat / older HTML-based chats format the way they're
 * already used to. The mapping is intentionally narrow: only inline
 * text-style tags that have a markdown equivalent (or a clear
 * accessibility need, like <u>).
 *
 * Implementation contract:
 *   - Recognized at the same level as markdown tokens (see `tryToken`).
 *   - Tag matching is case-insensitive (<b>, <B>, <Bold> wouldn't match
 *     since "bold" isn't in the table — only the listed names).
 *   - Inner content is recursed through `parseInline` so nested
 *     formatting works regardless of syntax mix:
 *       `<b>**italic**</b>` → bold containing italic
 *       `**<i>both</i>**`   → bold containing italic
 *   - Unmatched / unknown tags fall through as plain text. They're
 *     never rendered as raw HTML. Output is still a React tree —
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
 *  attribute only — that's the one attribute users actually reach for in
 *  IRC-era HTML and it keeps the parser tiny. The color value is required
 *  and must be a 3- or 6-digit hex literal; anything else falls through
 *  to the literal-text path. */
const FONT_OPEN_RE = /^<font\s+color\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>/i;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

/** Self-closing `<icon src="..."/>` (or `<icon src="...">`) tag used to
 *  embed a small inline image at text-line height. Server-emitted by the
 *  `{icon}` placeholder substitution in item command templates; also
 *  available to authors who want to splice a site icon into chat. The
 *  URL gate (`ICON_URL_RE` below) is the safety contract: only same-
 *  origin `/assets/...` paths and `http(s)://` absolute URLs reach
 *  `<img src>`. `javascript:` / `data:` / `file:` schemes never match.
 *  Attributes other than `src` are deliberately ignored — there's no
 *  width/height knob; sizing is controlled by the renderer's CSS so
 *  the icon stays consistent across every place this tag appears. */
const ICON_OPEN_RE = /^<icon\s+src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>/]+))\s*\/?\s*>/i;
const ICON_URL_RE = /^(?:\/assets\/[^\s"'<>]+|https?:\/\/[^\s"'<>]+)$/i;

function tryHtmlTag(text: string, i: number, depth: number): TokenMatch | null {
  if (text[i] !== "<") return null;

  // <icon src="..."/> — inline item icon. Self-closing void element; no
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
            // 1.75em renders the icon as a small inline thumbnail —
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

  // <font color="..."> — special-cased first since the generic
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
 * Markdown-significant characters that a leading backslash can escape.
 * Covers every delimiter `tryToken` would otherwise consume — asterisk,
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
  // Verified inline command — wins over everything else so the ✓
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
      // Optional CSS payload: URI-encoded on the wire (so the `|`
      // separator and `⟧` close-bracket can never appear inside the
      // value). decodeURIComponent can throw on a malformed payload
      // (an inline marker the user managed to forge before the server's
      // strip pass, or a corrupt round-trip); fall back to no CSS in
      // that case rather than losing the whole verified span.
      let css: string | null = null;
      const rawCss = m.groups?.css;
      if (rawCss) {
        try { css = decodeURIComponent(rawCss); }
        catch { css = null; }
      }
      return {
        end: i + m[0].length,
        node: (
          <VerifiedInline cmd={name} css={css}>
            {parseInline(content, depth + 1)}
          </VerifiedInline>
        ),
      };
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

  // Inline emoticon token: `:slug:idx:` — produced by the emoticon
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
      }
    }
  }

  // Fenced code block: ```optional-lang\n...content...\n```
  //
  // Checked BEFORE the single-backtick inline rule so a triple-fence
  // isn't mistaken for three empty inline spans. Content is literal —
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

  // Spoiler: ||hidden text||. Click to reveal. Same shape as ~~ — paired
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
 * The span itself doesn't change typography — the inline output should
 * read naturally with the surrounding sentence. The ✓ is rendered as
 * a faint superscript glyph after the content so it doesn't push other
 * tokens around.
 */
function VerifiedInline({
  cmd,
  css,
  children,
}: {
  cmd: string;
  /** Optional sanitized CSS declaration list to paint the body span.
   *  Already URL-decoded by parseInline; null when the command had no
   *  CSS override. Parsed into a React style object here so the same
   *  per-command palette an admin sees on the standalone `/cmd` form
   *  also fires when the command is spliced inline via `!cmd`. */
  css: string | null;
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
  return (
    <span
      className="rounded bg-keep-system-100/40 px-0.5 ring-1 ring-inset ring-keep-system/40"
      title={`Verified: ran the /${cmd} command`}
      style={inlineStyle ?? undefined}
    >
      {children}
      <span aria-hidden className="ml-0.5 align-super text-[0.7em] text-keep-system">✓</span>
      <span className="sr-only"> (verified /{cmd} output)</span>
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
 * Chat lines (flat-room rendering) deliberately don't use this — they
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
 * the inline parser runs on the body. Lines inside a fenced ```code```
 * block are exempt — the body is first split into code vs. text
 * regions via `splitOnCode`, and only the text regions undergo the
 * blockquote pass. This way a `> ` line inside a code snippet stays
 * literal instead of getting reclassified as a quote.
 */
export function renderForumBody(
  body: string,
  onMentionClick: (name: string) => void,
  onWorldClick: (slug: string) => void,
  /**
   * Lower-cased names that identify the current viewer (master username
   * plus any active character). Mentions matching these names render
   * with a distinct "you got tagged" highlight rather than the regular
   * keep-action color. Optional — when omitted no self-detection runs.
   */
  selfNames: ReadonlyArray<string> = [],
  /**
   * Lowercased set of names known to resolve to a real profile.
   * Mentions not in this set (and not in `selfNames`) render as plain
   * text. When omitted, every mention is styled — fallback for
   * callers that don't subscribe to the mention cache.
   */
  knownMentions?: ReadonlySet<string> | null,
): ReactNode {
  const out: ReactNode[] = [];
  splitOnCode(body).forEach((seg, segIdx) => {
    if (seg.kind === "code") {
      // Hand the raw fenced/inline snippet to parseInline so the same
      // <pre>/<code> styling fires whether the post is in a forum or a
      // chat line.
      out.push(<Fragment key={`c${segIdx}`}>{parseInline(seg.raw)}</Fragment>);
      return;
    }
    const lines = seg.raw.split("\n");
    type Group = { kind: "quote" | "normal"; lines: string[] };
    const groups: Group[] = [];
    for (const line of lines) {
      const isQuote = /^\s*>/.test(line);
      const last = groups[groups.length - 1];
      if (last && last.kind === (isQuote ? "quote" : "normal")) {
        last.lines.push(line);
      } else {
        groups.push({ kind: isQuote ? "quote" : "normal", lines: [line] });
      }
    }
    groups.forEach((g, idx) => {
      if (g.kind === "quote") {
        // Strip the leading `>` (and one optional following space) from
        // every line so the inner text reads cleanly. Leaves any
        // existing markdown inside the quote intact — `> **bold**`
        // renders the bold inside the blockquote.
        const stripped = g.lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n");
        const parts = splitMentions(stripped);
        out.push(
          <blockquote
            key={`q${segIdx}-${idx}`}
            className="my-1 whitespace-pre-wrap border-l-2 border-keep-action/50 bg-keep-banner/40 px-3 py-1 text-keep-muted italic"
          >
            {renderPartsInline(parts, onMentionClick, onWorldClick, selfNames, knownMentions)}
          </blockquote>,
        );
        return;
      }
      const joined = g.lines.join("\n");
      const parts = splitMentions(joined);
      out.push(
        <Fragment key={`p${segIdx}-${idx}`}>
          {renderPartsInline(parts, onMentionClick, onWorldClick, selfNames, knownMentions)}
        </Fragment>,
      );
    });
  });
  return out;
}

/**
 * Internal: render the array returned by `splitMentions` into nodes.
 * Mirrors the renderer that lives in MessageList — duplicated here as
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
): ReactNode[] {
  // Lowercase + Set for O(1) per-mention lookup. Cheap to rebuild
  // per render; selfNames is typically 0–2 entries.
  const selfSet = new Set(selfNames.map((n) => n.toLowerCase()));
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
      const isSelf = selfSet.has(p.name);
      const isKnown = isSelf || (knownMentions ? knownMentions.has(p.name) : true);
      if (!isKnown) {
        out.push(<Fragment key={i}>@{p.raw}</Fragment>);
        return;
      }
      out.push(renderMentionButton(p.raw, p.name, selfSet, onMentionClick, i));
    }
  });
  return out;
}

/**
 * Render a single @user mention. When `name` matches one of the viewer's
 * identities (master username / active character — all lower-cased into
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
  selfSet: ReadonlySet<string>,
  onMentionClick: (name: string) => void,
  key: number | string,
): ReactNode {
  const isSelf = selfSet.has(name);
  const className = isSelf
    ? "rounded bg-keep-system-100 px-1 font-semibold text-keep-system-500 ring-1 ring-keep-system/40 hover:bg-keep-system-200 focus:outline-none focus:ring-2"
    : "rounded px-0.5 font-semibold text-keep-action hover:underline focus:outline-none focus:ring-1 focus:ring-keep-action";
  return (
    <button
      key={key}
      type="button"
      onClick={() => onMentionClick(name)}
      className={className}
      title={isSelf ? `You were mentioned (${raw})` : `View ${raw}'s profile`}
    >
      @{raw}
    </button>
  );
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:\?[^\s]*)?(?:#[^\s]*)?$/i;

interface VideoEmbed {
  /** Which provider this URL belongs to — drives the iframe title for a11y. */
  provider: "youtube" | "vimeo";
  /**
   * The fully-formed embed URL we'll drop into the iframe `src`. Always
   * constructed from a parsed video id (and, for unlisted Vimeo videos, the
   * required hash) — never the raw user URL — so an attacker can't smuggle
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
 * in `UrlOrMedia` — gates whether the "Show video" toggle appears.
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

  // YouTube — short link form.
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0] ?? "";
    if (VIDEO_ID_RE.test(id)) {
      return { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/${id}` };
    }
    return null;
  }

  // YouTube — long-form watch / shorts / direct embed.
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

  // Vimeo — public video page (and unlisted videos that carry a hash in the
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

  // Vimeo — direct player URL (already an embed). Rebuild from the parsed
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
 * stays in the `href` (and in the `title` tooltip) — only the visible
 * text shrinks. Right-click → "Copy link" still copies the full URL.
 *
 * Heuristic:
 *   - Below the threshold: show the URL verbatim. Most pasted links are
 *     short enough that compression adds noise.
 *   - Above the threshold: parse via the URL constructor and show
 *     `host` + an ellipsis-tailed path. The host is what users
 *     actually identify ("oh, that's a youtube link"); the path tail
 *     usually carries the slug or id that hints at the content.
 *   - On parse failure (rare — bare autolinks already pass URL_RE),
 *     fall back to a simple first-N + … + last-N truncation.
 *
 * Threshold picked at 60 — fits comfortably on a 360px mobile viewport
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
   * Suppresses video detection — the explicit syntax wins.
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
  const looksLikeImage = forceImage || IMAGE_EXT_RE.test(url);
  // Skip video detection when the URL is already claimed by an image — saves
  // a URL-parse on every chat line, and respects `forceImage` from `![](...)`.
  const video = !looksLikeImage ? parseVideoEmbed(url) : null;
  // Only compact bare autolinks (no alt). Explicit `[label](url)` links go
  // through tryToken's [link] branch — they never reach UrlOrMedia. An
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
        <span className="mt-1 block">
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
        <span className="mt-1 block w-full max-w-[95vw] md:max-w-[480px]">
          {/*
            16:9 aspect via `aspect-video` keeps the iframe shape regardless
            of how wide the chat column is. `referrerPolicy=
            "strict-origin-when-cross-origin"` is the minimum YouTube /
            Vimeo accept; "no-referrer" makes the player refuse to load on
            some YouTube videos. `allowFullScreen` lets the user pop the
            video out without leaving the page.

            LazyMediaEmbed's offscreen-detach is the bigger win here —
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
 * Trim is intentional — common chat ergonomics is "hit enter on
 * a lone emoji", so trailing whitespace shouldn't disqualify.
 */
export function solitaryEmoticonToken(body: string): { slug: string; cellIndex: number } | null {
  const m = /^\s*:([a-z][a-z0-9_-]*):(\d+):\s*$/.exec(body);
  if (!m) return null;
  return { slug: m[1]!, cellIndex: parseInt(m[2]!, 10) };
}

/* =============================================================
 *  InlineEmoticon — renders a `:slug:idx:` token as the matching
 *  sprite, or falls through to the literal text when the sheet
 *  isn't in the emoticon store (admin removed it, or the sheet
 *  index hasn't loaded yet on a cold start). The component
 *  subscribes to the emoticon store so a sheet hot-swap renders
 *  through to existing message bodies without a refresh.
 * ============================================================= */
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
