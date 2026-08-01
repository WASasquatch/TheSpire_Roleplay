/**
 * Rasterize the laid-out page boxes into a PDF with html2pdf.
 *
 * html2pdf is used ONE PAGE AT A TIME rather than in its usual
 * "hand it the whole document" mode, for two reasons:
 *
 *  1. Correctness. Its built-in pagination slices a single tall canvas every
 *     page-height pixels, which cuts through lines of text and portraits.
 *     The paginator has already decided where the breaks go, so each page box
 *     is captured on its own and lands on exactly one PDF page.
 *  2. Memory. A forty-page magazine as one canvas is ~1600 x 90,000 pixels,
 *     which exceeds the per-canvas area limit in Safari and costs half a
 *     gigabyte in Chrome. Page-sized canvases are ~3.5 megapixels each and
 *     are released as the run proceeds.
 *
 * The jsPDF document is created here rather than by html2pdf so every page
 * can be flooded with the world's paper colour BEFORE its image is drawn.
 * `page.ts` deliberately lays out slightly short of a real A4 sheet to
 * guarantee html2pdf never emits a spurious second page; the pre-fill is what
 * makes the resulting hairline at the foot of each page the paper's colour
 * instead of white. It also carries the document metadata.
 */
import html2pdf from "html2pdf.js";
import { jsPDF } from "jspdf";
import { CSP_NONCE } from "../cspNonce.js";
import { JSPDF_OPTS, SHEET_H_PT, SHEET_W_PT } from "./page.js";

/**
 * Rebuild every stylesheet inside html2canvas's clone so it carries a valid
 * nonce in the document it will actually be parsed in.
 *
 * html2canvas reads computed styles from an iframe it `adoptNode`s the whole
 * document into, and adoption re-runs CSP's nonce-hiding step against a
 * content attribute the browser blanked when the element was first inserted.
 * The internal nonce is wiped, a strict `style-src 'self' 'nonce-…'` drops the
 * sheet, and the page rasterizes with NO styling: right in dev, where there is
 * no CSP, and catastrophically wrong in production.
 *
 * `reassertStyleNonce` puts the value back before capture, which should be
 * enough on its own. This runs in the clone as well because the failure is
 * silent and total, and a freshly created element that carries the nonce at
 * insertion time is allowed with no reliance on how adoption treats the
 * internal slot. Text content survives a blocked sheet, so rebuilding from it
 * is lossless.
 */
function renonceClonedStyles(doc: Document): void {
  if (!CSP_NONCE) return;
  doc.querySelectorAll("style").forEach((old) => {
    const fresh = doc.createElement("style");
    fresh.setAttribute("nonce", CSP_NONCE);
    fresh.textContent = old.textContent;
    old.replaceWith(fresh);
  });
}

/**
 * The bit of html2pdf's worker we actually drive.
 *
 * Its shipped typings declare `then` as returning a bare `Promise`, but the
 * worker is a Promise SUBCLASS whose `then` returns another worker, which is
 * the whole basis of its chaining API, and the one method we need mid-chain
 * to add and flood a page between captures. Declaring the real contract here
 * beats casting at every link.
 */
interface PdfWorker {
  set(options: unknown): PdfWorker;
  from(src: HTMLElement): PdfWorker;
  toContainer(): PdfWorker;
  toCanvas(): PdfWorker;
  toPdf(): PdfWorker;
  then(onFulfilled?: (value: unknown) => unknown): PdfWorker;
  catch(onRejected?: (reason: unknown) => unknown): PdfWorker;
}

export interface RenderOpts {
  filename: string;
  /** `#rrggbb` paper colour, flooded behind every page. */
  paperBg: string;
  title: string;
  author: string;
  subject: string;
  creator: string;
  /** Called after each page is committed, for the progress chip. */
  onPage?: (done: number, total: number) => void;
}

function rgbOf(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return [255, 255, 255];
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export async function renderPagesToPdf(pages: readonly HTMLElement[], opts: RenderOpts): Promise<void> {
  if (pages.length === 0) throw new Error("nothing to export");

  const pdf = new jsPDF(JSPDF_OPTS);
  pdf.setProperties({
    title: opts.title,
    author: opts.author,
    subject: opts.subject,
    creator: opts.creator,
  });
  const [r, g, b] = rgbOf(opts.paperBg);
  const floodPage = () => {
    pdf.setFillColor(r, g, b);
    pdf.rect(0, 0, SHEET_W_PT, SHEET_H_PT, "F");
  };
  floodPage();

  const options = {
    margin: 0,
    filename: opts.filename,
    // JPEG, not PNG: a full-page 1600x2250 plate of textured paper is a
    // megabyte or three as PNG and a fraction of that as a high-quality
    // JPEG, and at ~190 DPI the difference is invisible in print.
    image: { type: "jpeg", quality: 0.95 },
    // OFF deliberately. html2pdf's hyperlink plugin derives each link's page
    // from its offset within the capture container, which is always one page
    // here, so every link in the document would be stamped onto page one.
    enableLinks: false,
    // No element in a page box asks for a break, and the plugin's default
    // modes call getComputedStyle on every element in the tree once per page.
    pagebreak: { mode: [], before: [], after: [], avoid: [] },
    html2canvas: {
      scale: 2,
      backgroundColor: null,
      logging: false,
      // Every image is same-origin by the time it gets here (see
      // util.proxiedMediaUrl), so this only matters for the odd URL the
      // proxy declined to rewrite.
      useCORS: true,
      imageTimeout: 20_000,
      removeContainer: true,
      onclone: renonceClonedStyles,
    },
    jsPDF: JSPDF_OPTS,
    pdf,
  };

  // `set` also accepts `pdf` and `pagebreak`, which the shipped typings don't
  // model (they only describe the handful of options in the README).
  let worker = (html2pdf() as unknown as PdfWorker)
    .set(options)
    .from(pages[0]!)
    .toPdf()
    .then(() => { opts.onPage?.(1, pages.length); });

  for (let i = 1; i < pages.length; i++) {
    const pageEl = pages[i]!;
    const done = i + 1;
    worker = worker
      // Inside the chain, not the loop body: the new page has to be added
      // after the previous capture has been drawn, not while it is queued.
      .then(() => { pdf.addPage(); floodPage(); })
      // Clearing the cached canvas is what makes `toPdf` re-render instead of
      // stamping the previous page's image again.
      .set({ canvas: null })
      .from(pageEl)
      .toContainer()
      .toCanvas()
      .toPdf()
      .then(() => { opts.onPage?.(done, pages.length); });
  }

  // The worker IS a promise at runtime; the local interface above only
  // models the chaining half of it.
  await (worker as unknown as Promise<unknown>);
  pdf.save(opts.filename);
}
