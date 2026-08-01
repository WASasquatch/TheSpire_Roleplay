/**
 * Turns a world dossier into the magazine's content stream: a cover, an
 * ordered list of blocks for the paginator, and (afterwards) a contents
 * spread built from where those blocks actually landed.
 *
 * The running order mirrors the wiki, so a reader who knows the site can find
 * their way around the file: About → Lore → the typed entries by kind → Arcs
 * → Sessions → Maps → the Overlook → a colophon.
 *
 * Author prose is prepared as live DOM rather than strings, because two
 * passes have to touch it: the `@kind:slug` chip decorator (a text-node walk)
 * and the image pass, which swaps every `src` for the downloaded bytes and
 * stamps concrete dimensions. Neither is cosmetic. The paginator measures
 * arithmetically, so an `<img>` without a known size measures as zero and
 * overflows its page; and every picture is inlined as a `data:` URL so the
 * rasterizer can never come up empty on a slow or rate-limited fetch.
 */
import type { TFunction } from "i18next";
import {
  BUILTIN_WORLD_ENTITY_KINDS,
  WORLD_VIBE_AXES,
  type WorldEntity,
  type WorldEntityKindDef,
  type WorldExportDossier,
  type WorldExportMap,
  type WorldMapMarker,
  type WorldPage,
} from "@thekeep/shared";
import { safeCssColor } from "../../components/shared/RoleBadgeChips.js";
import { formatDate } from "../intlFormat.js";
import { legibleHtmlColors, sanitizeUserHtml, USER_HTML_SCOPE_CLASS } from "../userHtml.js";
import { buildWorldTree, type WorldTreeNode } from "../worlds.js";
import { decorateWorldMentionsIn } from "../worldMentions.js";
import type { Block } from "./paginate.js";
import { MARGIN, PAGE_H_PT, PAGE_W_PT } from "./page.js";
import type { Paper } from "./styles.js";
import { clip, esc, proxiedMediaUrl, type ImageAsset } from "./util.js";

/** Text column width, in points. */
export const COLUMN_W_PT = PAGE_W_PT - MARGIN.side * 2;
/** Tallest a single plate may be before it starts eating whole pages. */
const PLATE_MAX_H_PT = PAGE_H_PT - MARGIN.top - MARGIN.bottom - 120;
/** Screen pixels are 96/inch, points are 72/inch. */
const PX_TO_PT = 0.75;

/** Contents rows past this are folded into a single "and N more" line, so a
 *  three-hundred-entry world doesn't open with fifteen pages of index. */
const TOC_MAX_ROWS = 240;

export interface PreparedProse {
  /** Detached, sanitized, chip-decorated body. Images already proxied. */
  el: HTMLElement;
  /** Proxied URLs of every picture inside, `<img>` and CSS alike, for the
   *  download pass. */
  images: string[];
}

/** `url(…)` in a CSS value, quoted or not. */
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

/**
 * Rewrite every `url(…)` an author's own CSS points at, in both `<style>`
 * blocks and inline `style` attributes, and report what was found.
 *
 * A world page can set a background image in its custom CSS, and those
 * references are invisible to a `querySelectorAll("img")` sweep. Left alone
 * they stay cross-origin, which means html2canvas either fails to load them
 * (blank) or, worse, they never get downloaded at all. Running them through
 * the same proxy-then-inline path as everything else is what keeps a styled
 * page looking styled on paper.
 *
 * `resolve` returns the replacement, or null to leave a reference alone.
 * Output is always requoted with double quotes, which is safe for both proxy
 * paths and base64 data URLs (neither can contain one).
 */
