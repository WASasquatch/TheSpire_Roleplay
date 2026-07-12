/**
 * Composer document model + chat-markdown serializer/parser.
 *
 * The chat composer's WYSIWYG editor edits a structured document whose
 * mark set is constrained to exactly what the chat renderer
 * (apps/web/src/lib/markdown.tsx parseInline) supports. The wire format
 * is unchanged: `serializeComposerDoc` emits the same markdown a
 * textarea user would have typed, and `parseChatMarkdown` hydrates a
 * document from a stored draft / prefill using the same token grammar
 * (close-search + boundary rules ported from parseInline).
 *
 * Contracts:
 *   - Plain text (no marks) serializes byte-identically, so slash
 *     commands, identity tokens, emoticon tokens, NBSP names and
 *     leading whitespace pass through untouched.
 *   - `parse(serialize(doc))` reproduces the document for content over
 *     the supported mark set. When a span's text would collide with a
 *     markdown delimiter, the serializer falls back to the HTML alias
 *     the renderer also accepts (<b>/<i>/<s>/<code>); marks with no
 *     alias (spoiler/link) are dropped for colliding content rather
 *     than emitting a string that would re-parse differently.
 *   - No DOM: everything here must run under the node test harness.
 */

export type ComposerInlineMark =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "spoiler"
  | "code";

export interface ComposerSpan {
  text: string;
  marks?: ComposerInlineMark[];
  /** http(s) link target. */
  link?: string;
  /** #rgb / #rrggbb text color (<font color>). */
  color?: string;
}

export type ComposerLineKind = "text" | "quote" | "bullet";

export interface ComposerLine {
  kind: ComposerLineKind;
  spans: ComposerSpan[];
}

export interface ComposerDoc {
  lines: ComposerLine[];
}

const MAX_DEPTH = 8;

const MARK_ORDER: ComposerInlineMark[] = [
  "bold",
  "italic",
  "strike",
  "underline",
  "spoiler",
  "code",
];

/* =============================================================
 * Normalization + helpers
 * ============================================================= */

function sortedMarks(marks: ComposerInlineMark[] | undefined): ComposerInlineMark[] {
  if (!marks || marks.length === 0) return [];
  const seen = new Set(marks);
  return MARK_ORDER.filter((m) => seen.has(m));
}

function sameAttrs(a: ComposerSpan, b: ComposerSpan): boolean {
  if ((a.link ?? null) !== (b.link ?? null)) return false;
  if ((a.color ?? null) !== (b.color ?? null)) return false;
  const am = sortedMarks(a.marks);
  const bm = sortedMarks(b.marks);
  if (am.length !== bm.length) return false;
  for (let i = 0; i < am.length; i++) if (am[i] !== bm[i]) return false;
  return true;
}

/** Merge adjacent equal-attribute spans, drop empties, canonicalize
 *  mark order. Both sides of the round-trip tests compare normalized
 *  documents. */
export function normalizeComposerDoc(doc: ComposerDoc): ComposerDoc {
  const lines: ComposerLine[] = doc.lines.map((line) => {
    const spans: ComposerSpan[] = [];
    for (const raw of line.spans) {
      if (!raw.text) continue;
      const span: ComposerSpan = { text: raw.text };
      const marks = sortedMarks(raw.marks);
      if (marks.length) span.marks = marks;
      if (raw.link) span.link = raw.link;
      if (raw.color) span.color = raw.color;
      const prev = spans[spans.length - 1];
      if (prev && sameAttrs(prev, span)) prev.text += span.text;
      else spans.push(span);
    }
    return { kind: line.kind, spans };
  });
  return { lines: lines.length ? lines : [{ kind: "text", spans: [] }] };
}

/** The document's visible text: lines joined with \n, marks invisible.
 *  This is the coordinate space the composer popups (triggers, mention
 *  completer, emoticon typeahead, thesaurus) operate in. */
export function composerDocPlainText(doc: ComposerDoc): string {
  return doc.lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n");
}

