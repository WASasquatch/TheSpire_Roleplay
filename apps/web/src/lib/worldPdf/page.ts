/**
 * Page geometry for the world magazine.
 *
 * Everything is expressed in POINTS because that is the unit html2pdf hands
 * to jsPDF, and because the two have to agree exactly or pages split in the
 * wrong place. html2pdf lays the source out in a container whose width it
 * sets to `pageSize.inner.width + unit` (with a zero margin that is the
 * full A4 width), then slices the resulting canvas every `canvas.width * ratio`
 * pixels. So our own page boxes are sized in the same unit against the same
 * numbers, and the browser does the pt→px conversion for both.
 *
 * `PAGE_H_PT` is deliberately a couple of points SHORT of a real A4 page.
 * html2pdf decides the page count with `Math.ceil(canvas.height /
 * floor(canvas.width * ratio))`, all of which are integers rounded from
 * fractional CSS pixels; a page box that measures one pixel over the line
 * produces a second, blank PDF page for every page in the document. Coming in
 * under the line costs a hairline strip at the foot of each page instead,
 * and that strip is painted in the world's paper colour by the pre-fill in
 * render.ts, so it is invisible rather than white.
 */

/** A4 portrait, in points, matching jsPDF's own `a4` format. */
export const SHEET_W_PT = 595.28;
export const SHEET_H_PT = 841.89;

/** The page box we actually lay out and rasterize. See the note above. */
export const PAGE_W_PT = SHEET_W_PT;
export const PAGE_H_PT = SHEET_H_PT - 2;

/** Printable margins inside a page box. */
export const MARGIN = { top: 34, side: 46, bottom: 30 } as const;

/** jsPDF document options; must match what html2pdf is told, or the slice
 *  math and the page size disagree. */
export const JSPDF_OPTS = {
  unit: "pt" as const,
  format: "a4" as const,
  orientation: "portrait" as const,
  compress: true,
};