function rewriteCssUrls(root: HTMLElement, resolve: (raw: string) => string | null): string[] {
  const found: string[] = [];
  const rewrite = (css: string): string =>
    css.replace(CSS_URL_RE, (whole, _q: string, raw: string) => {
      const target = raw.trim();
      if (!target || target.startsWith("data:")) return whole;
      const next = resolve(target);
      if (!next) return whole;
      found.push(next);
      return `url("${next}")`;
    });

  root.querySelectorAll("style").forEach((tag) => {
    const css = tag.textContent ?? "";
    if (css.includes("url(")) tag.textContent = rewrite(css);
  });
  root.querySelectorAll<HTMLElement>("[style]").forEach((node) => {
    const css = node.getAttribute("style") ?? "";
    if (css.includes("url(")) node.setAttribute("style", rewrite(css));
  });
  return found;
}

/**
 * Sanitize + colour-nudge + chip-decorate one author body.
 *
 * Same pipeline the wiki viewer runs (`sanitizeUserHtml` → `legibleHtmlColors`
 * → `decorateWorldMentionsIn`), so the printed page carries the author's own
 * markup, custom CSS and cross-link chips rather than a flattened copy.
 * Legibility is measured against the world's paper colour, which is why a
 * body written on a light editor still reads on a dark world's pages.
 */
export function prepareProse(bodyHtml: string, paper: Paper): PreparedProse | null {
  if (!bodyHtml.trim()) return null;
  const el = document.createElement("div");
  el.className = `wm-prose ${USER_HTML_SCOPE_CLASS}`;
  el.innerHTML = legibleHtmlColors(sanitizeUserHtml(bodyHtml), paper.bg);
  // The decorator is a pure text-node walk, so it works on a detached tree,
  // and running it BEFORE measurement matters: chips carry padding, and
  // adding them afterwards would nudge line wrapping past the page bottom.
  decorateWorldMentionsIn(el);
  // Embeds are stripped, not hidden. html2pdf's cloner swaps every <iframe>
  // for a hatched grey placeholder box sized from the original, so a
  // display:none video would still print as a small bordered artifact.
  el.querySelectorAll("iframe, .user-yt-embed").forEach((n) => n.remove());
  const images: string[] = [];
  el.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (!src) { img.remove(); return; }
    const proxied = proxiedMediaUrl(src);
    img.setAttribute("src", proxied);
    img.removeAttribute("srcset");
    img.removeAttribute("loading");
    images.push(proxied);
  });
  images.push(...rewriteCssUrls(el, (raw) => proxiedMediaUrl(raw)));
  return { el, images };
}

/** Fit natural pixel dimensions into a points-sized box, preserving ratio. */
export function fitBox(nat: { w: number; h: number }, maxWPt: number, maxHPt: number): { w: number; h: number } {
  const natWPt = nat.w * PX_TO_PT;
  const natHPt = nat.h * PX_TO_PT;
  const scale = Math.min(1, maxWPt / natWPt, maxHPt / natHPt);
  return { w: natWPt * scale, h: natHPt * scale };
}

/**
 * Point a prepared body's pictures at the downloaded bytes and stamp concrete
 * sizes on its `<img>` tags. An image we failed to download is dropped rather
 * than left as a broken box; a CSS reference we failed to download keeps its
 * URL, since a background that doesn't paint costs nothing.
 */
function inlineProseImages(prose: PreparedProse, assets: Map<string, ImageAsset>): void {
  prose.el.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const nat = assets.get(src);
    if (!nat) { img.remove(); return; }
    img.setAttribute("src", nat.src);
    const box = fitBox(nat, COLUMN_W_PT, PLATE_MAX_H_PT * 0.7);
    img.setAttribute("width", String(Math.round(box.w)));
    img.setAttribute("height", String(Math.round(box.h)));
    img.style.width = `${box.w.toFixed(1)}pt`;
    img.style.height = `${box.h.toFixed(1)}pt`;
  });
  rewriteCssUrls(prose.el, (proxied) => assets.get(proxied)?.src ?? null);
}

