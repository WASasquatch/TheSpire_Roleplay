/**
 * Code-region segmentation, shared between the server (inline-command
 * expansion) and the client (mention splitter, forum block pre-pass) so
 * "what counts as code" is decided in exactly one place. Markdown
 * interpreters that follow have to agree on which character ranges are
 * literal; doing it twice in subtly different ways was how `@name`
 * inside backticks kept rendering as a mention while the surrounding
 * `<code>` styling implied it shouldn't.
 *
 * Three flavors recognized:
 *   ```fenced```, triple-backtick fence, may span newlines. An optional
 *                  language hint after the opening ``` (until the next
 *                  newline) is part of the code segment so it round-trips
 *                  verbatim. Unmatched opener falls through as text so a
 *                  stray ``` doesn't swallow the rest of the message.
 *   `inline`    , single-backtick span, same-line only. Empty (` `` `)
 *                  and unmatched openers fall through as text.
 *   verification, server-authored inline-command output bracketed by
 *                  the U+2063 markers (see ./inlineMark.ts). Treated as
 *                  opaque for the purpose of mention extraction so the
 *                  `@name` inside "( rolls 🎲 1d20: 12 )" can't be
 *                  fragmented by a mention split. The renderer parses
 *                  the marker itself and recurses through the inner
 *                  content via its own pass.
 *
 * The fenced rule is checked first, so a triple ``` can't be mistakenly
 * tokenized as three single-backtick spans.
 *
 * Backslash escapes for the backtick itself are deliberately NOT
 * supported here, they'd add complexity for a rare case and aren't
 * part of the user-facing escape contract for mentions / commands /
 * markdown (which all rely on this utility to identify code).
 */

export interface TextSegment { kind: "text"; raw: string; }
export interface CodeSegment {
  kind: "code";
  /** Verbatim source including the backtick delimiters. */
  raw: string;
}
export type CodeMaskSegment = TextSegment | CodeSegment;

/** U+2063, the opener/closer for verification markers. Cheap fast-path
 *  check before reaching for the full {@link VMARK_SPAN_RE}. Kept here as
 *  a local constant so this module stays import-free (avoids the
 *  cross-file load order quirks the shared package has hit in the past). */
const VMARK_SEPARATOR = "⁣";

/** Inline-marker span pattern, duplicated from ./inlineMark.ts so this
 *  module has zero internal dependencies. If the bracket choice (or the
 *  optional `|encoded-css(|encoded-color)?` payload) changes in
 *  inlineMark.ts, this regex needs to follow. */
const LOCAL_VMARK_SPAN_RE =
  /⁣⟦cmd:[A-Za-z0-9_-]{1,32}(?:\|[^|⟧]*(?:\|[^⟧]*)?)?⟧⁣[\s\S]*?⁣⟦\/cmd⟧⁣/g;

export function splitOnCode(body: string): CodeMaskSegment[] {
  const out: CodeMaskSegment[] = [];
  const len = body.length;
  let i = 0;
  let textStart = 0;

  const flushText = (until: number): void => {
    if (until > textStart) {
      out.push({ kind: "text", raw: body.slice(textStart, until) });
    }
  };

  while (i < len) {
    // Verification marker, the server's strip-before-expand pass means
    // any `⁣` we see here belongs to a real expansion. Capture the
    // whole span (marker + content + closing marker) as a single code
    // segment so the downstream mention/parser passes treat it as
    // opaque.
    if (body[i] === VMARK_SEPARATOR) {
      LOCAL_VMARK_SPAN_RE.lastIndex = 0;
      const m = LOCAL_VMARK_SPAN_RE.exec(body.slice(i));
      if (m && m.index === 0) {
        flushText(i);
        out.push({ kind: "code", raw: body.slice(i, i + m[0].length) });
        i += m[0].length;
        textStart = i;
        continue;
      }
      // Stray / malformed marker, emit as text and keep scanning so
      // the user still sees the literal characters instead of a silent
      // truncation.
      i += 1;
      continue;
    }

    // Fenced ```...``` (multi-line). Match the closing ``` greedily; the
    // language hint and embedded newlines all stay inside the segment.
    if (body[i] === "`" && body[i + 1] === "`" && body[i + 2] === "`") {
      const close = body.indexOf("```", i + 3);
      if (close >= i + 3) {
        flushText(i);
        out.push({ kind: "code", raw: body.slice(i, close + 3) });
        i = close + 3;
        textStart = i;
        continue;
      }
      // Unmatched opening fence, fall through and let the rest render
      // as plain text so users see what they typed.
      i += 3;
      continue;
    }

    // Inline `code`, single-line, requires a non-empty body. A backtick
    // followed by another backtick (empty span) or a newline before the
    // close means the opener was incidental; emit it as text.
    if (body[i] === "`") {
      let j = i + 1;
      while (j < len && body[j] !== "`" && body[j] !== "\n") j++;
      if (j < len && body[j] === "`" && j > i + 1) {
        flushText(i);
        out.push({ kind: "code", raw: body.slice(i, j + 1) });
        i = j + 1;
        textStart = i;
        continue;
      }
      // No valid close on this line, leave the backtick as text and
      // resume scanning from the next character.
      i += 1;
      continue;
    }

    i += 1;
  }
  flushText(len);
  return out;
}
