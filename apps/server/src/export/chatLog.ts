/**
 * Renders a room's recent messages into a self-contained, downloadable HTML
 * chat log. The whole point is to fix what copying the live feed loses:
 *   - timestamps (each line is stamped, full date + time),
 *   - WHO said it (the snapshotted display name — OOC master username OR the
 *     active character name, exactly as it was at send time),
 *   - the speaker's colour (resolved the same way the chat resolves it, so the
 *     log reads like the chat instead of a wall of blank-author text).
 *
 * The document is standalone (inline <style>, no external assets) so it opens
 * anywhere and can be archived to continue an RP later. It bakes a light OR dark
 * palette (the user picks via `/export … dark|light`) and exposes the themeable
 * `--keep-*` slots as concrete values so `theme:<slot>` colour tokens (which
 * resolve to `rgb(var(--keep-…))`) render without the live app's stylesheet.
 *
 * SECURITY: message bodies are untrusted user input and this file gets opened
 * in a browser. We do NOT reuse the shared client renderer (it builds a React
 * tree) or `markdownToHtml` (it lets arbitrary raw HTML through). Instead the
 * body is HTML-ESCAPED first, then we re-enable only what the live chat
 * renders, by a strict allow-list, so the export reads the way the chat did:
 *   - markdown emphasis: **bold**, *italic*, _italic_, ***both***, ~~strike~~
 *   - the chat's inline HTML aliases (no attributes): <b>/<strong>, <i>/<em>,
 *     <u>, <s>/<strike>/<del>, <code> — un-escaped back to a fixed safe tag set
 *   - <font color="#hex"> with a hex-validated color → a colored <span>
 *   - http(s) links: [text](url) and bare autolinks, stashed BEFORE the escape
 *     so URL characters survive, then re-inserted as already-built safe <a>
 * Anything else (other tags, attributes, javascript:/data: URLs) stays escaped
 * and renders as literal text. The only HTML that can reach the document is the
 * fixed set above.
 */
import { resolveMessageColor } from "@thekeep/shared";
import { formatDurationShort } from "@thekeep/shared";

export type ExportTheme = "light" | "dark";

/** A self-contained palette for the export document. `bg` is the page
 *  background AND the contrast target passed to `resolveMessageColor`, so hex
 *  author colours get nudged to stay legible on whichever theme was chosen.
 *  `text/muted/accent/action/system` are the themeable `--keep-*` slots as
 *  "R G B" channels (so `theme:<slot>` colour tokens resolve); the `rule*` /
 *  `tagBorder` values are the hairline borders, which must flip between
 *  white-on-dark and black-on-light to stay visible. */
interface ExportPalette {
  bg: string;
  text: string;
  muted: string;
  accent: string;
  action: string;
  system: string;
  rule: string;
  ruleStrong: string;
  tagBorder: string;
}

const PALETTES: Record<ExportTheme, ExportPalette> = {
  dark: {
    bg: "#0e0c14",
    text: "216 212 224",
    muted: "139 134 152",
    accent: "184 160 106",
    action: "201 178 122",
    system: "125 163 200",
    rule: "rgba(255,255,255,.05)",
    ruleStrong: "rgba(255,255,255,.1)",
    tagBorder: "rgba(255,255,255,.15)",
  },
  light: {
    // Warm parchment so the log keeps the app's tone on paper. Slots are
    // darkened versions of the dark palette's hues so they read on light.
    bg: "#f6f3ec",
    text: "42 39 34",
    muted: "107 100 87",
    accent: "138 102 31",
    action: "150 79 38",
    system: "47 93 138",
    rule: "rgba(0,0,0,.08)",
    ruleStrong: "rgba(0,0,0,.14)",
    tagBorder: "rgba(0,0,0,.2)",
  },
};

/** One message row, the subset of the DB row the log needs. */
export interface ExportMessageRow {
  kind: string;
  displayName: string;
  body: string;
  color: string | null;
  createdAt: number;
  toDisplayName?: string | null;
  moodSnapshot?: string | null;
  npcVoicedBy?: string | null;
}