/** The kind catalog the wiki shows: localized built-ins + the world's own. */
export function kindDefsFor(dossier: WorldExportDossier, t: TFunction): WorldEntityKindDef[] {
  const builtinKeys = new Set(BUILTIN_WORLD_ENTITY_KINDS.map((k) => k.key));
  const builtIn: WorldEntityKindDef[] = BUILTIN_WORLD_ENTITY_KINDS.map((k) => ({
    ...k,
    label: t(`kinds.${k.key}.label`),
    description: t(`kinds.${k.key}.description`),
  }));
  const custom: WorldEntityKindDef[] = dossier.entityKinds
    .filter((k) => !builtinKeys.has(k.key.toLowerCase()))
    .map((k) => ({
      key: k.key,
      label: k.label,
      description: k.description,
      icon: k.icon ?? "✦",
      color: k.color ?? "#8a8a8a",
      sortOrder: k.sortOrder,
      builtIn: false,
    }));
  return [...builtIn, ...custom];
}

/** Every image the magazine will draw, so one download pass covers them all. */
export function collectImageUrls(
  dossier: WorldExportDossier,
  proseByKey: Map<string, PreparedProse>,
): string[] {
  const urls: string[] = [];
  if (dossier.world.coverImageUrl) urls.push(proxiedMediaUrl(dossier.world.coverImageUrl));
  for (const e of dossier.entities) if (e.imageUrl) urls.push(proxiedMediaUrl(e.imageUrl));
  for (const m of dossier.maps) urls.push(proxiedMediaUrl(m.map.imageUrl));
  for (const mem of dossier.members) if (mem.avatarUrl) urls.push(proxiedMediaUrl(mem.avatarUrl));
  for (const p of proseByKey.values()) urls.push(...p.images);
  return urls;
}

export interface BuildCtx {
  dossier: WorldExportDossier;
  paper: Paper;
  t: TFunction;
  /** Namespaced lookups outside `worlds` (common:, etc.). */
  tRoot: TFunction;
  kindDefs: WorldEntityKindDef[];
  /** Downloaded images, keyed by the proxied URL they were asked for. */
  assets: Map<string, ImageAsset>;
  proseByKey: Map<string, PreparedProse>;
  /** Rendered Overlook board, if the world has one. */
  overlook: ImageAsset | null;
  siteName: string;
  shareUrl: string;
}

/* ---------- small markup helpers ---------- */

function sectionOpener(kicker: string, title: string, note?: string): string {
  return `<div class="wm-sec">`
    + `<div class="wm-sec-kicker">${esc(kicker)}</div>`
    + `<div class="wm-sec-title">${esc(title)}</div>`
    + (note ? `<div class="wm-sec-note">${esc(note)}</div>` : "")
    + `</div>`;
}

/**
 * A dot-separated run of tags, deliberately NOT bordered pills. See the
 * stylesheet's note on .wm-tags: a box around a short label is where
 * html2canvas's text placement and its geometry visibly disagree, and the
 * words ended up sitting outside their outline.
 */
function tagRun(items: readonly string[], cls = ""): string {
  if (items.length === 0) return "";
  const parts = items.map((c) => `<span class="wm-tag ${cls}">${esc(c)}</span>`);
  return `<div class="wm-tags">${parts.join(`<span class="wm-sep">·</span>`)}</div>`;
}

/** A fixed-size box painted with a downloaded image, or an empty frame when
 *  that image never arrived. Takes the ASSET, not a URL: by this point every
 *  picture in the document is inline bytes. */
function coverBox(asset: ImageAsset | undefined, extraClass: string): string {
  if (!asset) return `<div class="${extraClass}"></div>`;
  return `<div class="${extraClass}" style="background-image:url('${esc(asset.src)}')"></div>`;
}

/** The downloaded asset for a raw (unproxied) author URL, if we got it. */
function assetFor(ctx: BuildCtx, rawUrl: string | null | undefined): ImageAsset | undefined {
  if (!rawUrl) return undefined;
  return ctx.assets.get(proxiedMediaUrl(rawUrl));
}

/* ---------- cover ---------- */

