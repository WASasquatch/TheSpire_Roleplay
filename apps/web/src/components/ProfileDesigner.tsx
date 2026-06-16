import { useCallback, useEffect, useRef } from "react";
import GjsEditor from "@grapesjs/react";
import grapesjs, { type Editor, type Panel, type Button } from "grapesjs";
// Side-effect import: Vite bundles this into a linked stylesheet in prod
// (CSP `style-src 'self'` safe) and injects it in dev (no CSP there). The
// GrapesJS UI keys off `.gjs-*` classes, so a global import is fine.
import "grapesjs/dist/css/grapes.min.css";

/**
 * GrapesJS-backed visual "Designer" for the profile bio.
 *
 * The bio is ONE HTML string (markup + optional <style> blocks) — the same
 * value the source textarea edits and the sanitizer persists.
 *
 * Fidelity model (important): GrapesJS owns the **HTML tree**; the author's
 * hand-written CSS is preserved **verbatim** and never handed to GrapesJS's CSS
 * model. GrapesJS's CSS composer can silently reorder/normalize/drop complex
 * constructs (@keyframes, ::before/::after content, layered gradients,
 * backdrop-filter) on round-trip — unacceptable for richly-themed profiles. So:
 *   - on load, split the bio: HTML → `setComponents`; the `<style>` CSS is kept
 *     verbatim in a ref (NOT `setStyle`'d).
 *   - the verbatim CSS is fed to the canvas via the CSS bridge so the WYSIWYG
 *     still shows the author's theme while they edit structure.
 *   - on export, re-emit `getHtml()` + `<style>{ verbatimCss + getCss() }>` —
 *     the author's CSS comes back byte-identical, and any NEW rules the Style
 *     Manager created (getCss) are appended.
 *
 * Net: visual editing of structure + new styling, with hand-CSS guaranteed
 * intact. Editing an EXISTING hand-rule still happens in Source mode (the Style
 * Manager creates an overriding rule instead) — a fair v1 trade for fidelity.
 *
 * Nothing here touches persistence — output flows through the same `sanitizeBio`
 * + render-time scoping the textarea path already uses (the sanitizer is
 * allow-almost-everything, so the designer's output round-trips losslessly).
 *
 * Default-exported so the caller can `React.lazy()` it and keep GrapesJS
 * (~hundreds of KB) out of the main bundle until the tab is opened.
 */

interface Props {
  /** Current bio HTML (markup + optional <style> blocks). */
  value: string;
  /** Fires (debounced) with the re-serialized bio as the designer changes. */
  onChange: (bioHtml: string) => void;
}

/** Split a stored bio into markup and its `<style>` CSS so GrapesJS can load
 *  the two into the component tree + style manager separately. */
function splitBio(bio: string): { html: string; css: string } {
  const styles: string[] = [];
  const html = bio.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, css: string) => {
    styles.push(css);
    return "";
  });
  return { html: html.trim(), css: styles.join("\n\n").trim() };
}

/** GrapesJS's `getHtml()` wraps its export in `<body>…</body>`. The bio is a
 *  document FRAGMENT, and the server sanitizer denies `<body>` — and, crucially,
 *  discards its children with it — so an unwrapped save would strip every card.
 *  Peel the wrapper off so we persist the inner markup. */
function bodyInner(html: string): string {
  return html
    .trim()
    .replace(/^<body[^>]*>/i, "")
    .replace(/<\/body>\s*$/i, "")
    .trim();
}

/** Re-join GrapesJS's exported markup + CSS into one bio string shaped exactly
 *  like what the source textarea + sanitizer expect (CSS in a `<style>` tail). */
function joinBio(html: string, css: string): string {
  const c = css.trim();
  return c ? `${html.trim()}\n<style>\n${c}\n</style>` : html.trim();
}

/** Merge the preserved author CSS with any new Style-Manager rules. */
function combineCss(verbatim: string, generated: string): string {
  return [verbatim.trim(), generated.trim()].filter(Boolean).join("\n\n");
}

/**
 * Mirror the active Spire theme into the canvas iframe so the WYSIWYG matches
 * how the bio actually renders: copy the `--keep-*` / `--theme-*` / `--orn-*`
 * custom properties off the app root onto the canvas <body>, then set the
 * body's background/ink to the theme. All applied as INLINE style attributes
 * (CSP `style-src-attr 'unsafe-inline'` allows those), so it works under the
 * strict prod CSP even though injected <style> blocks wouldn't. The body also
 * gets `.user-html-scope` so it shares the bio's render-time wrapper contract.
 */
function themeCanvas(editor: Editor): void {
  const body = editor.Canvas?.getBody?.();
  if (!body) return;
  const rootStyle = document.documentElement.style;
  for (let i = 0; i < rootStyle.length; i++) {
    const prop = rootStyle.item(i);
    if (prop && (prop.startsWith("--keep-") || prop.startsWith("--theme-") || prop.startsWith("--orn-"))) {
      body.style.setProperty(prop, rootStyle.getPropertyValue(prop));
    }
  }
  body.style.setProperty("background", "rgb(var(--keep-bg))");
  body.style.setProperty("color", "rgb(var(--keep-text))");
  body.classList.add("user-html-scope");
}

