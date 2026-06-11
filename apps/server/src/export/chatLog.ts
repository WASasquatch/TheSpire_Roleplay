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
 * in a browser. We do NOT reuse the shared `markdownToHtml` (it lets raw HTML
 * pass through for trusted admin input). Instead every body is HTML-escaped
 * first, then a tiny bold/italic pass runs over the already-escaped text so the
 * only tags that can appear are the <strong>/<em> we insert.
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

/**
 * Body renderer. Escapes first (XSS-safe), then applies a minimal inline pass
 * for RP emphasis: `**bold**` and `*italic*` / `_italic_`. Newlines are
 * preserved by `white-space: pre-wrap` on the container, so multi-line poses
 * survive. Nothing here can emit a tag other than <strong>/<em>.
 */
function renderBody(raw: string): string {
  let s = escapeHtml(raw);
  // Split `***` delimiter run, BEFORE the generic bold pass (which would
  // otherwise swallow the third `*` into the bold's content):
  // `***Title** rest…*` → em(strong(Title) rest…). Tolerates the habitual
  // stray space before a line-end closer, mirroring the live chat parser.
  s = s.replace(/\*\*\*([^*\n]+?)\*\*([^*\n]*?)[ \t]?\*(?=\n|$)/g, "<em><strong>$1</strong>$2</em>");
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*/g, "<em>$1</em>");
  // Loose line-end italic closer: `*…all doubt. *` (space before the final
  // asterisk). Only at line/text end, where there's no `2 * 3` ambiguity.
  s = s.replace(/\*([^*\s][^*\n]*?)[ \t]\*(?=\n|$)/g, "<em>$1 </em>");
  s = s.replace(/_([^_\s][^_\n]*?[^_\s]|[^_\s])_/g, "<em>$1</em>");
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