export function buildCover(ctx: BuildCtx): string {
  const { dossier, t } = ctx;
  const w = dossier.world;
  const cover = assetFor(ctx, w.coverImageUrl);
  const meta: string[] = [t(`overview.factValues.genre.${w.genre}`)];
  if (w.pacing) meta.push(t(`overview.factValues.pacing.${w.pacing}`));
  meta.push(t("pdf.coverMembers", { count: w.memberCount }));
  if (w.isNsfw) meta.push(ctx.tRoot("common:rating.nsfw"));

  const art = cover
    ? `<div class="wm-cover-art" style="background-image:url('${esc(cover.src)}')"></div><div class="wm-cover-scrim"></div>`
    : `<div class="wm-cover-plate"></div>`;
  return `<div class="wm-page wm-page--bleed"><div class="wm-cover">
${art}
<div class="wm-cover-foot"><span>${esc(ctx.siteName)}</span><span>${esc(formatDate(dossier.generatedAt, { year: "numeric", month: "long", day: "numeric" }))}</span></div>
<div class="wm-cover-inner">
  <div class="wm-cover-kicker">${esc(t("pdf.coverKicker"))}</div>
  <div class="wm-cover-title">${esc(w.name)}</div>
  <div class="wm-cover-rule"></div>
  <div class="wm-cover-sub">${esc(t("byOwner", { name: w.ownerUsername }))}</div>
  <div class="wm-cover-meta">${meta.map((m) => `<em>${esc(m)}</em>`).join(`<span class="wm-sep">·</span>`)}</div>
</div>
</div></div>`;
}

/* ---------- contents ---------- */

/** Contents rows, built after layout from where each block actually landed. */
export function buildTocBlocks(
  entries: ReadonlyArray<{ label: string; depth: number; page: number }>,
  ctx: BuildCtx,
): Block[] {
  const section = ctx.t("pdf.contents");
  const blocks: Block[] = [
    { html: sectionOpener(ctx.t("pdf.sectionKicker"), section), section, keepWithNext: true },
    { html: `<div class="wm-gap-sm"></div>`, section },
  ];
  const shown = entries.slice(0, TOC_MAX_ROWS);
  for (const e of shown) {
    const depthCls = e.depth >= 2 ? "wm-toc-row--d2" : e.depth === 1 ? "wm-toc-row--d1" : "wm-toc-row--section";
    blocks.push({
      section,
      html: `<div class="wm-toc-row ${depthCls}">`
        + `<span>${esc(e.label)}</span>`
        + `<span class="wm-toc-lead"></span>`
        + `<span class="wm-toc-num">${e.page}</span>`
        + `</div>`,
    });
  }
  if (entries.length > shown.length) {
    blocks.push({
      section,
      html: `<div class="wm-toc-row"><span class="wm-quiet">${esc(ctx.t("pdf.contentsMore", { count: entries.length - shown.length }))}</span></div>`,
    });
  }
  return blocks;
}

/* ---------- body sections ---------- */

export function buildBlocks(ctx: BuildCtx): Block[] {
  const { dossier, t } = ctx;
  const blocks: Block[] = [];
  for (const p of ctx.proseByKey.values()) inlineProseImages(p, ctx.assets);

  blocks.push(...aboutSection(ctx));
  blocks.push(...loreSection(ctx));
  for (const def of ctx.kindDefs) {
    if (def.key === "lore") continue;
    const entries = dossier.entities.filter((e) => e.kind === def.key);
    if (entries.length === 0) continue;
    blocks.push(...entrySection(ctx, def, entries));
  }
  blocks.push(...arcsSection(ctx));
  blocks.push(...sessionsSection(ctx));
  blocks.push(...mapsSection(ctx));
  blocks.push(...overlookSection(ctx));
  blocks.push(...colophon(ctx));
  // A world with nothing in it still deserves a readable file rather than an
  // empty one; the About section always produces at least the description
  // card, so this is only a guard against a future section list going empty.
  if (blocks.length === 0) {
    blocks.push({ html: `<p class="wm-quiet">${esc(t("pdf.empty"))}</p>`, section: t("pdf.contents") });
  }
  return blocks;
}

