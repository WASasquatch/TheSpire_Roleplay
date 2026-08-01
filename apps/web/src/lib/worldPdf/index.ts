/**
 * "Export this world as a magazine": the whole pipeline, behind one call.
 *
 * Everything heavy lives in this folder so the entry point can be reached by
 * a dynamic `import()`: html2pdf, html2canvas, jsPDF and (for worlds with a
 * board) Excalidraw add up to megabytes that nobody should download to read
 * chat.
 *
 * Order of operations, and why:
 *
 *   1. Fetch the dossier. One request; the viewer's payload deliberately
 *      omits bodies and markers (see the route's own note).
 *   2. Prepare author prose. Sanitize, colour-nudge against the world's paper
 *      and decorate cross-link chips, BEFORE anything is measured, because
 *      all three change how text wraps.
 *   3. Render the Overlook board to a plate, if there is one.
 *   4. DOWNLOAD every image and inline it as a `data:` URL. Two reasons, both
 *      load-bearing: the paginator packs pages arithmetically, so an `<img>`
 *      of unknown size measures zero and silently overflows its page; and
 *      html2canvas builds a fresh image cache per call while the renderer
 *      calls it once per page, so a URL-referenced picture is re-fetched for
 *      every page it appears on and can quietly drop out of the document.
 *   5. Lay out the body, then build the contents from where things landed,
 *      then lay the contents out too. Two passes, no guessing: front matter
 *      is unnumbered and the folio starts at the first body page, so the
 *      length of the contents can't shift the numbers it prints.
 *   6. Rasterize page by page.
 *
 * The whole document is built in a real, attached, off-screen subtree rather
 * than a detached fragment: measurement needs layout, layout needs the
 * document's fonts and stylesheets, and html2canvas needs images that have
 * actually loaded.
 */
import type { TFunction } from "i18next";
import type { Theme, WorldExportDossier } from "@thekeep/shared";
import { readError } from "../http.js";
import { createNonceStyleTag } from "../injectStyle.js";
import { themeStyle } from "../theme.js";
import {
  buildBlocks,
  buildCover,
  buildTocBlocks,
  collectImageUrls,
  kindDefsFor,
  prepareProse,
  type BuildCtx,
  type PreparedProse,
} from "./content.js";
import { layout } from "./paginate.js";
import { renderOverlookPlate } from "./overlookPlate.js";
import { renderPagesToPdf } from "./render.js";
import { magazineCss, paperFrom } from "./styles.js";
import { loadImageAssets, safeFilename } from "./util.js";

export interface ExportWorldPdfOpts {
  worldId: string;
  /** Viewer's active palette, used when the world hasn't set one of its own. */
  viewerTheme: Theme;
  /** `worlds` namespace. */
  t: TFunction;
  /** Root translator, for `common:` keys. */
  tRoot: TFunction;
  siteName: string;
  /** Progress ticks for the button's label: a stage key, then page counts. */
  onProgress?: (stage: "fetching" | "composing" | "rendering", done?: number, total?: number) => void;
}

async function fetchDossier(worldId: string): Promise<WorldExportDossier> {
  const r = await fetch(`/worlds/${encodeURIComponent(worldId)}/export`, { credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as WorldExportDossier;
}

/** Custom properties need `setProperty`; only plain names can be assigned. */
function applyThemeVars(el: HTMLElement, theme: Theme): void {
  for (const [key, value] of Object.entries(themeStyle(theme))) {
    if (value == null) continue;
    if (key.startsWith("--")) el.style.setProperty(key, String(value));
    else (el.style as unknown as Record<string, string>)[key] = String(value);
  }
}

export async function exportWorldPdf(opts: ExportWorldPdfOpts): Promise<void> {
  const { t, tRoot, siteName } = opts;
  opts.onProgress?.("fetching");
  const dossier = await fetchDossier(opts.worldId);

  const theme = dossier.world.theme ?? opts.viewerTheme;
  const paper = paperFrom(theme);
  // Unique per run so a second export never inherits the first world's
  // palette from a cached stylesheet.
  const scope = `wm-${Math.random().toString(36).slice(2, 9)}`;

  const styleTag = createNonceStyleTag();
  styleTag.textContent = magazineCss(scope, paper);
  document.head.appendChild(styleTag);

  const root = document.createElement("div");
  root.className = scope;
  root.setAttribute("aria-hidden", "true");
  // Off-screen but LAID OUT. `display:none` or a detached node would measure
  // every block as zero height and the paginator would pack one endless page.
  root.style.position = "fixed";
  root.style.left = "-20000px";
  root.style.top = "0";
  root.style.zIndex = "-1";
  root.style.pointerEvents = "none";
  applyThemeVars(root, theme);
  document.body.appendChild(root);

  try {
    opts.onProgress?.("composing");

    const proseByKey = new Map<string, PreparedProse>();
    const addProse = (key: string, html: string) => {
      const prepared = prepareProse(html, paper);
      if (prepared) proseByKey.set(key, prepared);
    };
    for (const p of dossier.pages) addProse(`page:${p.id}`, p.bodyHtml);
    for (const e of dossier.entities) addProse(`entity:${e.id}`, e.bodyHtml);
    for (const s of dossier.sessions) addProse(`session:${s.id}`, s.bodyHtml);
    for (const m of dossier.maps) addProse(`map:${m.map.id}`, m.map.description);

    const overlook = dossier.overlookSceneJson
      ? await renderOverlookPlate(dossier.overlookSceneJson, theme)
      : null;

    const assets = await loadImageAssets(collectImageUrls(dossier, proseByKey));
    // Web fonts settle the metrics the paginator is about to measure; a page
    // measured in the fallback face and drawn in the real one overflows.
    if (document.fonts?.ready) await document.fonts.ready;

    const ctx: BuildCtx = {
      dossier,
      paper,
      t,
      tRoot,
      kindDefs: kindDefsFor(dossier, t),
      assets,
      proseByKey,
      overlook,
      siteName,
      shareUrl: `${window.location.origin}/w/${dossier.world.slug}`,
    };

    const body = layout(buildBlocks(ctx), {
      root,
      worldName: dossier.world.name,
      numbered: true,
      firstFolio: 1,
    });
    const contents = layout(buildTocBlocks(body.toc, ctx), {
      root,
      worldName: dossier.world.name,
      numbered: false,
      firstFolio: 0,
    });

    const coverHost = document.createElement("div");
    coverHost.innerHTML = buildCover(ctx);
    const cover = coverHost.firstElementChild as HTMLElement | null;

    const pages = [...(cover ? [cover] : []), ...contents.pages, ...body.pages];
    // Each page ships to html2pdf inside its own scope carrier: the capture
    // clones the element into a container hanging off <body>, where a rule
    // written as `.wm-xxxxx .wm-page` would no longer match without one.
    const sheets = pages.map((page) => {
      const sheet = document.createElement("div");
      sheet.className = scope;
      applyThemeVars(sheet, theme);
      sheet.appendChild(page);
      root.appendChild(sheet);
      return sheet;
    });

    opts.onProgress?.("rendering", 0, sheets.length);
    await renderPagesToPdf(sheets, {
      filename: `${safeFilename(dossier.world.name)}.pdf`,
      paperBg: paper.bg,
      title: dossier.world.name,
      author: dossier.world.ownerUsername,
      subject: t("pdf.docSubject", { site: siteName }),
      creator: siteName,
      onPage: (done, total) => opts.onProgress?.("rendering", done, total),
    });
  } finally {
    root.remove();
    styleTag.remove();
  }
}
