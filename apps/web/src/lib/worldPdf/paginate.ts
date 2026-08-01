/**
 * The paginator: flows a stream of blocks into fixed-size page boxes.
 *
 * This is the difference between a magazine and a long screenshot cut into
 * strips. html2pdf's own pagination slices one tall canvas every page-height
 * pixels, which lands mid-line, mid-portrait and mid-table: the classic
 * html2pdf complaint. Here the page boxes are built at their final size FIRST
 * and content is fitted into them, so a break can only ever fall between
 * blocks (or, for a block too tall to fit anywhere, between its own children
 * or between words). Each page then rasterizes to exactly one PDF page.
 *
 * Measurement is arithmetic, not iterative: every block is measured once in a
 * scratch column of the exact text width, then packed by adding numbers up.
 * That relies on blocks never collapsing margins into each other, which is
 * why the stylesheet spaces everything with padding and zeroes the margins of
 * flow children. Re-measurement only happens for the rare block that has to
 * be split.
 */
import { clip, esc } from "./util.js";

/** Running-head budgets. The head is one nowrap line with no CSS clipping
 *  (see the stylesheet's note on why), so the strings are cut to fit. */
const HEAD_NAME_MAX = 42;
const HEAD_SECTION_MAX = 28;

export interface Block {
  /** Block markup. Author prose is already sanitized by the caller. */
  html: string;
  /** Running-header label for pages this block starts. */
  section: string;
  /** Force a fresh page before this block (section openers). */
  breakBefore?: boolean;
  /** Never leave this block stranded as the last thing on a page. */
  keepWithNext?: boolean;
  /** Record this block's page in the table of contents. */
  toc?: { label: string; depth: number };
  /** Never split this block across pages; move it whole instead. Plates and
   *  portraits look wrong sliced even at a child boundary. */
  atomic?: boolean;
}

export interface TocEntry {
  label: string;
  depth: number;
  page: number;
}

export interface LaidOutPages {
  pages: HTMLElement[];
  toc: TocEntry[];
}

interface Ctx {
  /** Host that already carries the magazine scope class and page width. */
  root: HTMLElement;
  worldName: string;
  /** Print folios on these pages (front matter doesn't get them). */
  numbered: boolean;
  /** Folio of the first page produced. */
  firstFolio: number;
}

/** Build an empty page box and return it plus its flow column. */
function makePage(ctx: Ctx, section: string, folio: number | null): { page: HTMLElement; flow: HTMLElement } {
  const page = document.createElement("div");
  page.className = "wm-page";
  page.innerHTML =
    `<div class="wm-head"><span>${esc(clip(ctx.worldName, HEAD_NAME_MAX))}</span>`
    + `<span>${esc(clip(section, HEAD_SECTION_MAX))}</span></div>`
    + `<div class="wm-flow"></div>`
    + `<div class="wm-foot">${folio === null ? "" : String(folio)}</div>`;
  const flow = page.querySelector<HTMLElement>(".wm-flow")!;
  return { page, flow };
}

/** Parse a block's markup into exactly one element, wrapping if it isn't. */
function toElement(html: string): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  if (holder.childNodes.length === 1 && holder.firstElementChild instanceof HTMLElement) {
    return holder.firstElementChild;
  }
  const wrap = document.createElement("div");
  while (holder.firstChild) wrap.appendChild(holder.firstChild);
  return wrap;
}

/**
 * Split `el` so its first piece fits in `limit` px, returning that piece and
 * the remainder. Recurses through element children, and falls back to a
 * word-level binary search on a text run that is itself taller than a page
 * (one enormous paragraph).
 *
 * Two things are load-bearing:
 *
 *  - The clone is built INSIDE `parent`, which for a recursive call is the
 *    partially-built shell of the element above it. That keeps every
 *    measurement in its real selector context: measuring a `<p>` lifted out
 *    of its `.wm-prose` wrapper would miss the wrapper's rules and report the
 *    wrong height.
 *  - Height is read off `column`, the scratch column itself, so nested
 *    padding and borders on the shells in between are counted.
 *
 * A null head means nothing fits at all, which tells the caller to start a
 * fresh page and try again against a full column.
 */
function splitToFit(
  el: HTMLElement,
  limit: number,
  parent: HTMLElement,
  column: HTMLElement,
): { head: HTMLElement | null; tail: HTMLElement | null } {
  const shell = el.cloneNode(false) as HTMLElement;
  parent.replaceChildren(shell);
  const children = [...el.childNodes];
  const tailFrom = (start: number, lead?: Node | null): HTMLElement | null => {
    const tail = el.cloneNode(false) as HTMLElement;
    if (lead) tail.appendChild(lead);
    for (let k = start; k < children.length; k++) tail.appendChild(children[k]!.cloneNode(true));
    return tail.childNodes.length > 0 ? tail : null;
  };

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    shell.appendChild(child.cloneNode(true));
    if (column.offsetHeight <= limit) continue;
    shell.removeChild(shell.lastChild!);

    // Only split the child that overflowed when nothing has landed yet.
    // Otherwise the cleaner break is simply before it, and cutting would
    // fragment a paragraph for no reason.
    if (shell.childNodes.length === 0) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const inner = splitToFit(child as HTMLElement, limit, shell, column);
        // The recursion built its head inside `shell` already.
        if (!inner.head) shell.replaceChildren();
        return {
          head: shell.childNodes.length > 0 ? shell : null,
          tail: tailFrom(i + 1, inner.tail),
        };
      }
      if (child.nodeType === Node.TEXT_NODE) {
        const words = (child.textContent ?? "").split(/(\s+)/);
        const probe = document.createTextNode("");
        shell.appendChild(probe);
        let lo = 0;
        let hi = words.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          probe.textContent = words.slice(0, mid).join("");
          if (column.offsetHeight <= limit) lo = mid; else hi = mid - 1;
        }
        probe.textContent = words.slice(0, lo).join("");
        const rest = words.slice(lo).join("");
        if (lo === 0) shell.replaceChildren();
        return {
          head: lo > 0 ? shell : null,
          tail: tailFrom(i + 1, rest.trim() ? document.createTextNode(rest) : null),
        };
      }
    }
    return { head: shell.childNodes.length > 0 ? shell : null, tail: tailFrom(i) };
  }
  return { head: shell, tail: null };
}