function aboutSection(ctx: BuildCtx): Block[] {
  const { dossier, t } = ctx;
  const w = dossier.world;
  const section = t("pdf.sectionAbout");
  const out: Block[] = [{
    html: sectionOpener(t("pdf.sectionKicker"), section),
    section,
    breakBefore: true,
    keepWithNext: true,
    toc: { label: section, depth: 0 },
  }];

  out.push({
    section,
    html: w.description
      ? `<div class="wm-lede" style="padding-top:12pt">${esc(w.description).replace(/\n/g, "<br>")}</div>`
      : `<p class="wm-quiet" style="padding-top:12pt">${esc(t("overview.noDescription"))}</p>`,
  });

  if (w.tags.length > 0 || w.contentWarnings.length > 0) {
    out.push({ html: `<div class="wm-gap-sm"></div>`, section });
    if (w.tags.length > 0) out.push({ html: tagRun(w.tags), section });
    if (w.contentWarnings.length > 0) {
      out.push({ html: tagRun(w.contentWarnings.map((c) => `⚠ ${c}`), "wm-tag--warn"), section });
    }
  }

  const facts: Array<[string, string]> = [];
  facts.push([t("overview.facts.genre"), t(`overview.factValues.genre.${w.genre}`)]);
  if (w.pacing) facts.push([t("overview.facts.pacing"), t(`overview.factValues.pacing.${w.pacing}`)]);
  facts.push([t("overview.facts.status"), t(`overview.factValues.status.${w.status}`)]);
  facts.push([t("overview.facts.visibility"), t(`overview.factValues.visibility.${w.visibility}`)]);
  facts.push([t("overview.facts.joinMode"), t(`overview.factValues.joinMode.${w.joinMode ?? "open"}`)]);
  facts.push([t("overview.facts.members"), String(w.memberCount)]);
  facts.push([t("overview.facts.lorePages"), String(dossier.pages.length)]);
  facts.push([t("overview.facts.entries"), String(dossier.entities.length)]);
  if (w.linkedRoomCount > 0) facts.push([t("overview.facts.linkedRooms"), String(w.linkedRoomCount)]);
  facts.push([t("overview.facts.created"), formatDate(w.createdAt, { year: "numeric", month: "short", day: "numeric" })]);
  out.push({ html: `<div class="wm-gap"></div>`, section });
  out.push({
    section,
    html: `<div class="wm-card"><div class="wm-label">${esc(t("pdf.factsLabel"))}</div><div class="wm-facts">`
      + facts.map(([k, v]) => `<div class="wm-fact"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")
      + `</div></div>`,
  });

  const vibe = WORLD_VIBE_AXES
    .map((a) => ({ label: t(`vibeAxes.${a.key}.label`), value: w.vibeStats[a.key] }))
    .filter((a): a is { label: string; value: number } => a.value != null);
  if (vibe.length > 0) {
    out.push({ html: `<div class="wm-gap"></div>`, section });
    out.push({
      section,
      html: `<div class="wm-card"><div class="wm-label">${esc(t("overview.vibe"))}</div><div class="wm-bars">`
        + vibe.map((a) => `<div class="wm-bar">`
          + `<div class="wm-bar-top"><span>${esc(a.label)}</span><span>${a.value}</span></div>`
          + `<div class="wm-bar-track"><div class="wm-bar-fill" style="width:${a.value}%"></div></div>`
          + `</div>`).join("")
        + `</div></div>`,
    });
  }

  if (dossier.members.length > 0) {
    out.push({ html: `<div class="wm-gap"></div>`, section });
    out.push({
      html: `<div class="wm-label">${esc(t("kb.members"))} · ${dossier.members.length}</div>`,
      section,
      keepWithNext: true,
    });
    out.push({
      section,
      html: `<div class="wm-faces">`
        + dossier.members.map((m) => {
          const avatar = assetFor(ctx, m.avatarUrl);
          const face = avatar
            ? coverBox(avatar, "wm-face-img")
            : `<div class="wm-face-init">${esc(m.displayName.slice(0, 2).toUpperCase())}</div>`;
          // Cut to fit the 48pt column: the caption is plain text now, with no
          // CSS clip to hide an overrun (see the stylesheet's note).
          return `<div class="wm-face">${face}<div class="wm-face-name">${esc(clip(m.displayName, 10))}</div></div>`;
        }).join("")
        + `</div>`,
    });
  }

  if (dossier.collaborators.length > 0) {
    out.push({ html: `<div class="wm-gap-sm"></div>`, section });
    out.push({
      section,
      html: `<p class="wm-note">${esc(t("pdf.collaborators", { names: dossier.collaborators.map((c) => c.username).join(", ") }))}</p>`,
    });
  }
  return out;
}

function loreSection(ctx: BuildCtx): Block[] {
  const { dossier, t } = ctx;
  if (dossier.pages.length === 0) return [];
  const section = t("kinds.lore.label");
  const out: Block[] = [{
    html: sectionOpener(t("pdf.sectionKicker"), section, t("kinds.lore.description")),
    section,
    breakBefore: true,
    keepWithNext: true,
    toc: { label: section, depth: 0 },
  }];
  const walk = (nodes: WorldTreeNode[]): void => {
    for (const node of nodes) {
      out.push(...pageBlocks(ctx, node.page, node.depth, section));
      walk(node.children);
    }
  };
  walk(buildWorldTree(dossier.pages));
  return out;
}

function pageBlocks(ctx: BuildCtx, page: WorldPage, depth: number, section: string): Block[] {
  const cls = depth === 0 ? "wm-h1" : depth === 1 ? "wm-h2" : "wm-h3";
  const out: Block[] = [{
    html: `<div class="${cls}">${esc(page.title)}</div>`,
    section,
    keepWithNext: true,
    toc: { label: page.title, depth: Math.min(depth + 1, 2) },
  }];
  const arc = page.arcId ? ctx.dossier.arcs.find((a) => a.id === page.arcId) : null;
  if (arc) out.push({ html: `<div class="wm-note">${esc(arc.title)}</div>`, section, keepWithNext: true });
  out.push(bodyBlock(ctx, `page:${page.id}`, section));
  return out;
}

/** The prose block for a body, or a quiet placeholder when it's empty. */
function bodyBlock(ctx: BuildCtx, key: string, section: string): Block {
  const prose = ctx.proseByKey.get(key);
  if (!prose) return { html: `<p class="wm-quiet">${esc(ctx.t("kb.nothingWritten"))}</p>`, section };
  return { html: prose.el.outerHTML, section };
}

function entrySection(ctx: BuildCtx, def: WorldEntityKindDef, entries: WorldEntity[]): Block[] {
  const { t } = ctx;
  const section = def.label;
  const out: Block[] = [{
    html: sectionOpener(t("pdf.sectionKicker"), def.label, def.description),
    section,
    breakBefore: true,
    keepWithNext: true,
    toc: { label: `${def.label} (${entries.length})`, depth: 0 },
  }];
  for (const e of entries) {
    // No portrait means no frame at all: an empty 74pt box beside the name
    // reads as a broken image rather than as an entry without one.
    const art = assetFor(ctx, e.imageUrl);
    const portrait = art ? coverBox(art, "wm-portrait") : "";
    out.push({
      section,
      keepWithNext: true,
      atomic: true,
      toc: { label: e.name, depth: 1 },
      html: `<div class="wm-entry-head">${portrait}<div style="min-width:0">`
        + `<div class="wm-entry-title">${esc(e.name)}</div>`
        + (e.summary ? `<div class="wm-entry-sub">${esc(e.summary)}</div>` : "")
        + (e.tags.length > 0 ? `<div style="padding-top:4pt">${tagRun(e.tags)}</div>` : "")
        + `</div></div>`,
    });
    const stats = Object.entries(e.stats);
    if (stats.length > 0) {
      out.push({
        section,
        html: `<div class="wm-stats" style="padding-top:6pt">`
          + stats.map(([k, v]) => `<div class="wm-stat"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")
          + `</div>`,
      });
    }
    out.push(bodyBlock(ctx, `entity:${e.id}`, section));
  }
  return out;
}

