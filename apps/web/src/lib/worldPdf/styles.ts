/**
 * The magazine stylesheet, generated per export from the world's palette.
 *
 * Three constraints shape everything here.
 *
 * 1. It is generated, not static, because the sheet has to bake the world's
 *    OWN palette in as literal colours. The page boxes are cloned into
 *    html2pdf's capture container, which hangs off `document.body`, so any
 *    rule written against `var(--keep-…)` would resolve against the READER's
 *    theme there, not the world's, and a dark world would print in the
 *    reader's parchment. (The `--theme-*` aliases still ride along inline on
 *    the root for user-authored CSS inside page bodies, which is written
 *    against those names by contract.)
 *
 * 2. Everything html2canvas cannot draw is avoided. No box-shadow (silently
 *    dropped), no filter, no backdrop-filter, no mask. Depth comes from
 *    rules, tints and gradients, all of which it renders correctly.
 *
 * 3. TEXT AND GEOMETRY ARE DRAWN BY DIFFERENT CODE PATHS, and only geometry
 *    is exact. html2canvas takes borders, backgrounds and rules straight from
 *    layout rects, but it positions text with ONE baseline offset per
 *    (font family, size), measured in `FontMetrics.parseMetrics` from integer
 *    `offsetTop` readings plus a hard-coded `+ 2` fudge, in a probe element
 *    it never assigns a `line-height` to, so the probe inherits Tailwind's
 *    `html { line-height: 1.5 }`. Text then paints at `bounds.top + baseline`.
 *
 *    Three rules follow, and breaking any of them shows up as text sliding
 *    out of its box (a clipped running head, chip labels below their pill,
 *    contents entries off their dot leaders):
 *
 *      - LINE-HEIGHT IS 1.5 wherever text sits inside geometry that matters.
 *        Any other ratio leaves `(1.5 - ratio) / 2 * font-size` of error, and
 *        it is a downward slide for every tighter value. Looser display type
 *        is fine only where nothing nearby gives the eye a reference.
 *      - NEVER position text with `line-height` (the centred-initials trick)
 *        or clip it with `overflow: hidden`. `text-overflow: ellipsis` is not
 *        implemented at all, so a clip only ever cuts glyphs in half. Centre
 *        with flexbox and truncate strings in JS.
 *      - SMALL TEXT MAGNIFIES the residual pixel of fudge, so nothing here
 *        goes below about 7pt.
 *
 * Spacing is padding-only on purpose: the paginator measures each block once
 * and packs pages arithmetically, and collapsing margins would make the sum
 * of the parts disagree with the height of the whole.
 */
import { DEFAULT_THEME, legibleThemePalette, type Theme } from "@thekeep/shared";
import { MARGIN, PAGE_H_PT, PAGE_W_PT } from "./page.js";

export interface Paper {
  bg: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  action: string;
  accent: string;
  system: string;
  /** True when the paper reads dark, so tints can flip lighter instead of darker. */
  dark: boolean;
}

/**
 * The ratio html2canvas measures its text baselines against, because its probe
 * element inherits it from the document root. Matching it cancels the
 * half-leading error; see note 3 in the file header.
 */
const BODY_LINE_HEIGHT = 1.5;

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Clamp one palette slot to a plain hex colour.
 *
 * `normalizeTheme` only checks that a stored slot is a STRING, so a world's
 * theme can hold any text at all, and this stylesheet interpolates those
 * values straight into a `<style>` block. A malformed value therefore breaks
 * a declaration at best, and at worst (a value carrying a brace or a comment
 * opener) takes the rest of the sheet with it. Production really does hold
 * one: a world with `panel: "#2c88f"`, five digits, which no CSS parser will
 * accept. Everything author-supplied gets clamped here so nothing unvalidated
 * can reach the generated CSS.
 */
function safeHex(value: string | undefined, fallback: string): string {
  const v = (value ?? "").trim();
  return HEX_RE.test(v) ? v : fallback;
}

/** `#rrggbb` (or `#rgb`) to `rgba(r, g, b, a)`. Inputs are pre-clamped by
 *  {@link paperFrom}, so the unparseable branch yields a harmless transparent
 *  rather than echoing the value back into the stylesheet. */