/* =============================================================
 * Serializer (doc → chat markdown)
 * ============================================================= */

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

interface MarkInstance {
  /** Identity key, marks with payloads carry it (link URL / color). */
  key: string;
  kind: ComposerInlineMark | "link" | "color";
  payload?: string;
}

/** Priority: outermost first. Code is innermost because its content is
 *  literal; link outermost so its label carries the styling. */
const WRAP_PRIORITY: Record<string, number> = {
  link: 0,
  color: 1,
  spoiler: 2,
  bold: 3,
  italic: 4,
  strike: 5,
  underline: 6,
  code: 7,
};

function markInstancesOf(span: ComposerSpan): MarkInstance[] {
  const out: MarkInstance[] = [];
  if (span.link) out.push({ key: `link:${span.link}`, kind: "link", payload: span.link });
  if (span.color) out.push({ key: `color:${span.color}`, kind: "color", payload: span.color });
  for (const m of sortedMarks(span.marks)) out.push({ key: m, kind: m });
  out.sort((a, b) => (WRAP_PRIORITY[a.kind] ?? 99) - (WRAP_PRIORITY[b.kind] ?? 99));
  return out;
}

function spanHasMark(span: ComposerSpan, key: string): boolean {
  return markInstancesOf(span).some((m) => m.key === key);
}

/** Split whitespace off the edges of `inner` so asterisk-delimited
 *  marks never open/close against a space (parseInline's closer needs
 *  a non-space before it; NBSP counts as \s there too). The whitespace
 *  stays in the output, just outside the delimiters. */
function expelEdges(inner: string): { lead: string; core: string; trail: string } {
  const lead = /^\s*/.exec(inner)?.[0] ?? "";
  if (lead.length === inner.length) return { lead: inner, core: "", trail: "" };
  const trail = /\s*$/.exec(inner)?.[0] ?? "";
  return { lead, core: inner.slice(lead.length, inner.length - trail.length), trail };
}

function wrapMark(m: MarkInstance, inner: string): string {
  if (!inner) return inner;
  switch (m.kind) {
    case "bold": {
      const { lead, core, trail } = expelEdges(inner);
      if (!core) return inner;
      const mdSafe = !core.includes("**") && core[0] !== "*" && core[core.length - 1] !== "*";
      if (mdSafe) return `${lead}**${core}**${trail}`;
      if (!/<\/b>/i.test(core)) return `${lead}<b>${core}</b>${trail}`;
      return inner;
    }
    case "italic": {
      const { lead, core, trail } = expelEdges(inner);
      if (!core) return inner;
      const mdSafe = !core.includes("*");
      if (mdSafe) return `${lead}*${core}*${trail}`;
      if (!/<\/i>/i.test(core)) return `${lead}<i>${core}</i>${trail}`;
      return inner;
    }
    case "strike": {
      const mdSafe = !inner.includes("~~") && inner[inner.length - 1] !== "~";
      if (mdSafe) return `~~${inner}~~`;
      if (!/<\/s>/i.test(inner)) return `<s>${inner}</s>`;
      return inner;
    }
    case "underline":
      if (!/<\/u>/i.test(inner)) return `<u>${inner}</u>`;
      return inner;
    case "spoiler":
      // No HTML alias exists; colliding content keeps its text and
      // loses the mark rather than emitting a misparsing string.
      if (!inner.includes("||") && inner[inner.length - 1] !== "|") return `||${inner}||`;
      return inner;
    case "code":
      if (!inner.includes("`")) return `\`${inner}\``;
      if (!/<\/code>/i.test(inner)) return `<code>${inner}</code>`;
      return inner;
    case "link": {
      const url = m.payload ?? "";
      const ok =
        /^https?:\/\//i.test(url) &&
        !url.includes(")") &&
        !/\s/.test(url) &&
        !inner.includes("]") &&
        !inner.includes("\n");
      return ok ? `[${inner}](${url})` : inner;
    }
    case "color": {
      const color = m.payload ?? "";
      if (HEX_COLOR_RE.test(color) && !/<\/font>/i.test(inner)) {
        return `<font color="${color}">${inner}</font>`;
      }
      return inner;
    }
  }
}