function arcsSection(ctx: BuildCtx): Block[] {
  const { dossier, t } = ctx;
  if (dossier.arcs.length === 0) return [];
  const section = t("pdf.sectionArcs");
  const out: Block[] = [{
    html: sectionOpener(t("pdf.sectionKicker"), section),
    section,
    breakBefore: true,
    keepWithNext: true,
    toc: { label: section, depth: 0 },
  }];
  for (const a of dossier.arcs) {
    const members = [
      ...dossier.entities.filter((e) => e.arcId === a.id).map((e) => e.name),
      ...dossier.pages.filter((p) => p.arcId === a.id).map((p) => p.title),
      ...dossier.sessions.filter((s) => s.arcId === a.id).map((s) => s.title),
    ];
    out.push({
      section,
      keepWithNext: true,
      toc: { label: a.title, depth: 1 },
      html: `<div class="wm-h2">${esc(a.title)}</div>`
        + `<div class="wm-note">${esc(t(`arcStatus.${a.status}`))}</div>`,
    });
    if (a.summary) out.push({ html: `<div class="wm-prose"><p>${esc(a.summary)}</p></div>`, section });
    if (members.length > 0) out.push({ html: `<div style="padding-top:5pt">${tagRun(members)}</div>`, section });
  }
  return out;
}