export function tint(hex: string, alpha: number): string {
  const m = HEX_RE.exec(hex.trim());
  if (!m) return "rgba(0, 0, 0, 0)";
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Perceived luminance 0..1 of a hex colour; 0 when unparseable. */
function luminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return 0;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * The world's palette, run through the same legibility pass the app applies
 * before painting, so an author who picked muted-on-muted still gets readable
 * body copy in print.
 */
export function paperFrom(theme: Theme): Paper {
  const p = legibleThemePalette(theme);
  const bg = safeHex(p.bg, DEFAULT_THEME.bg);
  return {
    bg,
    panel: safeHex(p.panel, DEFAULT_THEME.panel),
    border: safeHex(p.border, DEFAULT_THEME.border),
    text: safeHex(p.text, DEFAULT_THEME.text),
    muted: safeHex(p.muted, DEFAULT_THEME.muted),
    action: safeHex(p.action, DEFAULT_THEME.action),
    accent: safeHex(p.accent, DEFAULT_THEME.accent),
    system: safeHex(p.system, DEFAULT_THEME.system),
    dark: luminance(bg) < 0.5,
  };
}

/** Display face for headings, body face for copy: the app's own two stacks,
 *  including the reader's font preference where the app honours it. */
const DISPLAY_FONT = 'var(--keep-font-family, Georgia, Cambria, "Times New Roman", serif)';
const BODY_FONT = 'var(--keep-font-family, ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif)';

export function magazineCss(scope: string, paper: Paper): string {
  const s = `.${scope}`;
  const rule = tint(paper.border, 0.55);
  const hairline = tint(paper.border, 0.3);
  const wash = tint(paper.panel, paper.dark ? 0.45 : 0.55);
  return `
/* NOT scoped, and not decoration. html2pdf captures each page by cloning it
   into a fixed, full-viewport overlay at z-index 1000, invisible (opacity 0)
   but still hit-testable, so for the length of the export every click in the
   app lands on it instead of the UI. */
.html2pdf__overlay { pointer-events: none !important; }

${s} {
  width: ${PAGE_W_PT}pt;
  font-family: ${BODY_FONT};
  font-size: 9.5pt;
  line-height: ${BODY_LINE_HEIGHT};
  color: ${paper.text};
  background: ${paper.bg};
  -webkit-font-smoothing: antialiased;
}
${s} * { box-sizing: border-box; }

/* ---- page frame ---- */
${s} .wm-page {
  position: relative;
  width: ${PAGE_W_PT}pt;
  height: ${PAGE_H_PT}pt;
  padding: ${MARGIN.top}pt ${MARGIN.side}pt ${MARGIN.bottom}pt;
  background: ${paper.bg};
  color: ${paper.text};
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
${s} .wm-page--bleed { padding: 0; }
/* Fixed height so the paginator's empty probe page measures the same text
   column a real page has. Centred with flexbox, never with line-height, and
   the labels are truncated in JS rather than clipped: an overflow:hidden here
   cut the running head's glyphs in half. */
${s} .wm-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12pt;
  height: 22pt;
  padding-bottom: 6pt;
  border-bottom: 0.6pt solid ${rule};
  font-size: 7.5pt;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: ${paper.muted};
  flex: 0 0 auto;
}
${s} .wm-head span { white-space: nowrap; }
${s} .wm-flow { flex: 1 1 auto; min-height: 0; overflow: hidden; padding-top: 12pt; }
${s} .wm-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 22pt;
  padding-top: 7pt;
  border-top: 0.6pt solid ${hairline};
  font-family: ${DISPLAY_FONT};
  font-size: 8.5pt;
  color: ${paper.muted};
}
${s} .wm-flow > * { margin: 0; }

/* ---- cover ---- */
${s} .wm-cover { position: relative; flex: 1 1 auto; width: 100%; height: 100%; background: ${paper.bg}; overflow: hidden; }
${s} .wm-cover-art { position: absolute; inset: 0; background-size: cover; background-position: center; }
${s} .wm-cover-scrim {
  position: absolute; inset: 0;
  background: linear-gradient(to bottom, ${tint(paper.bg, 0.15)} 0%, ${tint(paper.bg, 0.55)} 45%, ${tint(paper.bg, 0.97)} 100%);
}
${s} .wm-cover-plate {
  position: absolute; inset: 0;
  background: linear-gradient(135deg, ${tint(paper.action, 0.18)}, ${tint(paper.accent, 0.12)}), ${paper.bg};
}
${s} .wm-cover-inner {
  position: absolute; left: ${MARGIN.side}pt; right: ${MARGIN.side}pt; bottom: ${MARGIN.bottom + 12}pt;
}
${s} .wm-cover-kicker {
  font-size: 8pt; letter-spacing: 0.28em; text-transform: uppercase; color: ${paper.action};
  padding-bottom: 10pt;
}
/* The one place a tight ratio is safe: nothing beside it gives the eye a
   reference, so the baseline drift a tighter line-height costs is invisible. */
${s} .wm-cover-title {
  font-family: ${DISPLAY_FONT};
  font-size: 40pt; line-height: 1.12; font-weight: 700; color: ${paper.text};
  padding-bottom: 10pt;
}
${s} .wm-cover-sub { font-size: 11pt; color: ${paper.text}; padding-bottom: 12pt; }
${s} .wm-cover-rule { height: 1.4pt; background: ${paper.action}; width: 96pt; margin-bottom: 12pt; }
/* Dot-separated, not boxed: same reason as .wm-tags below. */
${s} .wm-cover-meta {
  font-size: 8.5pt; letter-spacing: 0.12em; text-transform: uppercase; color: ${paper.muted};
}
${s} .wm-cover-meta em { font-style: normal; }
${s} .wm-cover-foot {
  position: absolute; left: ${MARGIN.side}pt; right: ${MARGIN.side}pt; top: ${MARGIN.top}pt;
  display: flex; justify-content: space-between;
  font-size: 7.5pt; letter-spacing: 0.22em; text-transform: uppercase; color: ${paper.muted};
}

/* ---- section furniture ---- */
${s} .wm-sec {
  padding-top: 4pt; padding-bottom: 10pt;
  border-bottom: 1.2pt solid ${paper.action};
  margin-bottom: 0;
}
${s} .wm-sec-kicker { font-size: 7.5pt; letter-spacing: 0.26em; text-transform: uppercase; color: ${paper.action}; }
${s} .wm-sec-title { font-family: ${DISPLAY_FONT}; font-size: 21pt; line-height: 1.3; padding-top: 3pt; }
${s} .wm-sec-note { font-size: 8.6pt; color: ${paper.muted}; padding-top: 3pt; }
${s} .wm-gap { height: 12pt; }
${s} .wm-gap-sm { height: 7pt; }

${s} .wm-h1 { font-family: ${DISPLAY_FONT}; font-size: 15.5pt; line-height: 1.3; padding-top: 12pt; padding-bottom: 3pt; }
${s} .wm-h2 { font-family: ${DISPLAY_FONT}; font-size: 12.5pt; line-height: 1.3; padding-top: 10pt; padding-bottom: 2pt; }
${s} .wm-h3 { font-family: ${DISPLAY_FONT}; font-size: 10.5pt; line-height: 1.35; padding-top: 8pt; padding-bottom: 2pt; color: ${paper.muted}; }
${s} .wm-label { font-size: 7.5pt; letter-spacing: 0.18em; text-transform: uppercase; color: ${paper.muted}; padding-bottom: 5pt; }
${s} .wm-lede { font-size: 10.5pt; line-height: 1.55; padding-bottom: 4pt; }
${s} .wm-note { font-size: 8.8pt; color: ${paper.muted}; }
${s} .wm-quiet { color: ${paper.muted}; font-style: italic; }

/* ---- cards, tables, chips ---- */
/* Optically balanced, not metrically: the label inside already carries half a
   line of leading above its capitals, so an equal top padding reads heavy. */
${s} .wm-card { border: 0.6pt solid ${rule}; border-radius: 3pt; background: ${wash}; padding: 7pt 11pt 11pt; }
${s} .wm-card + .wm-card { margin-top: 0; }
${s} .wm-facts { display: flex; flex-wrap: wrap; gap: 9pt 18pt; }
${s} .wm-fact { min-width: 88pt; }
${s} .wm-fact dt { font-size: 7.2pt; letter-spacing: 0.16em; text-transform: uppercase; color: ${paper.muted}; }
${s} .wm-fact dd { font-size: 9.5pt; }
/* ---- tag runs ----
   These were bordered pills, and they were the single worst thing in the
   document: the pill is GEOMETRY (taken from layout rects) while its label is
   TEXT (placed at html2canvas's own computed baseline), the two disagreed by
   most of a line, and the words sat half outside their outline. Enlarging the
   padding and matching line-heights both failed to close the gap.

   So there is no box any more. A dot-separated run of words is a conventional
   print treatment for a tag list, and with no edges to line up against it
   cannot come out misaligned no matter what the renderer does with the
   baseline. Do not reintroduce the pill. */
${s} .wm-tags { font-size: 8.5pt; color: ${paper.muted}; }
${s} .wm-tag { color: inherit; }
${s} .wm-tag--warn { color: ${paper.accent}; }
${s} .wm-tag--kind { color: ${paper.action}; }
/* A real element, not a ::before, so the separator is one more ordinary text
   run rather than generated content the renderer has to synthesize. */
${s} .wm-sep { color: ${tint(paper.muted, 0.55)}; padding: 0 4pt; }
${s} .wm-bars { display: flex; flex-wrap: wrap; gap: 6pt 18pt; }
${s} .wm-bar { width: 140pt; }
${s} .wm-bar-top { display: flex; justify-content: space-between; font-size: 8pt; }
${s} .wm-bar-track { height: 2.6pt; border-radius: 2pt; background: ${tint(paper.border, 0.45)}; }
${s} .wm-bar-fill { height: 2.6pt; border-radius: 2pt; background: ${paper.action}; }
${s} .wm-stats { display: flex; flex-wrap: wrap; gap: 0 16pt; }
${s} .wm-stat { display: flex; justify-content: space-between; gap: 10pt; width: 220pt; border-bottom: 0.5pt solid ${hairline}; padding: 3pt 0; font-size: 8.8pt; }
${s} .wm-stat dt { text-transform: uppercase; letter-spacing: 0.09em; color: ${paper.muted}; font-size: 7.5pt; }

/* ---- portraits and plates ---- */
${s} .wm-entry-head { display: flex; gap: 11pt; align-items: flex-start; padding-top: 12pt; }
${s} .wm-portrait { flex: 0 0 auto; width: 74pt; height: 74pt; border: 0.6pt solid ${rule}; border-radius: 3pt; background-size: cover; background-position: center; background-color: ${wash}; }
${s} .wm-entry-title { font-family: ${DISPLAY_FONT}; font-size: 15pt; line-height: 1.3; }
${s} .wm-entry-sub { font-size: 9.2pt; color: ${paper.muted}; padding-top: 2pt; }
${s} .wm-plate { width: 100%; border: 0.6pt solid ${rule}; border-radius: 3pt; background: ${wash}; }
${s} .wm-plate img { display: block; width: 100%; height: auto; }
${s} .wm-plate-wrap { position: relative; }
${s} .wm-pin { position: absolute; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 2pt; }
${s} .wm-pin-dot { width: 6pt; height: 6pt; border-radius: 50%; border: 0.8pt solid ${paper.bg}; }
/* The scrim behind a pin label is unavoidable (plain text over map art is
   unreadable), so it gets deep padding instead: the label can drift a couple
   of points and still sit on its own backing. */
${s} .wm-pin-text { font-size: 7pt; color: ${paper.text}; background: ${tint(paper.bg, 0.78)}; padding: 2.5pt 3pt; border-radius: 1.5pt; white-space: nowrap; }
${s} .wm-caption { font-size: 8pt; color: ${paper.muted}; padding-top: 4pt; }

/* ---- member gallery ---- */
${s} .wm-faces { display: flex; flex-wrap: wrap; gap: 6pt; }
${s} .wm-face { width: 48pt; text-align: center; }
${s} .wm-face-img { width: 32pt; height: 32pt; margin: 0 auto; border-radius: 50%; border: 0.6pt solid ${rule}; background-size: cover; background-position: center; background-color: ${wash}; }
/* Flex-centred, NOT line-height-centred. A 32pt line-height on 8pt text puts
   the measured baseline nowhere near the middle of the circle, so the
   initials came out pinned to its top edge. */
${s} .wm-face-init {
  width: 32pt; height: 32pt; margin: 0 auto;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%; border: 0.6pt solid ${rule}; background: ${wash};
  font-size: 8.5pt; color: ${paper.muted};
}
${s} .wm-face-name { font-size: 7pt; color: ${paper.muted}; padding-top: 3pt; }

/* ---- contents ---- */
${s} .wm-toc-row { display: flex; align-items: baseline; gap: 5pt; padding: 3pt 0; font-size: 9.5pt; }
${s} .wm-toc-row--section { font-family: ${DISPLAY_FONT}; font-size: 11.5pt; padding-top: 10pt; }
/* An empty flex item takes its border-box bottom as its baseline, so this
   dotted rule lands on the row's baseline with no nudging. It used to carry a
   translateY(-2pt), which stacked on top of the renderer's own downward text
   drift and left the dots floating well clear of the words. */
${s} .wm-toc-lead { flex: 1 1 auto; border-bottom: 0.5pt dotted ${tint(paper.muted, 0.6)}; }
${s} .wm-toc-num { font-family: ${DISPLAY_FONT}; font-variant-numeric: tabular-nums; color: ${paper.muted}; }
${s} .wm-toc-row--d1 { padding-left: 12pt; }
${s} .wm-toc-row--d2 { padding-left: 24pt; font-size: 9pt; }

/* ---- author prose (the wiki bodies) ---- */
/* The hair of vertical padding is deliberate: it stops a child's margin from
   collapsing THROUGH the wrapper, which would leave that space out of the
   wrapper's measured height and quietly overflow the page it was packed
   into. Author CSS can put margins on anything, so the guard has to be here
   rather than on the elements we control. */
${s} .wm-prose { font-size: 9.5pt; line-height: ${BODY_LINE_HEIGHT}; padding: 0.01pt 0; }
${s} .wm-prose p { margin: 0; padding: 3pt 0; }
${s} .wm-prose h1 { font-family: ${DISPLAY_FONT}; font-size: 14pt; line-height: 1.3; margin: 0; padding: 7pt 0 2pt; }
${s} .wm-prose h2 { font-family: ${DISPLAY_FONT}; font-size: 12pt; line-height: 1.3; margin: 0; padding: 6pt 0 2pt; }
${s} .wm-prose h3, ${s} .wm-prose h4, ${s} .wm-prose h5, ${s} .wm-prose h6 {
  font-family: ${DISPLAY_FONT}; font-size: 10.5pt; line-height: 1.35; margin: 0; padding: 5pt 0 2pt;
}
${s} .wm-prose ul { margin: 0; padding: 2pt 0 2pt 15pt; list-style: disc; }
${s} .wm-prose ol { margin: 0; padding: 2pt 0 2pt 15pt; list-style: decimal; }
${s} .wm-prose li { margin: 0; padding: 1pt 0; }
${s} .wm-prose blockquote {
  margin: 0; padding: 3pt 0 3pt 9pt; border-left: 1.4pt solid ${tint(paper.action, 0.55)}; color: ${paper.muted};
}
${s} .wm-prose hr { border: 0; border-top: 0.6pt solid ${rule}; margin: 0; padding: 5pt 0 0; }
${s} .wm-prose a { color: ${paper.action}; text-decoration: none; }
${s} .wm-prose img { max-width: 100%; height: auto; border-radius: 2pt; }
${s} .wm-prose table { border-collapse: collapse; width: 100%; font-size: 8.8pt; }
${s} .wm-prose td, ${s} .wm-prose th { border: 0.5pt solid ${rule}; padding: 3pt 4pt; text-align: left; }
${s} .wm-prose pre { white-space: pre-wrap; word-break: break-word; font-size: 8.4pt; background: ${wash}; padding: 5pt; border-radius: 2pt; margin: 0; }
${s} .wm-prose code { font-size: 8.6pt; }
/* Cross-link chips are NOT restyled here on purpose. The app's own
   .story-chip rule is written against --keep-action, and the page carries the
   world's palette in those variables, so the chips print exactly as they read
   on screen: a dead link, but visibly the same pill. */
/* Belt and braces: embeds are removed outright in content.prepareProse,
   because hiding them would still leave html2pdf's cloner placeholder. */
${s} .wm-prose iframe, ${s} .wm-prose .user-yt-embed { display: none; }

/* ---- colophon ---- */
${s} .wm-colophon { font-size: 8.8pt; color: ${paper.muted}; }
${s} .wm-colophon strong { color: ${paper.text}; font-weight: 600; }
`;
}