/**
 * Make the user's CSS (and GrapesJS's own canvas helper styles) actually
 * RENDER inside the canvas under the strict prod CSP.
 *
 * The canvas is an `about:blank` iframe, so it inherits the app's
 * `style-src 'self' 'nonce-…'` policy — which blocks every un-nonced `<style>`
 * GrapesJS injects (the user's bio CSS, the editor's selection outlines, etc).
 * A blocked `<style>` still sits in the DOM with readable text; it just isn't
 * applied. So we mirror the combined text of those blocks into an *adopted
 * constructable stylesheet* (`new CSSStyleSheet()` + `replaceSync` +
 * `adoptedStyleSheets`). Constructable sheets are CSSOM objects, NOT `<style>`
 * elements, so `style-src` doesn't gate them — the mirror applies even when the
 * originals are blocked. A MutationObserver keeps it in sync as styling
 * changes. Pure CSSOM, no server/CSP/GrapesJS-internals changes.
 *
 * Degrades cleanly: in dev (no CSP) the originals already apply, so the mirror
 * is a harmless idempotent duplicate; on a browser without constructable
 * sheets it just no-ops (back to "no prod preview"). Returns { disconnect,
 * resync } — `resync` re-applies after a change the head observer can't see
 * (e.g. a template appended its CSS to the verbatim ref, not the canvas).
 */