function sessionsSection(ctx: BuildCtx): Block[] {
  const { dossier, t } = ctx;
  if (dossier.sessions.length === 0) return [];
  const section = t("pdf.sectionSessions");
  const out: Block[] = [{
    html: sectionOpener(t("pdf.sectionKicker"), section),
    section,
    breakBefore: true,
    keepWithNext: true,
    toc: { label: section, depth: 0 },
  }];
  for (const s of dossier.sessions) {
    const arc = s.arcId ? dossier.arcs.find((a) => a.id === s.arcId) : null;
    const meta = [
      s.sessionDate ? formatDate(s.sessionDate, { year: "numeric", month: "short", day: "numeric" }) : null,
      arc?.title ?? null,
    ].filter(Boolean).join(" · ");
    out.push({
      section,
      keepWithNext: true,
      toc: { label: s.title, depth: 1 },
      html: `<div class="wm-h2">${esc(s.title)}</div>`
        + (meta ? `<div class="wm-note">${esc(meta)}</div>` : ""),
    });
    if (s.summary) out.push({ html: `<div class="wm-prose"><p>${esc(s.summary)}</p></div>`, section });
    out.push(bodyBlock(ctx, `session:${s.id}`, section));
  }
  return out;
}

function mapsSection(ctx: BuildCtx): Block[] {
  const { dossier, t } = ctx;
  if (dossier.maps.length === 0) return [];
  const section = t("kb.tabMap");
  const out: Block[] = [{
    html: sectionOpener(t("pdf.sectionKicker"), section),
    section,
    breakBefore: true,
    keepWithNext: true,
    toc: { label: section, depth: 0 },
  }];
  for (const m of dossier.maps) {
    out.push({
      html: `<div class="wm-h2">${esc(m.map.name)}</div>`,
      section,
      keepWithNext: true,
      toc: { label: m.map.name, depth: 1 },
    });
    out.push(...mapPlate(ctx, m, section));
    const named = m.markers.filter((k) => k.label.trim());
    if (named.length > 0) {
      out.push({
        html: `<div class="wm-label" style="padding-top:9pt">${esc(t("maps.onThisMap"))}</div>`,
        section,
        keepWithNext: true,
      });
      out.push({
        section,
        html: `<div class="wm-tags">`
          + named
            .map((k) => `<span class="wm-tag${k.isSecret ? " wm-tag--warn" : ""}">${esc(k.label)}</span>`)
            .join(`<span class="wm-sep">·</span>`)
          + `</div>`,
      });
    }
  }
  return out;
}