/**
 * Lay blocks out into pages.
 *
 * The scratch column is a real, laid-out element of the same width as a page's
 * text column, parked inside the (off-screen but ATTACHED) root. Measuring in
 * a detached node would report zero for everything, and measuring at a
 * different width would report the wrong wrap points.
 */
export function layout(blocks: readonly Block[], ctx: Ctx): LaidOutPages {
  const probe = makePage(ctx, "", null);
  ctx.root.appendChild(probe.page);
  const flowStyle = getComputedStyle(probe.flow);
  const columnHeight = probe.flow.clientHeight
    - parseFloat(flowStyle.paddingTop || "0")
    - parseFloat(flowStyle.paddingBottom || "0")
    // Descender guard. The text column clips its overflow, and html2canvas
    // paints text a pixel or two below where it was laid out (see the
    // stylesheet's note on its baseline metric), so a last line packed flush
    // against the bottom edge would come out with its descenders shaved.
    - 6;
  const columnWidth = probe.flow.clientWidth;
  ctx.root.removeChild(probe.page);

  const scratch = document.createElement("div");
  scratch.className = "wm-flow";
  scratch.style.position = "absolute";
  scratch.style.left = "-10000px";
  scratch.style.top = "0";
  scratch.style.width = `${columnWidth}px`;
  scratch.style.height = "auto";
  scratch.style.paddingTop = "0";
  ctx.root.appendChild(scratch);

  const measure = (el: HTMLElement): number => {
    scratch.replaceChildren(el);
    const h = el.offsetHeight;
    scratch.replaceChildren();
    return h;
  };

  // One pass to turn markup into elements and learn every height. Blocks are
  // measured individually rather than as one stack so a later split can reuse
  // the same numbers.
  const items = blocks.map((b) => {
    const el = toElement(b.html);
    return { block: b, el, height: measure(el) };
  });

  const pages: HTMLElement[] = [];
  const toc: TocEntry[] = [];
  let folio = ctx.firstFolio;
  let current = makePage(ctx, items[0]?.block.section ?? "", ctx.numbered ? folio : null);
  let used = 0;

  const startPage = (section: string) => {
    pages.push(current.page);
    folio += 1;
    current = makePage(ctx, section, ctx.numbered ? folio : null);
    used = 0;
  };

  for (let i = 0; i < items.length; i++) {
    const { block, el, height } = items[i]!;
    if (block.breakBefore && used > 0) startPage(block.section);
    // A heading that would sit alone at the foot of a page is pulled to the
    // next one with the block it introduces.
    if (block.keepWithNext && used > 0) {
      const next = items[i + 1];
      const together = height + Math.min(next?.height ?? 0, columnHeight * 0.35);
      if (used + together > columnHeight) startPage(block.section);
    }

    // The contents entry records where the block's first line actually
    // LANDS, so it has to wait until placement resolves. Reading the folio
    // up front would cite the page we were about to leave.
    let tocPending = block.toc ?? null;
    const noteToc = () => {
      if (!tocPending) return;
      toc.push({ label: tocPending.label, depth: tocPending.depth, page: folio });
      tocPending = null;
    };

    let remaining: HTMLElement | null = el;
    let guard = 0;
    while (remaining && guard++ < 400) {
      const free = columnHeight - used;
      const h = remaining === el ? height : measure(remaining);
      if (h <= free) {
        noteToc();
        current.flow.appendChild(remaining);
        used += h;
        remaining = null;
        break;
      }
      if (h <= columnHeight || block.atomic) {
        // Fits on a page of its own, or refuses to be cut. Move it whole.
        if (used > 0) { startPage(block.section); continue; }
        // Taller than any page and unsplittable: let it ride and be clipped
        // rather than loop forever. Only reachable for an atomic plate whose
        // own sizing already caps it, so in practice this is unreachable.
        noteToc();
        current.flow.appendChild(remaining);
        used = columnHeight;
        remaining = null;
        break;
      }
      // Genuinely taller than a page: cut it.
      if (free < columnHeight * 0.12 && used > 0) { startPage(block.section); continue; }
      const { head, tail } = splitToFit(remaining, free, scratch, scratch);
      if (!head) {
        if (used === 0) break; // nothing fits even on an empty page; drop it
        startPage(block.section);
        continue;
      }
      noteToc();
      // Read the fragment's height while it is still in the scratch column:
      // the page boxes are detached until the very end, so anything appended
      // to one measures zero.
      const headHeight = head.offsetHeight;
      current.flow.appendChild(head);
      remaining = tail;
      if (remaining) {
        used = columnHeight;
        startPage(block.section);
      } else {
        // Last fragment. Crediting a full column here would push the next
        // block onto a fresh page for no reason.
        used += headHeight;
      }
    }
  }
  if (current.flow.childNodes.length > 0 || pages.length === 0) pages.push(current.page);

  ctx.root.removeChild(scratch);
  return { pages, toc };
}