function serializeSpans(spans: ComposerSpan[], applied: Set<string>): string {
  let out = "";
  let i = 0;
  while (i < spans.length) {
    const span = spans[i]!;
    const remaining = markInstancesOf(span).filter((m) => !applied.has(m.key));
    if (remaining.length === 0) {
      out += span.text;
      i++;
      continue;
    }
    // Greedy: among this span's unapplied marks, open the one whose
    // run of subsequent spans extends furthest (ties broken by the
    // fixed wrap priority, which markInstancesOf already ordered by).
    let best: MarkInstance = remaining[0]!;
    let bestRun = 0;
    for (const cand of remaining) {
      let j = i;
      while (j < spans.length && spanHasMark(spans[j]!, cand.key)) j++;
      const run = j - i;
      if (run > bestRun) {
        best = cand;
        bestRun = run;
      }
    }
    const runSpans = spans.slice(i, i + bestRun);
    // ***bold-italic*** special case: the italic child covers the whole
    // bold run exactly, and the combined core is delimiter-free.
    if (best.kind === "bold" && !applied.has("italic") && runSpans.every((s) => spanHasMark(s, "italic"))) {
      const nextApplied = new Set(applied);
      nextApplied.add("bold");
      nextApplied.add("italic");
      const inner = serializeSpans(runSpans, nextApplied);
      const { lead, core, trail } = expelEdges(inner);
      if (core && !core.includes("*")) {
        out += `${lead}***${core}***${trail}`;
        i += bestRun;
        continue;
      }
      // Fall through to the generic wrap (bold via <b>) when the
      // combined core would collide with asterisk delimiters.
    }
    const nextApplied = new Set(applied);
    nextApplied.add(best.key);
    const inner = serializeSpans(runSpans, nextApplied);
    out += wrapMark(best, inner);
    i += bestRun;
  }
  return out;
}

function linePrefix(kind: ComposerLineKind): string {
  if (kind === "quote") return "> ";
  if (kind === "bullet") return "- ";
  return "";
}

/** True when the doc is a slash-command draft: the first line's visible
 *  text starts with `/`. The command dispatcher only treats messages
 *  whose FIRST byte is `/` as commands, so the check mirrors that. */
function isCommandDoc(doc: ComposerDoc): boolean {
  const first = doc.lines[0];
  if (!first) return false;
  return (first.spans[0]?.text ?? "").startsWith("/");
}

/** Doc → wire markdown. This is what gets sent over chat:input and what
 *  the 0/4000 counter counts. */
export function serializeComposerDoc(doc: ComposerDoc): string {
  const norm = normalizeComposerDoc(doc);
  // Identity serialization for slash commands: the command pipeline must
  // receive exactly the visible text — no mark delimiters, no quote or
  // bullet prefixes — or the leading `/` stops being the first byte and
  // the command posts as plain chat.
  if (isCommandDoc(norm)) return composerDocPlainText(norm);
  return norm.lines
    .map((line) => linePrefix(line.kind) + serializeSpans(line.spans, new Set()))
    .join("\n");
}

/* =============================================================
 * Parser (chat markdown → doc)
 *
 * A structural port of parseInline's token grammar restricted to the
 * editable mark set. Everything else (emoticon tokens, emoji, images,
 * autolinks, ui-route chips, escapes, <span style>, <icon>) stays
 * literal text, which serializes back byte-identically.
 * ============================================================= */

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}

function isLeftBoundary(text: string, i: number): boolean {
  return i === 0 || !isWordChar(text[i - 1]);
}

function isRightBoundary(text: string, end: number): boolean {
  return end >= text.length || !isWordChar(text[end]);
}