/** One map image with its markers pinned on top, sized from the real file. */
function mapPlate(ctx: BuildCtx, m: WorldExportMap, section: string): Block[] {
  const plate = assetFor(ctx, m.map.imageUrl);
  if (!plate) {
    return [{ html: `<p class="wm-quiet">${esc(ctx.t("pdf.mapUnavailable"))}</p>`, section }];
  }
  const box = fitBox(plate, COLUMN_W_PT, PLATE_MAX_H_PT);
  const pins = m.markers.map((k) => pinHtml(ctx, k)).join("");
  const desc = ctx.proseByKey.get(`map:${m.map.id}`);
  const out: Block[] = [{
    section,
    atomic: true,
    html: `<div class="wm-plate wm-plate-wrap" style="width:${box.w.toFixed(1)}pt;height:${box.h.toFixed(1)}pt;margin-top:6pt">`
      + `<img src="${esc(plate.src)}" width="${Math.round(box.w)}" height="${Math.round(box.h)}" style="width:${box.w.toFixed(1)}pt;height:${box.h.toFixed(1)}pt" alt="">`
      + pins
      + `</div>`,
  }];
  if (desc) out.push({ html: desc.el.outerHTML, section });
  return out;
}

function pinHtml(ctx: BuildCtx, k: WorldMapMarker): string {
  // Marker colours are free text in the database, same as on the live map, so
  // they go through the app's own clamp before landing in a style attribute.
  const color = safeCssColor(k.color)
    ?? safeCssColor(ctx.kindDefs.find((d) => d.key === k.kind)?.color)
    ?? ctx.paper.action;
  const showText = k.labelMode !== "icon" && k.label.trim();
  return `<div class="wm-pin" style="left:${(k.x * 100).toFixed(2)}%;top:${(k.y * 100).toFixed(2)}%">`
    + `<span class="wm-pin-dot" style="background:${esc(color)}"></span>`
    + (showText ? `<span class="wm-pin-text">${esc(k.label)}</span>` : "")
    + `</div>`;
}

function overlookSection(ctx: BuildCtx): Block[] {
  if (!ctx.overlook) return [];
  const { t } = ctx;
  const section = t("kb.tabOverlook");
  // Minus the plate's own 6pt frame on each side, or the board would push the
  // plate past the text column.
  const box = fitBox(ctx.overlook, COLUMN_W_PT - 12, PLATE_MAX_H_PT - 12);
  return [
    {
      html: sectionOpener(t("pdf.sectionKicker"), section, t("pdf.overlookNote")),
      section,
      breakBefore: true,
      keepWithNext: true,
      toc: { label: section, depth: 0 },
    },
    {
      section,
      atomic: true,
      html: `<div class="wm-plate" style="margin-top:10pt;padding:6pt">`
        + `<img src="${esc(ctx.overlook.src)}" width="${Math.round(box.w)}" height="${Math.round(box.h)}" style="width:${box.w.toFixed(1)}pt;height:${box.h.toFixed(1)}pt" alt="">`
        + `</div>`,
    },
  ];
}

function colophon(ctx: BuildCtx): Block[] {
  const { dossier, t } = ctx;
  const section = t("pdf.colophon");
  const lines = [
    t("pdf.colophonSource", { site: ctx.siteName, url: ctx.shareUrl }),
    t("pdf.colophonGenerated", { date: formatDate(dossier.generatedAt, { year: "numeric", month: "long", day: "numeric" }) }),
    t("pdf.colophonCounts", {
      pages: dossier.pages.length,
      entries: dossier.entities.length,
      sessions: dossier.sessions.length,
    }),
    dossier.viewerCanEdit ? t("pdf.colophonEditor") : t("pdf.colophonReader"),
  ];
  return [
    { html: sectionOpener(t("pdf.sectionKicker"), section), section, breakBefore: true, keepWithNext: true, toc: { label: section, depth: 0 } },
    {
      section,
      html: `<div class="wm-colophon" style="padding-top:12pt">`
        + lines.map((l) => `<p style="padding:2pt 0">${esc(l)}</p>`).join("")
        + `</div>`,
    },
  ];
}