export interface ChatLogExportOptions {
  roomName: string;
  /** Master username of whoever ran /export. */
  exportedBy: string;
  generatedAtMs: number;
  /** Clamped export window in ms (what was actually queried). */
  windowMs: number;
  /** Earliest + latest createdAt actually included (for the header range). */
  rangeStartMs: number;
  rangeEndMs: number;
  /** Minutes east of UTC for rendering wall-clock timestamps (client's tz). */
  tzMinutes: number;
  /** Chronological (oldest → newest) rows. */
  messages: ExportMessageRow[];
  /** True if the window held more than the row cap and older lines were dropped. */
  truncated: boolean;
  /** Document palette. Defaults to dark (the live chat's posture). */
  theme?: ExportTheme;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Attribute-safe escaping for a URL we drop into an `href`. Quotes/angle
 *  brackets/ampersands only — the URL is already validated to http(s). */
function escapeAttrUrl(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The chat's inline HTML aliases → the safe tag we emit. Mirrors
 *  HTML_TAG_ALIASES in the live renderer (apps/web/src/lib/markdown.tsx). */
const SAFE_INLINE_TAG: Record<string, string> = {
  b: "strong", strong: "strong",
  i: "em", em: "em",
  u: "u",
  s: "s", strike: "s", del: "s",
  code: "code",
};

/**
 * Body renderer. Re-creates the live chat's formatting for a static document
 * WITHOUT trusting raw HTML. Steps:
 *   1. Stash http(s) links ([text](url) + bare autolinks) as placeholders so
 *      their URL characters survive the escape; each is pre-rendered as a
 *      fully-escaped, scheme-validated <a>.
 *   2. HTML-escape everything else.
 *   3. Run the markdown emphasis passes (mirrors the chat's inline subset).
 *   4. Un-escape ONLY the fixed inline-tag allow-list (no attributes) and the
 *      hex-validated <font color> → <span>.
 *   5. Re-insert the stashed links.
 * Newlines survive via `white-space: pre-wrap` on the container.
 */
function renderBody(raw: string): string {
  // 1. Stash links before escaping (so URL characters survive intact). Each is
  //    keyed by an `@@LK<n>@@` sentinel that carries no markdown / HTML / escape
  //    characters, so it passes untouched through every step below and is
  //    swapped back in step 5. Any literal sentinel a user happened to type is
  //    stripped from the input first (defang) so it can't collide with a token.
  const links: string[] = [];
  const stash = (html: string): string => {
    const token = `@@LK${links.length}@@`;
    links.push(html);
    return token;
  };
  let s = raw.replace(/@@LK\d+@@/g, "");
  // Explicit markdown link: [label](http/https url).
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
    stash(`<a href="${escapeAttrUrl(url)}" target="_blank" rel="noopener noreferrer ugc">${escapeHtml(label)}</a>`),
  );
  // Quote-reference links (`[wrote:](msg:<id>)`, from the forum Quote button)
  // have no meaning in a static export - keep the label, drop the reference.
  s = s.replace(/\[([^\]\n]+)\]\(msg:[A-Za-z0-9_-]{4,64}\)/g, "$1");
  // Bare http(s) autolink at a word boundary. Sentence punctuation trailing
  // the URL is left outside the link.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"]+)/g, (_m, pre: string, rawUrl: string) => {
    const trail = /[.,;:!?)\]'"]+$/.exec(rawUrl);
    const url = trail ? rawUrl.slice(0, -trail[0].length) : rawUrl;
    const after = trail ? trail[0] : "";
    return `${pre}${stash(`<a href="${escapeAttrUrl(url)}" target="_blank" rel="noopener noreferrer ugc">${escapeHtml(url)}</a>`)}${after}`;
  });

  // 2. Escape everything that remains (the body minus the stashed links).
  s = escapeHtml(s);

  // 3. Markdown emphasis. Split `***` run BEFORE the generic bold pass (which
  //    would otherwise swallow the third `*` into the bold's content):
  //    `***Title** rest…*` → em(strong(Title) rest…). Tolerates the habitual
  //    stray space before a line-end closer, mirroring the live chat parser.
  s = s.replace(/\*\*\*([^*\n]+?)\*\*([^*\n]*?)[ \t]?\*(?=\n|$)/g, "<em><strong>$1</strong>$2</em>");
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*/g, "<em>$1</em>");
  // Loose line-end italic closer: `*…all doubt. *` (space before the final
  // asterisk). Only at line/text end, where there's no `2 * 3` ambiguity.
  s = s.replace(/\*([^*\s][^*\n]*?)[ \t]\*(?=\n|$)/g, "<em>$1 </em>");
  s = s.replace(/_([^_\s][^_\n]*?[^_\s]|[^_\s])_/g, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");

  // 4. Re-enable the chat's inline HTML tags. They were escaped in step 2, so
  //    we ONLY un-escape this fixed allow-list (no attributes) — turning e.g.
  //    `&lt;i&gt;` back into `<em>`. Everything else stays escaped.
  s = s.replace(
    /&lt;(\/?)(b|strong|i|em|u|s|strike|del|code)&gt;/gi,
    (_m, slash: string, tag: string) => `<${slash}${SAFE_INLINE_TAG[tag.toLowerCase()]}>`,
  );
  // <font color="#hex"> → colored span (hex-validated; the only attribute the
  // chat parser accepts on <font>). The escape turned `"` into `&quot;`.
  s = s.replace(
    /&lt;font\s+color\s*=\s*(?:&quot;|')?(#(?:[0-9a-fA-F]{3}){1,2})(?:&quot;|')?\s*&gt;/gi,
    (_m, hex: string) => `<span style="color:${hex}">`,
  );
  s = s.replace(/&lt;\/font\s*&gt;/gi, "</span>");

  // 5. Restore the stashed (already-safe) links.
  s = s.replace(/@@LK(\d+)@@/g, (_m, idx: string) => links[Number(idx)] ?? "");
  return s;
}