function findUnderscoreClose(text: string, start: number, delim: "_" | "__"): number {
  const len = delim.length;
  let i = start;
  while (i < text.length) {
    const idx = text.indexOf(delim, i);
    if (idx < 0) return -1;
    const charBefore = text[idx - 1];
    const charAfter = text[idx + len];
    if (charBefore && /\S/.test(charBefore) && !isWordChar(charAfter)) {
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

function findAsteriskClose(text: string, start: number, delim: "*" | "**" | "***"): number {
  const len = delim.length;
  let i = start;
  while (i < text.length) {
    const idx = text.indexOf(delim, i);
    if (idx < 0) return -1;
    const charBefore = text[idx - 1];
    const looseLineEnd =
      !!charBefore && /[ \t]/.test(charBefore) &&
      (idx + len >= text.length || text[idx + len] === "\n");
    if ((charBefore && /\S/.test(charBefore)) || looseLineEnd) {
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

interface ParseCtx {
  marks: ComposerInlineMark[];
  link?: string;
  color?: string;
}

function ctxWith(ctx: ParseCtx, mark?: ComposerInlineMark, extra?: { link?: string; color?: string }): ParseCtx {
  const next: ParseCtx = { marks: mark ? [...ctx.marks, mark] : [...ctx.marks] };
  const link = extra?.link ?? ctx.link;
  const color = extra?.color ?? ctx.color;
  if (link) next.link = link;
  if (color) next.color = color;
  return next;
}

function literalSpan(text: string, ctx: ParseCtx): ComposerSpan {
  const span: ComposerSpan = { text };
  if (ctx.marks.length) span.marks = [...ctx.marks];
  if (ctx.link) span.link = ctx.link;
  if (ctx.color) span.color = ctx.color;
  return span;
}

const ALIAS_TO_MARK: Record<string, ComposerInlineMark> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  u: "underline",
  s: "strike",
  strike: "strike",
  del: "strike",
  code: "code",
};

const HTML_OPEN_RE = /^<([a-zA-Z]+)>/;
const FONT_OPEN_RE = /^<font\s+color\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>/i;

interface SpanMatch {
  end: number;
  spans: ComposerSpan[];
}

function tryHtmlToken(text: string, i: number, depth: number, ctx: ParseCtx): SpanMatch | null {
  if (text[i] !== "<") return null;
  const fontOpen = FONT_OPEN_RE.exec(text.slice(i));
  if (fontOpen) {
    const raw = (fontOpen[1] ?? fontOpen[2] ?? fontOpen[3] ?? "").trim();
    if (!HEX_COLOR_RE.test(raw)) return null;
    const openLen = fontOpen[0].length;
    const closeMatch = /<\/font\s*>/i.exec(text.slice(i + openLen));
    if (!closeMatch) return null;
    const closeStart = i + openLen + closeMatch.index;
    const inner = text.slice(i + openLen, closeStart);
    return {
      end: closeStart + closeMatch[0].length,
      spans: parseSpans(inner, depth + 1, ctxWith(ctx, undefined, { color: raw })),
    };
  }
  const open = HTML_OPEN_RE.exec(text.slice(i));
  if (!open) return null;
  const tag = open[1]!.toLowerCase();
  const mark = ALIAS_TO_MARK[tag];
  if (!mark) return null;
  const openLen = open[0].length;
  const closeMatch = new RegExp(`</${tag}>`, "i").exec(text.slice(i + openLen));
  if (!closeMatch) return null;
  const closeStart = i + openLen + closeMatch.index;
  const inner = text.slice(i + openLen, closeStart);
  return {
    end: closeStart + closeMatch[0].length,
    spans: parseSpans(inner, depth + 1, ctxWith(ctx, mark)),
  };
}

function tryToken(text: string, i: number, depth: number, ctx: ParseCtx): SpanMatch | null {
  const html = tryHtmlToken(text, i, depth, ctx);
  if (html) return html;

  const ch = text[i];
  const ch2 = text[i + 1] ?? "";
  const ch3 = text[i + 2] ?? "";

  // Link: [text](https://url). compose:/msg: chip schemes stay literal.
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
            spans: parseSpans(label, depth + 1, ctxWith(ctx, undefined, { link: url })),
          };
        }
      }
    }
  }

  // Inline code: `text`, literal content.
  if (ch === "`") {
    const close = text.indexOf("`", i + 1);
    if (close > i + 1) {
      return {
        end: close + 1,
        spans: [literalSpan(text.slice(i + 1, close), ctxWith(ctx, "code"))],
      };
    }
  }

  // Strikethrough: ~~text~~
  if (ch === "~" && ch2 === "~") {
    const close = text.indexOf("~~", i + 2);
    if (close > i + 2) {
      return {
        end: close + 2,
        spans: parseSpans(text.slice(i + 2, close), depth + 1, ctxWith(ctx, "strike")),
      };
    }
  }

  // Spoiler: ||text||
  if (ch === "|" && ch2 === "|") {
    const close = text.indexOf("||", i + 2);
    if (close > i + 2) {
      return {
        end: close + 2,
        spans: parseSpans(text.slice(i + 2, close), depth + 1, ctxWith(ctx, "spoiler")),
      };
    }
  }

  // ***bold-italic*** (+ CommonMark splittable-run mixed closers).
  if (ch === "*" && ch2 === "*" && ch3 === "*") {
    const close = findAsteriskClose(text, i + 3, "***");
    if (close > i + 3) {
      return {
        end: close + 3,
        spans: parseSpans(text.slice(i + 3, close), depth + 1, ctxWith(ctxWith(ctx, "bold"), "italic")),
      };
    }
    const boldClose = findAsteriskClose(text, i + 3, "**");
    if (boldClose > i + 3) {
      const italicClose = findAsteriskClose(text, boldClose + 2, "*");
      if (italicClose > 0) {
        return {
          end: italicClose + 1,
          spans: [
            ...parseSpans(text.slice(i + 3, boldClose), depth + 1, ctxWith(ctxWith(ctx, "italic"), "bold")),
            ...parseSpans(text.slice(boldClose + 2, italicClose), depth + 1, ctxWith(ctx, "italic")),
          ],
        };
      }
    }
    const italicClose = findAsteriskClose(text, i + 3, "*");
    if (italicClose > i + 3) {
      const boldClose2 = findAsteriskClose(text, italicClose + 1, "**");
      if (boldClose2 > 0) {
        return {
          end: boldClose2 + 2,
          spans: [
            ...parseSpans(text.slice(i + 3, italicClose), depth + 1, ctxWith(ctxWith(ctx, "bold"), "italic")),
            ...parseSpans(text.slice(italicClose + 1, boldClose2), depth + 1, ctxWith(ctx, "bold")),
          ],
        };
      }
    }
  }

  // ___bold-italic___ (underscores, word-boundary)
  if (ch === "_" && ch2 === "_" && ch3 === "_" && isLeftBoundary(text, i)) {
    const close = findUnderscoreClose(text, i + 3, "_");
    if (
      close > i + 3 &&
      text[close + 1] === "_" &&
      text[close + 2] === "_" &&
      isRightBoundary(text, close + 3)
    ) {
      return {
        end: close + 3,
        spans: parseSpans(text.slice(i + 3, close), depth + 1, ctxWith(ctxWith(ctx, "bold"), "italic")),
      };
    }
  }

  // **bold**
  if (ch === "*" && ch2 === "*") {
    const close = findAsteriskClose(text, i + 2, "**");
    if (close > i + 2) {
      return {
        end: close + 2,
        spans: parseSpans(text.slice(i + 2, close), depth + 1, ctxWith(ctx, "bold")),
      };
    }
  }

  // __bold__
  if (ch === "_" && ch2 === "_" && isLeftBoundary(text, i)) {
    const close = findUnderscoreClose(text, i + 2, "__");
    if (close > i + 2 && isRightBoundary(text, close + 2)) {
      return {
        end: close + 2,
        spans: parseSpans(text.slice(i + 2, close), depth + 1, ctxWith(ctx, "bold")),
      };
    }
  }

  // *italic*
  if (ch === "*" && ch2 !== "*" && ch2 !== "" && /\S/.test(ch2)) {
    const close = findAsteriskClose(text, i + 1, "*");
    if (close > i + 1) {
      return {
        end: close + 1,
        spans: parseSpans(text.slice(i + 1, close), depth + 1, ctxWith(ctx, "italic")),
      };
    }
  }

  // _italic_
  if (ch === "_" && ch2 !== "_" && ch2 !== "" && /\S/.test(ch2) && isLeftBoundary(text, i)) {
    const close = findUnderscoreClose(text, i + 1, "_");
    if (close > i + 1 && isRightBoundary(text, close + 1)) {
      return {
        end: close + 1,
        spans: parseSpans(text.slice(i + 1, close), depth + 1, ctxWith(ctx, "italic")),
      };
    }
  }

  return null;
}

