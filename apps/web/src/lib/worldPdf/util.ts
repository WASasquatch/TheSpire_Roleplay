/**
 * Small shared helpers for the world-to-PDF typesetter: HTML escaping, the
 * same-origin image rewrite, and the image download pass.
 */

/** Escape a string for interpolation into an HTML text or attribute slot. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Rewrite a remote image URL through our same-origin proxy.
 *
 * This is not optional decoration. The whole magazine is rasterized with
 * html2canvas, which paints into a `<canvas>` and reads it back out, and a
 * single cross-origin image without CORS headers TAINTS that canvas, so
 * `toDataURL` throws and the entire export dies. `useCORS` isn't a fix
 * either: it just makes non-CORS hosts fail to load, so every hotlinked
 * portrait in the world would come out as a blank rectangle.
 *
 * Same-origin paths (`/uploads/…`) and data URLs pass through untouched.
 */
export function proxiedMediaUrl(url: string): string {
  const u = url.trim();
  if (!u) return u;
  if (u.startsWith("data:") || u.startsWith("blob:")) return u;
  if (u.startsWith("/")) return u;
  try {
    const parsed = new URL(u, window.location.href);
    if (parsed.origin === window.location.origin) return parsed.pathname + parsed.search;
    // http:// would be refused by the proxy (and blocked as mixed content
    // anyway); leave it alone so it fails visibly as one missing image
    // rather than as a proxy error.
    if (parsed.protocol !== "https:") return u;
    return `/media/image?u=${encodeURIComponent(parsed.toString())}`;
  } catch {
    return u;
  }
}

/**
 * One downloaded image, inlined.
 *
 * `src` is what the magazine actually renders: a `data:` URL holding the
 * bytes, so by the time anything is rasterized the picture is already in the
 * document and no network fetch can fail, time out, or be rate-limited.
 * `w`/`h` are the ORIGINAL natural pixel dimensions, which is what the layout
 * math sizes plates from.
 */
export interface ImageAsset {
  src: string;
  w: number;
  h: number;
}

/** Refuse anything that isn't plausibly an image, and anything absurd. */
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
/**
 * Total inlined payload before we stop embedding and fall back to plain URLs.
 * Data URLs are base64, so ~4/3 of the wire bytes, and every one of them is
 * held in memory for the length of the run.
 */
const MAX_TOTAL_CHARS = 44 * 1024 * 1024;
/**
 * Re-encode anything bigger than this on its longest edge. Nothing is ever
 * drawn wider than the text column (about 671 CSS px) at 2x capture scale, so
 * 1600 is already more resolution than the page can show; a 6000px map just
 * costs memory and decode time.
 */
const MAX_EDGE = 1600;
/** Below this, keep the original bytes rather than re-encoding: no quality
 *  loss, no alpha loss, and no point. */
const REENCODE_OVER_BYTES = 1.5 * 1024 * 1024;
/** Parallel downloads. Enough to be quick, few enough to be polite. */
const CONCURRENCY = 6;

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

function decode(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const done = (v: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    img.onload = () => done(img.naturalWidth > 0 ? img : null);
    img.onerror = () => done(null);
    window.setTimeout(() => done(null), 15_000);
    img.src = src;
  });
}

/** Best available lossless-ish container that keeps transparency. */
function reencode(img: HTMLImageElement): string | null {
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  try {
    // WebP keeps the alpha channel, which JPEG would flatten to black behind
    // every cut-out portrait. Browsers that don't know it hand back a PNG,
    // which is bigger but correct.
    const webp = canvas.toDataURL("image/webp", 0.92);
    if (webp.startsWith("data:image/webp")) return webp;
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Download one image and inline it.
 *
 * Fetched with credentials because the proxy is auth-gated, and read into a
 * `data:` URL rather than left as a link. That is the whole point of this
 * pass: html2canvas builds a FRESH image cache on every call, and the
 * renderer calls it once per page, so a URL-referenced portrait is
 * re-requested for every page it appears on. Inlining downloads each file
 * exactly once, and after that the capture cannot fail on a network hiccup,
 * a timeout, or the proxy's own rate limit.
 *
 * Never throws: a dead link resolves null and the caller drops the picture.
 */
async function loadImageAsset(url: string): Promise<ImageAsset | null> {
  let blob: Blob;
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    blob = await res.blob();
  } catch {
    return null;
  }
  if (blob.size === 0 || blob.size > MAX_SOURCE_BYTES) return null;
  if (blob.type && !blob.type.startsWith("image/")) return null;

  const original = await blobToDataUrl(blob);
  if (!original) return null;
  const img = await decode(original);
  if (!img) return null;

  const oversized = Math.max(img.naturalWidth, img.naturalHeight) > MAX_EDGE;
  const src = (oversized || blob.size > REENCODE_OVER_BYTES ? reencode(img) : null) ?? original;
  // Natural dimensions stay the ORIGINAL ones: the layout sizes plates from
  // them, and a re-encoded copy has the same aspect ratio but fewer pixels.
  return { src, w: img.naturalWidth, h: img.naturalHeight };
}

/**
 * Download every image the magazine needs, keyed by the URL that was asked
 * for. Runs a few at a time, and stops inlining once the accumulated payload
 * would be unreasonable: past that point an image keeps its URL, which still
 * renders through html2canvas's own loader, just less reliably.
 */
export async function loadImageAssets(urls: readonly string[]): Promise<Map<string, ImageAsset>> {
  const unique = [...new Set(urls.filter(Boolean))];
  const out = new Map<string, ImageAsset>();
  let total = 0;
  let index = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = index++;
      const url = unique[i];
      if (url === undefined) return;
      const asset = await loadImageAsset(url);
      if (!asset) continue;
      if (total + asset.src.length > MAX_TOTAL_CHARS) {
        out.set(url, { src: url, w: asset.w, h: asset.h });
        continue;
      }
      total += asset.src.length;
      out.set(url, asset);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, () => worker()));
  return out;
}

/**
 * Hard-truncate a label to `max` characters.
 *
 * Truncation happens HERE rather than in CSS because html2canvas does not
 * implement `text-overflow: ellipsis` at all: an `overflow: hidden` box just
 * clips the glyphs, and since it paints text at its own computed baseline the
 * cut lands mid-letter rather than at the box edge. That is what sliced the
 * running head in half. A character count is crude next to a real measured
 * ellipsis, but it is exact in the output, which matters more.
 */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Filename-safe slug for the saved file. */
export function safeFilename(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return base || "world";
}