/** Wall-clock `YYYY-MM-DD HH:MM:SS` in the requested tz offset. We shift the
 *  epoch by the offset then read UTC fields, so it matches the user's chat. */
function fmtTimestamp(ms: number, tzMinutes: number): string {
  const d = new Date(ms + tzMinutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** Inline `style="color:…"` for an author/body colour, or "" for the default.
 *  `bgHex` is the document background so hex colours are nudged for legibility
 *  against the chosen theme (light vs dark). */
function colorStyle(color: string | null, bgHex: string): string {
  const resolved = resolveMessageColor(color, bgHex);
  return resolved ? ` style="color:${resolved}"` : "";
}

function moodSpan(mood: string | null | undefined): string {
  return mood ? ` <span class="mood">(${escapeHtml(mood)})</span>` : "";
}

/**
 * Render one message as a block: a small header row (timestamp + name + any
 * tags) followed by a FULL-WIDTH body block. Block layout — rather than the
 * body flowing inline after the name — is what lets long, multi-paragraph RP
 * poses use the whole column instead of being crunched into a narrow inline
 * run. Kinds map to the same shapes the live chat uses (action lines for /me,
 * muted system notices, etc.).
 */
function renderLine(m: ExportMessageRow, tzMinutes: number, bgHex: string): string {
  const ts = `<span class="ts">${fmtTimestamp(m.createdAt, tzMinutes)}</span>`;
  const cs = colorStyle(m.color, bgHex);
  const name = escapeHtml(m.displayName);
  const body = renderBody(m.body);

  switch (m.kind) {
    case "me":
      // Emote/action: "Name does something", whole body in the author colour.
      return `<div class="msg me"><div class="head">${ts}</div><div class="body action"${cs}><em>${name}${moodSpan(m.moodSnapshot)} ${body}</em></div></div>`;
    case "system":
      // No real author; muted notice (joins/leaves, clears, etc.).
      return `<div class="msg system"><div class="head">${ts}</div><div class="body">${body}</div></div>`;
    case "whisper": {
      const to = m.toDisplayName ? ` <span class="arrow">→ ${escapeHtml(m.toDisplayName)}</span>` : "";
      return `<div class="msg whisper"><div class="head">${ts} <span class="name"${cs}>${name}</span>${to} <span class="tag">whispers</span></div><div class="body">${body}</div></div>`;
    }
    case "roll":
      return `<div class="msg roll"><div class="head">${ts} <span class="name"${cs}>${name}</span> <span class="tag">rolls</span></div><div class="body">${body}</div></div>`;
    case "ooc":
      return `<div class="msg ooc"><div class="head">${ts} <span class="tag">OOC</span> <span class="name"${cs}>${name}</span></div><div class="body">${body}</div></div>`;
    case "announce":
      return `<div class="msg announce"><div class="head">${ts} <span class="tag">Announce</span></div><div class="body">${body}</div></div>`;
    case "scene":
      return `<div class="msg scene"><div class="head">${ts} <span class="tag">Scene</span></div><div class="body">${body}</div></div>`;
    case "npc": {
      const by = m.npcVoicedBy ? ` <span class="npc-by">(voiced by ${escapeHtml(m.npcVoicedBy)})</span>` : "";
      return `<div class="msg npc"><div class="head">${ts} <span class="name"${cs}>${name}</span>${by}</div><div class="body"${cs}>${body}</div></div>`;
    }
    default:
      // "say" and any future plain kind: name in the header, body below in the
      // author colour (the live chat colours the body too).
      return `<div class="msg say"><div class="head">${ts} <span class="name"${cs}>${name}</span>${moodSpan(m.moodSnapshot)}</div><div class="body"${cs}>${body}</div></div>`;
  }
}

export function buildChatLogHtml(o: ChatLogExportOptions): string {
  const pal = PALETTES[o.theme ?? "dark"];
  const lines = o.messages.map((m) => renderLine(m, o.tzMinutes, pal.bg)).join("\n");
  const rangeStart = fmtTimestamp(o.rangeStartMs, o.tzMinutes);
  const rangeEnd = fmtTimestamp(o.rangeEndMs, o.tzMinutes);
  const generated = fmtTimestamp(o.generatedAtMs, o.tzMinutes);
  const truncNote = o.truncated
    ? ` &middot; <strong>older lines omitted</strong> (5,000-message cap reached)`
    : "";
  const empty = o.messages.length === 0
    ? `<p class="empty">No messages in this window.</p>`
    : "";

  // `:root` exposes the themeable slots as concrete RGB channels so author
  // colours stored as `theme:<slot>` tokens (→ rgb(var(--keep-<slot>))) render.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.roomName)} — chat log</title>
<style>
  :root {
    --keep-text: ${pal.text};
    --keep-muted: ${pal.muted};
    --keep-accent: ${pal.accent};
    --keep-action: ${pal.action};
    --keep-system: ${pal.system};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1.25rem 4rem;
    background: ${pal.bg};
    color: rgb(var(--keep-text));
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 1200px; margin: 0 auto; }
  header { border-bottom: 1px solid ${pal.ruleStrong}; padding-bottom: 1rem; margin-bottom: 1rem; }
  header h1 { margin: 0 0 .35rem; font-size: 1.5rem; color: rgb(var(--keep-accent)); }
  header .meta { font-size: 12px; color: rgb(var(--keep-muted)); }
  /* Each message is a block: a small header row, then a full-width body so
     long multi-paragraph poses get the whole column instead of an inline run. */
  .msg { padding: 7px 0; }
  .msg + .msg { border-top: 1px solid ${pal.rule}; }
  .head {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: .45rem;
    font-size: 12px; margin-bottom: 3px;
  }
  .ts { color: rgb(var(--keep-muted)); font-variant-numeric: tabular-nums; }
  .name { font-weight: 600; font-size: 13px; }
  .mood { color: rgb(var(--keep-muted)); font-style: italic; font-weight: 400; }
  .arrow { color: rgb(var(--keep-muted)); }
  .npc-by { color: rgb(var(--keep-muted)); font-size: 11px; }
  .tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: .08em;
    color: rgb(var(--keep-muted)); border: 1px solid ${pal.tagBorder};
    border-radius: 4px; padding: 0 4px;
  }
  /* Bodies keep authored line breaks (pre-wrap) and break long unbroken
     strings (URLs) instead of overflowing. Roomy line-height for prose. */
  .body { white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; line-height: 1.6; }
  .msg.me .body { font-style: italic; color: rgb(var(--keep-action)); }
  .msg.system .body { color: rgb(var(--keep-muted)); font-style: italic; }
  .msg.whisper .body { color: rgb(var(--keep-muted)); font-style: italic; }
  .msg.ooc .body { color: rgb(var(--keep-muted)); }
  .msg.announce .body { color: rgb(var(--keep-accent)); }
  .msg.scene .body { color: rgb(var(--keep-system)); }
  .empty { color: rgb(var(--keep-muted)); font-style: italic; }
  a { color: rgb(var(--keep-accent)); }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${escapeHtml(o.roomName)}</h1>
  <div class="meta">
    Chat log &middot; exported by ${escapeHtml(o.exportedBy)} &middot; generated ${generated}<br>
    Covering the last ${formatDurationShort(o.windowMs)} &middot; ${rangeStart} → ${rangeEnd} &middot; ${o.messages.length} message${o.messages.length === 1 ? "" : "s"}${truncNote}
  </div>
</header>
${empty}${lines}
</div>
</body>
</html>`;
}