function parseSpans(text: string, depth: number, ctx: ParseCtx): ComposerSpan[] {
  if (!text) return [];
  if (depth > MAX_DEPTH) return [literalSpan(text, ctx)];
  const out: ComposerSpan[] = [];
  let i = 0;
  let textStart = 0;
  while (i < text.length) {
    const m = tryToken(text, i, depth, ctx);
    if (m) {
      if (textStart < i) out.push(literalSpan(text.slice(textStart, i), ctx));
      out.push(...m.spans);
      i = m.end;
      textStart = i;
    } else {
      i++;
    }
  }
  if (textStart < text.length) out.push(literalSpan(text.slice(textStart), ctx));
  return out;
}

/** Wire markdown → doc. Tolerant: anything the grammar doesn't cover
 *  stays literal text. */
export function parseChatMarkdown(text: string): ComposerDoc {
  // Slash-command drafts hydrate as literal plain text (no mark or
  // line-prefix interpretation), mirroring the serializer's identity
  // rule so command bytes survive draft/history round-trips unchanged.
  if (text.startsWith("/")) {
    return normalizeComposerDoc({
      lines: text.split("\n").map((raw): ComposerLine => ({
        kind: "text",
        spans: raw ? [{ text: raw }] : [],
      })),
    });
  }
  const lines = text.split("\n").map((raw): ComposerLine => {
    if (raw === ">" || raw.startsWith("> ")) {
      return { kind: "quote", spans: parseSpans(raw === ">" ? "" : raw.slice(2), 0, { marks: [] }) };
    }
    if (raw.startsWith("- ")) {
      return { kind: "bullet", spans: parseSpans(raw.slice(2), 0, { marks: [] }) };
    }
    return { kind: "text", spans: parseSpans(raw, 0, { marks: [] }) };
  });
  return normalizeComposerDoc({ lines });
}

