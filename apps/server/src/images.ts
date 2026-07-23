/**
 * Server-side image rendering for the background / social-card pipeline.
 *
 * Historically the Spire background art variants (2560w WebP + AVIF + a
 * sampled base color) were produced offline with ffmpeg and committed to
 * apps/web/public. This module brings that pipeline into the app so the
 * global admin (site backgrounds, OG card) and server owners (per-server
 * background override) can upload art and get the same variant set
 * generated on the spot.
 *
 * sharp runs its pixel work on the libuv threadpool, so these calls do
 * not block the event loop — important because this server runs
 * synchronous SQLite on the main thread.
 *
 * Quality settings mirror the offline pipeline (WebP q87, AVIF ~q60,
 * JPEG q88 for the OG card): backgrounds show through the glass design's
 * translucent panels, where encoder blocking is far more visible than in
 * ordinary page images.
 */
import sharp from "sharp";

/** Longest-edge width for background display variants — matches the
 *  committed static art (2560w covers 1440p desktops; phones downscale). */
const BG_MAX_WIDTH = 2560;
/** Standard large social-card size (og:image / twitter:image). */
export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;

/**
 * The rendered variant bundle for one background image. URLs are filled
 * in by the caller (this module only produces bytes); `color` is the
 * image's average color, painted under the image layer so the surface
 * never flashes white before the art decodes.
 */
export interface RenderedBackground {
  webp: Buffer;
  avif: Buffer;
  /** `#rrggbb` average color of the source. */
  color: string;
  width: number;
  height: number;
}

/**
 * Decode + validate an image for background use, then render the
 * display variants. Throws BackgroundRenderError with a stable `code`
 * on invalid input (caller maps codes to localized messages).
 *
 * `rotate()` (no args) applies EXIF orientation so a phone photo
 * uploaded as a background doesn't render sideways; metadata is
 * stripped by re-encoding (sharp drops EXIF unless asked to keep it).
 */
export async function renderBackgroundVariants(bytes: Buffer): Promise<RenderedBackground> {
  const meta = await probeImage(bytes);
  const base = sharp(bytes, { animated: false }).rotate();
  const resized = base.resize({ width: BG_MAX_WIDTH, withoutEnlargement: true });
  // effort 3 keeps AVIF encode of a 2560w frame in the low seconds on
  // the prod machine; higher efforts double the time for ~2-4% bytes.
  const [webp, avif, color] = await Promise.all([
    resized.clone().webp({ quality: 87 }).toBuffer(),
    resized.clone().avif({ quality: 60, effort: 3 }).toBuffer(),
    averageColor(bytes),
  ]);
  const outWidth = Math.min(meta.width, BG_MAX_WIDTH);
  const outHeight = Math.round(meta.height * (outWidth / meta.width));
  return { webp, avif, color, width: outWidth, height: outHeight };
}

/**
 * Render the 1200x630 social card (JPEG — the format every scraper
 * accepts; some still mishandle WebP/AVIF cards). Cover-fit with
 * attention-based cropping so a wide background keeps its subject
 * rather than blindly center-cropping.
 */
export async function renderOgCard(bytes: Buffer): Promise<Buffer> {
  await probeImage(bytes);
  return sharp(bytes, { animated: false })
    .rotate()
    .resize(OG_CARD_WIDTH, OG_CARD_HEIGHT, { fit: "cover", position: sharp.strategy.attention })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

/** Average color of the whole image as `#rrggbb` (box-filter to 1x1). */
async function averageColor(bytes: Buffer): Promise<string> {
  const { data } = await sharp(bytes, { animated: false })
    .rotate()
    .resize(1, 1, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hex = (n: number | undefined) => Math.max(0, Math.min(255, n ?? 0)).toString(16).padStart(2, "0");
  return `#${hex(data[0])}${hex(data[1])}${hex(data[2])}`;
}

export class BackgroundRenderError extends Error {
  constructor(
    /** Stable machine code the route maps to a localized user message. */
    public readonly code: "unreadable" | "tooSmall",
  ) {
    super(`background render failed: ${code}`);
  }
}

/**
 * Probe the source and reject inputs sharp can't decode or that are too
 * small to serve as a full-viewport background (upscaling a tiny image
 * to 2560w just produces mush; better to tell the uploader). sharp's
 * default limitInputPixels (~268 MP) already guards decompression bombs.
 */
async function probeImage(bytes: Buffer): Promise<{ width: number; height: number }> {
  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(bytes, { animated: false }).metadata();
  } catch {
    throw new BackgroundRenderError("unreadable");
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 640 || height < 360) throw new BackgroundRenderError("tooSmall");
  return { width, height };
}
