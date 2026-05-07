import { Fragment, useState, type ReactNode } from "react";

/**
 * Inline markdown renderer for chat message bodies.
 *
 * GFM-flavored inline subset:
 *   **bold** / __bold__              → <strong>
 *   *italic* / _italic_              → <em>
 *   ***both*** / ___both___          → <strong><em>
 *   ~~strikethrough~~                → <s>
 *   `code`                           → <code>
 *   [text](https://url)              → <a>  (http/https only)
 *   ![alt](https://image-url)        → image with "Show image" toggle
 *   bare http(s)://url autolink      → <a>, with image toggle when the URL
 *                                       ends in a common image extension
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

function tryToken(text: string, i: number, depth: number): TokenMatch | null {
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
            node: <UrlOrImage url={url} alt={alt} forceImage />,
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
        node: <UrlOrImage url={url} />,
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

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:\?[^\s]*)?(?:#[^\s]*)?$/i;

interface UrlOrImageProps {
  url: string;
  /**
   * Optional alt text - supplied only by explicit `![alt](url)` markdown.
   * For bare-URL autolinks alt remains undefined and we use empty string.
   */
  alt?: string;
  /**
   * When true, treat as image regardless of file extension. Triggered by
   * `![...](...)` syntax where the user has explicitly asked for an image.
   */
  forceImage?: boolean;
}

/**
 * URL renderer with optional image preview. The preview is opt-in (the
 * "Show image" toggle) so a user pasting an image URL doesn't immediately
 * leak everyone's IP to whoever hosts it. `referrerPolicy="no-referrer"`
 * blocks the chat URL from leaking via Referer when the image IS shown.
 *
 * Image dimensions are capped via CSS (480×360, object-contain) so a
 * hostile or careless paster can't blow out the message column with a 4k
 * image. We can't enforce file-byte-size client-side without a proxy, so
 * the cap is purely visual.
 */
function UrlOrImage({ url, alt, forceImage }: UrlOrImageProps) {
  const [shown, setShown] = useState(false);
  const looksLikeImage = forceImage || IMAGE_EXT_RE.test(url);

  const link = (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer ugc"
      className="break-all text-keep-action underline hover:text-keep-action/80"
    >
      {alt || url}
    </a>
  );

  if (!looksLikeImage) return link;

  return (
    <span>
      {link}{" "}
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        className="rounded border border-keep-rule bg-keep-panel/60 px-1.5 py-0 text-[10px] uppercase tracking-widest text-keep-muted hover:bg-keep-panel hover:text-keep-text"
        title={shown ? "Hide the inline preview" : "Load and display this image inline"}
      >
        {shown ? "Hide" : "Show image"}
      </button>
      {shown ? (
        <span className="mt-1 block">
          <img
            src={url}
            alt={alt ?? ""}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="block max-h-[360px] max-w-[480px] rounded border border-keep-rule object-contain"
          />
        </span>
      ) : null}
    </span>
  );
}