interface CanvasBridge { disconnect: () => void; resync: () => void }
function bridgeCanvasCss(editor: Editor, getVerbatimCss: () => string): CanvasBridge | undefined {
  const win = editor.Canvas?.getWindow?.() as (Window & typeof globalThis) | undefined;
  const doc = editor.Canvas?.getDocument?.();
  if (!win || !doc || typeof win.CSSStyleSheet !== "function" || !("adoptedStyleSheets" in doc)) {
    return undefined;
  }
  let sheet: CSSStyleSheet;
  try {
    sheet = new win.CSSStyleSheet();
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  } catch {
    return undefined;
  }
  const sync = () => {
    // Author CSS (kept verbatim, never put into a canvas <style>) + whatever
    // GrapesJS rendered into the canvas <style> blocks (its helpers + any new
    // Style-Manager rules). Both apply via the CSP-exempt adopted sheet.
    const canvasCss = Array.from(doc.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    const css = `${getVerbatimCss()}\n${canvasCss}`;
    try { sheet.replaceSync(css); } catch { /* transient invalid CSS while typing */ }
  };
  sync();
  const obs = new win.MutationObserver(sync);
  // The canvas <style> blocks live in <head>; watching it (childList for
  // adds/removes, characterData for textContent edits) catches every CSS
  // change without paying for body-mutation noise.
  obs.observe(doc.head, { subtree: true, childList: true, characterData: true });
  return { disconnect: () => obs.disconnect(), resync: sync };
}

/**
 * Bio block palette — theme-aware, self-contained presets matching the
 * card/header look writers reach for. Every block is INLINE-styled with the
 * user-facing `var(--theme-*)` contract (the same vars a hand-written bio uses,
 * mirrored into the canvas by `themeCanvas`), so:
 *   - it adapts to the profile's active palette, in the canvas AND on the page;
 *   - it needs no shared CSS classes (drop-and-go, nothing to wire up);
 *   - inline styles ride `style-src-attr 'unsafe-inline'`, so it previews under
 *     the strict prod CSP without the bridge.
 *
 * Curation = allow-list by construction: only safe presentational blocks are
 * offered (no forms/scripts/raw iframes — `<youtube>` is the one embed, via the
 * sanitizer's sandboxed-iframe shortcut). Rich effects (keyframes, ::before
 * sigils, layered gradients) still live in a hand-written <style> via Source.
 */
const CARD_STYLE =
  "margin:0 0 1rem;padding:1rem 1.1rem;background:rgb(var(--theme-panel-rgb) / .5);" +
  "border:1px solid rgb(var(--theme-border-rgb) / .6);border-radius:.9rem;" +
  "box-shadow:0 8px 24px rgb(0 0 0 / .22)";
const LABEL_STYLE =
  "font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--theme-accent)";

const BIO_BLOCKS = [
  // ---- Text ----
  {
    id: "b-heading", label: "Heading", category: "Text",
    content: '<h2 style="margin:0 0 .6rem;font-family:Georgia,serif;color:var(--theme-text);border-bottom:2px solid var(--theme-accent);padding-bottom:.35rem">Section Heading</h2>',
  },
  {
    id: "b-text", label: "Paragraph", category: "Text", activate: true,
    content: '<p style="margin:0 0 1rem;color:var(--theme-text);line-height:1.65">Write your story here…</p>',
  },
  {
    id: "b-quote", label: "Quote", category: "Text",
    content: '<blockquote style="margin:0 0 1rem;padding:.55rem 1rem;border-left:3px solid var(--theme-accent);background:rgb(var(--theme-accent-rgb) / .08);color:var(--theme-muted);font-style:italic">A line worth quoting.</blockquote>',
  },
  {
    id: "b-divider", label: "Divider", category: "Text",
    content: '<hr style="border:0;height:1px;margin:1.25rem 0;background:linear-gradient(90deg,transparent,rgb(var(--theme-accent-rgb) / .6),transparent)"/>',
  },
  { id: "b-spacer", label: "Spacer", category: "Text", content: '<div style="height:1.5rem"></div>' },

  // ---- Cards (the header-label look from popular profiles) ----
  {
    id: "b-card", label: "Card", category: "Cards",
    content: `<div style="${CARD_STYLE}"><h3 style="margin:0 0 .5rem;color:var(--theme-text);font-family:Georgia,serif">Card title</h3><p style="margin:0;color:var(--theme-muted);line-height:1.6">Card body text.</p></div>`,
  },
  {
    id: "b-field", label: "Labeled field", category: "Cards",
    content: `<div style="${CARD_STYLE}"><div style="${LABEL_STYLE};margin-bottom:.35rem">Label</div><p style="margin:0;color:var(--theme-text)">Value</p></div>`,
  },
  {
    id: "b-listcard", label: "List card", category: "Cards",
    content: `<div style="${CARD_STYLE}"><div style="${LABEL_STYLE};margin-bottom:.5rem">Traits</div><ul style="margin:0;padding-left:1.15rem;color:var(--theme-muted);line-height:1.6"><li>First trait</li><li>Second trait</li><li>Third trait</li></ul></div>`,
  },

  // ---- Layout ----
  {
    id: "b-wrap", label: "Bio container", category: "Layout",
    // A wrapper you drop OTHER blocks into. min-height makes it a visible drop
    // target (an empty container is otherwise a hard-to-grab hairline).
    content: '<div style="max-width:100%;margin:0 auto;padding:1.25rem;min-height:80px;color:var(--theme-text);background:rgb(var(--theme-panel-rgb) / .3);border:1px solid rgb(var(--theme-border-rgb) / .4);border-radius:1.1rem"></div>',
  },
  {
    id: "b-2col", label: "Two columns", category: "Layout",
    content: '<div style="display:flex;gap:1rem;margin:0 0 1rem;flex-wrap:wrap"><div style="flex:1;min-width:140px;color:var(--theme-text)">Column one</div><div style="flex:1;min-width:140px;color:var(--theme-text)">Column two</div></div>',
  },

  // ---- Media ----
  { id: "b-image", label: "Image", category: "Media", select: true, content: { type: "image" } },
  {
    id: "b-youtube", label: "YouTube", category: "Media",
    content: "<youtube>https://youtu.be/dQw4w9WgXcQ</youtube>",
  },
];

/* ----------------------------------------------------------------------------
 * Block thumbnails. GrapesJS shows only a label by default; a `media` SVG gives
 * each block a recognizable preview. `currentColor` inherits the panel ink;
 * template thumbnails pass their theme accent so the colors distinguish them.
 * ------------------------------------------------------------------------- */
const sv = (inner: string) =>
  `<svg viewBox="0 0 44 44" width="42" height="42" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
const frame = '<rect x="6" y="7" width="32" height="30" rx="5" fill="currentColor" opacity=".1"/><rect x="6" y="7" width="32" height="30" rx="5" fill="none" stroke="currentColor" stroke-opacity=".3"/>';
const cardIcon = (hd: string) => sv(`${frame}<rect x="11" y="12" width="22" height="6" rx="2.5" fill="${hd}"/><rect x="11" y="23" width="18" height="3" rx="1.5" fill="currentColor" opacity=".5"/><rect x="11" y="29" width="13" height="3" rx="1.5" fill="currentColor" opacity=".35"/>`);
const labelIcon = (hd: string) => sv(`${frame}<rect x="11" y="14" width="11" height="3.5" rx="1.75" fill="${hd}"/><rect x="11" y="24" width="22" height="4" rx="2" fill="currentColor" opacity=".5"/>`);
const listIcon = (hd: string) => sv(`${frame}<rect x="11" y="12" width="22" height="6" rx="2.5" fill="${hd}"/><circle cx="12.5" cy="24.5" r="1.6" fill="${hd}"/><rect x="16" y="23" width="17" height="3" rx="1.5" fill="currentColor" opacity=".5"/><circle cx="12.5" cy="30.5" r="1.6" fill="${hd}"/><rect x="16" y="29" width="13" height="3" rx="1.5" fill="currentColor" opacity=".4"/>`);
const stackIcon = (hd: string) => sv(`<rect x="8" y="6" width="28" height="13" rx="3" fill="currentColor" opacity=".1" stroke="currentColor" stroke-opacity=".25"/><rect x="12" y="9" width="15" height="4" rx="2" fill="${hd}"/><rect x="8" y="23" width="28" height="15" rx="3" fill="currentColor" opacity=".1" stroke="currentColor" stroke-opacity=".25"/><rect x="12" y="26" width="15" height="4" rx="2" fill="${hd}"/><rect x="12" y="33" width="20" height="2.5" rx="1.25" fill="currentColor" opacity=".4"/>`);

const BASIC_ICONS: Record<string, string> = {
  "b-heading": sv('<rect x="8" y="14" width="28" height="6" rx="2" fill="currentColor"/><rect x="8" y="25" width="17" height="3.5" rx="1.75" fill="currentColor" opacity=".5"/>'),
  "b-text": sv('<rect x="8" y="13" width="28" height="3.2" rx="1.6" fill="currentColor" opacity=".7"/><rect x="8" y="20" width="28" height="3.2" rx="1.6" fill="currentColor" opacity=".55"/><rect x="8" y="27" width="19" height="3.2" rx="1.6" fill="currentColor" opacity=".4"/>'),
  "b-quote": sv('<rect x="8" y="12" width="3.5" height="20" rx="1.75" fill="currentColor" opacity=".6"/><rect x="16" y="15" width="20" height="3.2" rx="1.6" fill="currentColor" opacity=".6"/><rect x="16" y="23" width="15" height="3.2" rx="1.6" fill="currentColor" opacity=".45"/>'),
  "b-divider": sv('<rect x="7" y="20.5" width="30" height="3" rx="1.5" fill="currentColor" opacity=".55"/>'),
  "b-spacer": sv('<rect x="8" y="10" width="28" height="24" rx="4" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-dasharray="3 3"/><path d="M22 16v12M18 20l4-4 4 4M18 24l4 4 4-4" stroke="currentColor" stroke-opacity=".4" stroke-width="1.6" fill="none"/>'),
  "b-card": cardIcon("currentColor"),
  "b-field": labelIcon("currentColor"),
  "b-listcard": listIcon("currentColor"),
  "b-wrap": sv('<rect x="7" y="8" width="30" height="28" rx="6" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-dasharray="4 3"/><path d="M22 16v12M16 22h12" stroke="currentColor" stroke-opacity=".45" stroke-width="2.2"/>'),
  "b-2col": sv('<rect x="7" y="10" width="13" height="24" rx="3" fill="currentColor" opacity=".15" stroke="currentColor" stroke-opacity=".3"/><rect x="24" y="10" width="13" height="24" rx="3" fill="currentColor" opacity=".15" stroke="currentColor" stroke-opacity=".3"/>'),
  "b-image": sv('<rect x="7" y="10" width="30" height="24" rx="3" fill="currentColor" opacity=".12" stroke="currentColor" stroke-opacity=".3"/><circle cx="16" cy="18" r="3" fill="currentColor" opacity=".6"/><path d="M10 33l8-9 5 5 5-5 6 9z" fill="currentColor" opacity=".5"/>'),
  "b-youtube": sv('<rect x="6" y="12" width="32" height="20" rx="5" fill="#e0413a" opacity=".85"/><path d="M19 17l9 5-9 5z" fill="#fff"/>'),
};

/* ----------------------------------------------------------------------------
 * Panel-button icons (THE root cause of the recurring "blank buttons").
 *
 * GrapesJS labels its default top-panel buttons with Font Awesome CLASSES
 * (`fa fa-square-o`, `fa fa-code`, `fa fa-paint-brush`, …) but ships NO icon
 * font — it assumes the host app loads Font Awesome. The Spire never has (we
 * standardize on inline SVG / lucide), so those buttons render as empty,
 * clickable boxes. A glyph from an absent font can't be styled into existence,
 * which is why every color/fill CSS tweak "fixed it briefly" (lighting up the
 * few buttons GrapesJS draws as real SVG) and then "broke again."
 *
 * The durable fix: relabel each fa-glyph button with a self-contained inline
 * SVG — same approach as the block thumbnails above — so the panel has zero
 * font dependency. `iconifyPanels` (below) applies these on first ready.
 *
 * Lucide-style 24-grid strokes; GrapesJS's `.gjs-pn-btn svg{fill:currentColor}`
 * plus our themed `color` pin (styles.css) handle the ink. fill:none keeps the
 * strokes from filling solid.
 * ------------------------------------------------------------------------- */
const psv = (inner: string) =>
  `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
const PANEL_ICONS: Record<string, string> = {
  "fa-square-o": psv('<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 3"/>'), // borders / outlines
  "fa-eye": psv('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'), // preview
  "fa-eye-slash": psv('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21" y2="21"/>'),
  "fa-arrows-alt": psv('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'), // fullscreen
  "fa-code": psv('<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>'), // view/export code
  "fa-paint-brush": psv('<path d="M9.06 11.9 18 3a2.83 2.83 0 1 1 4 4l-8.9 8.94"/><path d="M7 14a3 3 0 0 0-3 3c0 1.5-1 2-2 2 1 1.5 3 2 4 2a3 3 0 0 0 3-3 3 3 0 0 0-2-4Z"/>'), // style manager
  "fa-cog": psv('<line x1="21" y1="6" x2="11" y2="6"/><line x1="14" y1="17" x2="3" y2="17"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="6" r="3"/>'), // settings / traits
  "fa-bars": psv('<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>'), // layers
  "fa-th-large": psv('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'), // blocks
  "fa-pencil": psv('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  "fa-caret-down": psv('<path d="m6 9 6 6 6-6"/>'),
  "fa-caret-right": psv('<path d="m9 6 6 6-6 6"/>'),
};

/** Replace every fa-glyph panel button label with its inline-SVG equivalent so
 * the Designer chrome has no Font Awesome dependency. No-op for buttons that
 * already carry a real SVG icon. Safe to call once after the editor is ready —
 * panel buttons survive canvas frame reloads, so we don't repeat it. */
function iconifyPanels(editor: Editor): void {
  editor.Panels.getPanels().forEach((panel: Panel) => {
    (panel.get("buttons") as { forEach(cb: (b: Button) => void): void }).forEach((btn: Button) => {
      const attrs = (btn.get("attributes") as Record<string, string>) || {};
      const parts = String(attrs.class || "").split(/\s+/).filter(Boolean);
      const key = parts.find((c) => PANEL_ICONS[c]);
      if (!key) return;
      // Drop the dead `fa`/`fa-*` classes and render the SVG as the label.
      btn.set("attributes", { ...attrs, class: parts.filter((c) => c !== "fa" && c !== key).join(" ") });
      btn.set("label", PANEL_ICONS[key]);
    });
  });
}

/* ----------------------------------------------------------------------------
 * Templates — full themed scaffolds (class-based markup + their stylesheet).
 *
 * Each theme owns a UNIQUE class prefix, so multiple themes can coexist in one
 * bio without their CSS colliding. Dropping a template block injects that
 * theme's stylesheet into the bio's verbatim CSS once (marker-guarded). Cards
 * arrive pre-filled with editable headers + text — drop and edit in place.
 *
 * `themeCss` keeps the shared card/header/list structure consistent while each
 * theme supplies only its palette + flourishes.
 * ------------------------------------------------------------------------- */
interface ThemeOpts {
  font: string; ink: string; txtInk?: string;
  bioBg: string; bioBorder: string; bioShadow?: string;
  cardBg: string; cardBorder: string; cardExtra?: string;
  hdInk: string; hdBg: string; hdExtra?: string;
  extra?: string;
}
function themeCss(k: string, o: ThemeOpts): string {
  const t = o.txtInk ?? o.ink;
  return `/* spire-tpl:${k} */
.${k}-bio{max-width:100%;margin:0 auto;padding:1.3rem;color:${o.ink};font-family:${o.font};line-height:1.65;background:${o.bioBg};border:1px solid ${o.bioBorder};border-radius:1.1rem;box-shadow:${o.bioShadow ?? "0 18px 50px rgba(0,0,0,.5)"};overflow:hidden}
.${k}-card{margin:0 0 1rem;padding:1rem 1.1rem;background:${o.cardBg};border:1px solid ${o.cardBorder};border-radius:.85rem;${o.cardExtra ?? ""}}
.${k}-card:last-child{margin-bottom:0}
.${k}-hd{margin:0 0 .7rem;padding:.4rem .85rem;color:${o.hdInk};font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-radius:.55rem;background:${o.hdBg};${o.hdExtra ?? ""}}
.${k}-val{margin:0;color:${o.ink};font-size:1rem}
.${k}-txt{margin:0;color:${t}}
.${k}-txt + .${k}-txt{margin-top:.8rem}
.${k}-list{margin:0;padding-left:1.15rem;color:${t}}
.${k}-list li{margin:.25rem 0}${o.extra ?? ""}`;
}

const TEMPLATES: ReadonlyArray<{ key: string; label: string; accent: string; css: string }> = [
  { key: "ml", label: "Moonlit", accent: "#b8a7ff", css: themeCss("ml", {
    font: 'Georgia,"Times New Roman",serif', ink: "#eeeaf2", txtInk: "rgba(238,234,242,.9)",
    bioBg: "radial-gradient(circle at top left,rgba(164,126,255,.14),transparent 34%),radial-gradient(circle at bottom right,rgba(42,156,160,.08),transparent 38%),linear-gradient(135deg,rgba(14,14,18,.98),rgba(3,3,6,.99))",
    bioBorder: "rgba(183,166,255,.16)", bioShadow: "0 0 30px rgba(119,89,198,.14),0 0 70px rgba(0,0,0,.62)",
    cardBg: "linear-gradient(135deg,rgba(255,255,255,.07),rgba(255,255,255,.018)),linear-gradient(145deg,rgba(28,28,36,.56),rgba(4,4,8,.42))",
    cardBorder: "rgba(188,174,255,.13)", cardExtra: "box-shadow:0 10px 30px rgba(0,0,0,.48);backdrop-filter:blur(8px)",
    hdInk: "#f8f4ff", hdBg: "linear-gradient(90deg,rgba(85,68,142,.78),rgba(34,34,46,.48),transparent)", hdExtra: "text-shadow:0 0 8px rgba(184,167,255,.7)",
  }) },
  { key: "pg", label: "Parchment", accent: "#a9762e", css: themeCss("pg", {
    font: '"Palatino Linotype",Palatino,Georgia,serif', ink: "#3a2e22", txtInk: "#4a3c2c",
    bioBg: "radial-gradient(circle at 18% 8%,rgba(255,250,235,.9),transparent 42%),linear-gradient(160deg,#efe4ca,#e1cfa9)",
    bioBorder: "#b79a64", bioShadow: "0 14px 40px rgba(60,40,15,.35),inset 0 0 40px rgba(120,90,40,.12)",
    cardBg: "linear-gradient(160deg,rgba(255,252,243,.85),rgba(244,234,210,.78))", cardBorder: "rgba(150,115,60,.4)", cardExtra: "box-shadow:inset 0 0 0 1px rgba(255,255,255,.4)",
    hdInk: "#5a4220", hdBg: "transparent", hdExtra: "border-bottom:2px solid rgba(150,115,60,.55);border-radius:0;padding-left:0",
  }) },
  { key: "nt", label: "Neon terminal", accent: "#38e1c4", css: themeCss("nt", {
    font: '"DejaVu Sans Mono","Courier New",monospace', ink: "#bff5ea", txtInk: "rgba(180,235,225,.85)",
    bioBg: "linear-gradient(180deg,#04100e,#020807)", bioBorder: "rgba(56,225,196,.4)", bioShadow: "0 0 26px rgba(56,225,196,.18),inset 0 0 40px rgba(0,0,0,.6)",
    cardBg: "rgba(10,30,28,.6)", cardBorder: "rgba(56,225,196,.28)", cardExtra: "box-shadow:inset 0 0 12px rgba(56,225,196,.06)",
    hdInk: "#7ff6e2", hdBg: "transparent", hdExtra: "border-radius:0;padding-left:0;text-shadow:0 0 8px rgba(56,225,196,.55);border-left:3px solid #38e1c4;padding-left:.6rem",
  }) },
  { key: "rs", label: "Rose", accent: "#e892b6", css: themeCss("rs", {
    font: 'Georgia,"Times New Roman",serif', ink: "#f6e6ee", txtInk: "rgba(246,230,238,.88)",
    bioBg: "radial-gradient(circle at 70% 12%,rgba(232,146,182,.16),transparent 40%),linear-gradient(160deg,#2a1820,#150d12)",
    bioBorder: "rgba(232,146,182,.28)", bioShadow: "0 0 34px rgba(232,146,182,.14),0 18px 50px rgba(0,0,0,.5)",
    cardBg: "linear-gradient(160deg,rgba(232,146,182,.1),rgba(60,30,45,.5))", cardBorder: "rgba(232,146,182,.22)",
    hdInk: "#ffd9e8", hdBg: "linear-gradient(90deg,rgba(232,146,182,.45),transparent)", hdExtra: "text-shadow:0 0 8px rgba(232,146,182,.5)",
  }) },
  { key: "cg", label: "Crimson", accent: "#d04a3b", css: themeCss("cg", {
    font: '"Trajan Pro",Georgia,serif', ink: "#ecd7d4", txtInk: "rgba(236,215,212,.86)",
    bioBg: "radial-gradient(circle at 50% 0%,rgba(192,57,43,.12),transparent 45%),linear-gradient(160deg,#160708,#080304)",
    bioBorder: "rgba(192,57,43,.3)", bioShadow: "inset 0 0 50px rgba(0,0,0,.65),0 18px 50px rgba(0,0,0,.55)",
    cardBg: "linear-gradient(160deg,rgba(40,16,16,.6),rgba(12,5,6,.5))", cardBorder: "rgba(150,40,32,.4)",
    hdInk: "#ffcfc7", hdBg: "linear-gradient(90deg,rgba(140,30,25,.7),transparent)", hdExtra: "border-left:3px solid #c0392b;text-shadow:0 0 8px rgba(192,57,43,.4)",
  }) },
  { key: "gr", label: "Grove", accent: "#7fc98a", css: themeCss("gr", {
    font: 'Georgia,"Times New Roman",serif', ink: "#e3f0e2", txtInk: "rgba(227,240,226,.86)",
    bioBg: "radial-gradient(circle at 20% 10%,rgba(127,201,138,.14),transparent 40%),linear-gradient(160deg,#0e1a12,#060d09)",
    bioBorder: "rgba(127,201,138,.26)", bioShadow: "0 0 28px rgba(60,140,80,.16),0 18px 50px rgba(0,0,0,.5)",
    cardBg: "linear-gradient(160deg,rgba(127,201,138,.08),rgba(20,40,28,.5))", cardBorder: "rgba(127,201,138,.22)",
    hdInk: "#d6f3da", hdBg: "linear-gradient(90deg,rgba(60,120,75,.55),transparent)", hdExtra: "text-shadow:0 0 7px rgba(127,201,138,.4)",
  }) },
  { key: "mn", label: "Minimal", accent: "var(--theme-accent)", css: themeCss("mn", {
    font: 'system-ui,-apple-system,"Segoe UI",sans-serif', ink: "var(--theme-text)", txtInk: "var(--theme-muted)",
    bioBg: "transparent", bioBorder: "rgb(var(--theme-border-rgb) / .4)", bioShadow: "none",
    cardBg: "rgb(var(--theme-panel-rgb) / .45)", cardBorder: "rgb(var(--theme-border-rgb) / .5)",
    hdInk: "var(--theme-accent)", hdBg: "transparent", hdExtra: "border-radius:0;padding:0 0 .35rem;border-bottom:1px solid rgb(var(--theme-accent-rgb) / .4);font-size:.82rem",
  }) },
];

/** Per-template blocks: a full scaffold + label / section / list cards, each
 *  pre-filled with editable text and an accent-tinted thumbnail. */
function templateBlocks(t: { key: string; label: string; accent: string }) {
  const p = t.key, cat = t.label, a = t.accent;
  return [
    { id: `tpl-${p}`, label: `${t.label} dossier`, category: cat, media: stackIcon(a),
      content: `<div class="${p}-bio"><div class="${p}-card"><div class="${p}-hd">Name</div><p class="${p}-val">Your name</p></div><div class="${p}-card"><div class="${p}-hd">About</div><p class="${p}-txt">Write a few lines about yourself or your character here.</p></div></div>` },
    { id: `tpl-${p}-label`, label: `${t.label} label`, category: cat, media: labelIcon(a),
      content: `<div class="${p}-card"><div class="${p}-hd">Label</div><p class="${p}-val">Value</p></div>` },
    { id: `tpl-${p}-section`, label: `${t.label} section`, category: cat, media: cardIcon(a),
      content: `<div class="${p}-card"><div class="${p}-hd">Section</div><p class="${p}-txt">First paragraph.</p><p class="${p}-txt">Second paragraph.</p></div>` },
    { id: `tpl-${p}-list`, label: `${t.label} list`, category: cat, media: listIcon(a),
      content: `<div class="${p}-card"><div class="${p}-hd">Traits</div><ul class="${p}-list"><li>First trait</li><li>Second trait</li><li>Third trait</li></ul></div>` },
  ];
}

const TEMPLATE_BLOCKS = TEMPLATES.flatMap((t) => templateBlocks(t));

/**
 * A template's stylesheet, detected by the class PREFIX it uses in the markup
 * (`re`) rather than by drag events. The CSS is treated as DERIVED data: it is
 * never stored in the persistent author-CSS ref. Instead it is computed fresh
 * from the current markup on every emit and on load any previously-saved copy
 * is stripped back out. That keeps markup and its stylesheet inseparable —
 * removing the cards removes their CSS, and an empty canvas can never leave an
 * orphan CSS-only bio behind (the bug that produced a styled-but-textless
 * profile).
 */
const TEMPLATE_SHEETS = TEMPLATES.map((t) => ({
  css: t.css,
  re: new RegExp(`\\b${t.key}-(?:bio|card|hd|val|txt|list)\\b`),
}));

/** The concatenated stylesheets for every template whose classes appear in
 *  `html`. Returns "" when none are present. */
function templateCssFor(html: string): string {
  return TEMPLATE_SHEETS.filter((t) => t.re.test(html)).map((t) => t.css).join("\n\n");
}

/** Remove any template stylesheet text from author CSS loaded off a saved bio,
 *  so it isn't double-counted (templates are re-derived from markup on emit).
 *  Matches the exact generated sheet text, then tidies the blank lines left. */
function stripTemplateSheets(css: string): string {
  let out = css;
  for (const t of TEMPLATE_SHEETS) out = out.split(t.css).join("");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// Templates first (richest, most discoverable), then the plain building blocks
// with their thumbnails applied.
const ALL_BLOCKS = [
  ...TEMPLATE_BLOCKS,
  ...BIO_BLOCKS.map((b) => (BASIC_ICONS[b.id] ? { ...b, media: BASIC_ICONS[b.id] } : b)),
];

export default function ProfileDesigner({ value, onChange }: Props) {
  const editorRef = useRef<Editor | null>(null);
  const lastEmitted = useRef<string>("");
  // Author CSS, preserved byte-for-byte (never parsed by GrapesJS). Fed to the
  // canvas bridge for preview and re-emitted untouched on export.
  const verbatimCss = useRef<string>("");
  // Suppress the burst of `update` events GrapesJS fires while it parses the
  // initial content, so merely opening the Designer doesn't mark the form
  // dirty. Flipped true once the first load settles.
  const loadedRef = useRef(false);
  // Canvas CSS bridge ({ disconnect, resync }), refreshed on every frame
  // (re)load and torn down on unmount.
  const bridgeRef = useRef<CanvasBridge | undefined>(undefined);
  // Open the Blocks panel on first ready only (not on every device-switch
  // frame reload).
  const openedBlocksRef = useRef(false);

  // Theme + CSS-bridge the canvas. Runs on first ready and every frame reload.
  // The bridge previews author CSS PLUS the stylesheets for whatever templates
  // are currently on the canvas (derived fresh, same as on export).
  const setupCanvas = useCallback((editor: Editor) => {
    themeCanvas(editor);
    bridgeRef.current?.disconnect();
    bridgeRef.current = bridgeCanvasCss(editor, () =>
      combineCss(verbatimCss.current, templateCssFor(editor.getHtml())),
    );
    // Default to the Blocks panel: a fresh bio is an empty slate, so the most
    // useful thing to show is the palette of blocks/templates to drag in (vs.
    // the Style Manager, which needs a selection to do anything).
    if (!openedBlocksRef.current) {
      openedBlocksRef.current = true;
      // Swap GrapesJS's Font-Awesome button labels for inline SVGs so the
      // panel chrome doesn't depend on a font the app never loads (the recurring
      // "blank top-bar buttons"). Once is enough — buttons outlive frame reloads.
      try { iconifyPanels(editor); } catch { /* panels absent in some presets */ }
      try { editor.runCommand("open-blocks"); } catch { /* panel preset absent */ }
    }
  }, []);

  // Tear the observer down when the Designer unmounts (mode switch / close).
  useEffect(() => () => bridgeRef.current?.disconnect(), []);

  // Emit synchronously on every change (no debounce) so switching to Source
  // mode never loses the last edit. The bio is small, so serializing the tree
  // per update is cheap, and the dedupe guard skips no-op emits.
  const emit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !loadedRef.current) return;
    const html = bodyInner(editor.getHtml() ?? "");
    // CSS = author (verbatim) + any new Style-Manager rules + the stylesheets
    // for the templates actually present in the markup (derived fresh — never
    // accumulated). When the canvas is empty the bio is empty, full stop: we
    // never emit a CSS-only value, which is what stranded a textless styled bio.
    const css = combineCss(
      combineCss(verbatimCss.current, editor.getCss() ?? ""),
      templateCssFor(html),
    );
    const next = html ? joinBio(html, css) : "";
    if (next !== lastEmitted.current) {
      lastEmitted.current = next;
      onChange(next);
    }
  }, [onChange]);
  // Stable handle for the once-registered GrapesJS event listeners.
  const emitRef = useRef(emit);
  emitRef.current = emit;

  const onEditor = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;
      // Preserve the custom `<youtube>https://…</youtube>` shortcut: register it
      // as an atomic component so GrapesJS round-trips the tag + its URL text
      // intact instead of trying to interpret it.
      editor.Components.addType("spire-youtube", {
        isComponent: (el) => el.tagName?.toLowerCase() === "youtube",
        model: { defaults: { tagName: "youtube", name: "YouTube", droppable: false } },
      });
      // A template block carries class-based markup whose styles come from its
      // stylesheet, which `emit` (and the bridge) derive from the markup's class
      // prefixes. On drop, emit then resync the canvas preview so that derived
      // CSS paints immediately.
      editor.on("block:drag:stop", () => {
        emitRef.current();
        bridgeRef.current?.resync();
      });
      // Load the bio: HTML into the component tree; CSS kept verbatim (see the
      // fidelity model in the file header) — deliberately NOT setStyle'd. Strip
      // out any template stylesheets the saved bio carried; they're re-derived
      // from the markup on emit, so keeping them here would double them up (or,
      // if the markup was lost, strand them as orphan CSS).
      const { html, css } = splitBio(value);
      verbatimCss.current = stripTemplateSheets(css);
      editor.setComponents(html || "<p></p>");
      lastEmitted.current = value;
      // Re-theme + re-bridge the canvas whenever its frame (re)loads (initial
      // mount, device switch). onReady below covers the very first paint.
      editor.on("canvas:frame:load", () => setupCanvas(editor));
      // Let the initial parse settle before we start emitting changes.
      requestAnimationFrame(() => { loadedRef.current = true; });
    },
    // Intentionally load once on editor creation; live `value` changes from
    // the source textarea are reconciled on the next Designer↩Source switch
    // (the caller remounts this component), not pushed mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <GjsEditor
      className="profile-designer h-full w-full"
      grapesjs={grapesjs}
      options={{
        height: "100%",
        // We own persistence (bio string flows up via onChange); GrapesJS's
        // own storage layer would just fight us.
        storageManager: false,
        fromElement: false,
        blockManager: { blocks: ALL_BLOCKS },
      }}
      onEditor={onEditor}
      onReady={setupCanvas}
      onUpdate={emit}
    />
  );
}