/* =============================================================
 * Rich-paste mapping (HTML clipboard → doc)
 *
 * Regex-walk sanitizer (no DOM, testable server-side): the HTML string
 * is reduced to the supported mark set — bold / italic / underline /
 * strike / inline code / http(s) links / bullet lines / quote lines —
 * everything else (colors, fonts, sizes, images, tables, scripts)
 * drops to plain text. Word's mso-list bullet glyph runs and Google
 * Docs' font-weight:normal <b> wrapper are special-cased so pastes
 * from both land structurally intact.
 * ============================================================= */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const num = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(num) && num > 0 && num <= 0x10ffff) {
        try {
          return String.fromCodePoint(num);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

interface PasteState {
  bold: number;
  italic: number;
  underline: number;
  strike: number;
  code: number;
  links: string[];
  quoteDepth: number;
  listDepth: number;
  /** Depth counters for content we discard entirely. */
  skipDepth: number;
  msoIgnoreDepth: number;
}

const BLOCK_TAGS = new Set([
  "p", "div", "li", "ul", "ol", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
  "tr", "table", "pre", "section", "article", "header", "footer", "aside",
]);
const SKIP_TAGS = new Set(["style", "script", "head", "title", "noscript", "template"]);

function styleOf(attrs: string): string {
  const m = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  return (m?.[1] ?? m?.[2] ?? "").toLowerCase();
}

function classOf(attrs: string): string {
  const m = /class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").toLowerCase();
}

function hrefOf(attrs: string): string | null {
  const m = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
  if (!raw) return null;
  const url = decodeEntities(raw);
  return /^https?:\/\//i.test(url) ? url : null;
}

export function htmlClipboardToComposerDoc(html: string): ComposerDoc {
  const tokens = html.match(/<!--[\s\S]*?-->|<!\[[^\]]*\]>|<[^>]*>|[^<]+/g) ?? [];
  const st: PasteState = {
    bold: 0, italic: 0, underline: 0, strike: 0, code: 0,
    links: [], quoteDepth: 0, listDepth: 0, skipDepth: 0, msoIgnoreDepth: 0,
  };
  const lines: ComposerLine[] = [];
  let spans: ComposerSpan[] = [];
  let lineKind: ComposerLineKind = "text";
  let lineOpen = false;
  // Stack of per-open-tag effects so close tags unwind exactly what
  // their opener applied, even against sloppy markup.
  const tagStack: Array<{ tag: string; undo: () => void }> = [];

  const currentKind = (): ComposerLineKind => {
    if (st.listDepth > 0) return "bullet";
    if (st.quoteDepth > 0) return "quote";
    return "text";
  };

  const flushLine = () => {
    if (!lineOpen && spans.length === 0) return;
    lines.push({ kind: lineKind, spans });
    spans = [];
    lineOpen = false;
  };

  const pushText = (raw: string) => {
    if (st.skipDepth > 0 || st.msoIgnoreDepth > 0) return;
    // HTML whitespace collapsing: runs of tabs/newlines/spaces render
    // as one space. Pure-whitespace runs between blocks (line not yet
    // started) are formatting noise, drop them.
    let text = decodeEntities(raw).replace(/[\t\r\n ]+/g, " ");
    if (!text) return;
    if (!lineOpen && !text.trim()) return;
    if (!lineOpen) {
      text = text.replace(/^ +/, "");
      if (!text) return;
      lineKind = currentKind();
      lineOpen = true;
    }
    const span: ComposerSpan = { text };
    const marks: ComposerInlineMark[] = [];
    if (st.bold > 0) marks.push("bold");
    if (st.italic > 0) marks.push("italic");
    if (st.underline > 0) marks.push("underline");
    if (st.strike > 0) marks.push("strike");
    if (st.code > 0) marks.push("code");
    if (marks.length) span.marks = marks;
    const link = st.links[st.links.length - 1];
    if (link) span.link = link;
    spans.push(span);
  };

  const openEffects = (tag: string, attrs: string): (() => void) => {
    const undos: Array<() => void> = [];
    const style = styleOf(attrs);
    if (SKIP_TAGS.has(tag)) {
      st.skipDepth++;
      undos.push(() => { st.skipDepth = Math.max(0, st.skipDepth - 1); });
    }
    if (/mso-list\s*:\s*ignore/i.test(style)) {
      // Word's fake bullet glyph run ("·   ") — not content.
      st.msoIgnoreDepth++;
      undos.push(() => { st.msoIgnoreDepth = Math.max(0, st.msoIgnoreDepth - 1); });
    }
    // Inline marks. Google Docs wraps the whole clipboard in
    // <b style="font-weight:normal"> — an explicitly-normal weight on
    // a bold tag means NOT bold.
    const weightNormal = /font-weight\s*:\s*(normal|[1-4]00)\b/.test(style);
    const weightBold = /font-weight\s*:\s*(bold|bolder|[5-9]00)\b/.test(style);
    if ((tag === "b" || tag === "strong") && !weightNormal) {
      st.bold++;
      undos.push(() => { st.bold = Math.max(0, st.bold - 1); });
    } else if (weightBold) {
      st.bold++;
      undos.push(() => { st.bold = Math.max(0, st.bold - 1); });
    }
    const styleItalic = /font-style\s*:\s*(italic|oblique)/.test(style);
    if (tag === "i" || tag === "em" || styleItalic) {
      st.italic++;
      undos.push(() => { st.italic = Math.max(0, st.italic - 1); });
    }
    const deco = /text-decoration(?:-line)?\s*:\s*([^;]*)/.exec(style)?.[1] ?? "";
    if (tag === "u" || /underline/.test(deco)) {
      st.underline++;
      undos.push(() => { st.underline = Math.max(0, st.underline - 1); });
    }
    if (tag === "s" || tag === "strike" || tag === "del" || /line-through/.test(deco)) {
      st.strike++;
      undos.push(() => { st.strike = Math.max(0, st.strike - 1); });
    }
    if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") {
      st.code++;
      undos.push(() => { st.code = Math.max(0, st.code - 1); });
    }
    if (tag === "a") {
      const href = hrefOf(attrs);
      if (href) {
        st.links.push(href);
        undos.push(() => { st.links.pop(); });
      }
    }
    if (tag === "blockquote") {
      st.quoteDepth++;
      undos.push(() => { st.quoteDepth = Math.max(0, st.quoteDepth - 1); });
    }
    if (tag === "ul" || tag === "ol") {
      st.listDepth++;
      undos.push(() => { st.listDepth = Math.max(0, st.listDepth - 1); });
    }
    return () => { for (const u of undos) u(); };
  };

  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<![")) continue;
    if (token[0] === "<") {
      const m = /^<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>$/.exec(token);
      if (!m) continue;
      const closing = !!m[1];
      const tag = m[2]!.toLowerCase();
      const attrs = m[3] ?? "";
      if (!closing && tag === "br") {
        // <br> always ends the current line (even an empty one so
        // back-to-back <br><br> yields a blank line).
        if (!lineOpen) lineKind = currentKind();
        lineOpen = true;
        flushLine();
        continue;
      }
      const isBlock = BLOCK_TAGS.has(tag);
      if (!closing) {
        if (isBlock) {
          flushLine();
          // Word emits lists as MsoListParagraph <p>s, not <li>.
          if (tag === "li" || (tag === "p" && /msolistparagraph/.test(classOf(attrs)))) {
            lineKind = "bullet";
            lineOpen = true;
          } else if (tag === "p" && /mso-list\s*:/i.test(styleOf(attrs))) {
            lineKind = "bullet";
            lineOpen = true;
          } else {
            lineKind = currentKind();
          }
        }
        const selfClosing = /\/\s*>$/.test(token) || tag === "meta" || tag === "img" || tag === "hr" || tag === "input" || tag === "col" || tag === "wbr";
        const undo = openEffects(tag, attrs);
        if (selfClosing) undo();
        else tagStack.push({ tag, undo });
      } else {
        if (isBlock) flushLine();
        // Unwind to the matching open tag (tolerates mis-nesting).
        for (let k = tagStack.length - 1; k >= 0; k--) {
          if (tagStack[k]!.tag === tag) {
            for (let j = tagStack.length - 1; j >= k; j--) tagStack[j]!.undo();
            tagStack.length = k;
            break;
          }
        }
      }
    } else {
      pushText(token);
    }
  }
  flushLine();

  // Trim leading/trailing fully-empty lines (block-boundary noise).
  while (lines.length && lines[0]!.spans.length === 0) lines.shift();
  while (lines.length && lines[lines.length - 1]!.spans.length === 0) lines.pop();
  // Trailing whitespace inside each line is presentation noise from
  // source formatting; strip it off the last span of the line.
  for (const line of lines) {
    const last = line.spans[line.spans.length - 1];
    if (last) {
      last.text = last.text.replace(/ +$/, "");
      if (!last.text) line.spans.pop();
    }
  }
  return normalizeComposerDoc({ lines });
}
