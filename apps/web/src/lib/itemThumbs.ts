/**
 * Point a small item icon at its generated thumbnail instead of the full-size
 * artwork.
 *
 * The bundled shop art is 600x600 alpha PNGs at roughly 260KB each, and the
 * surfaces that show them small (catalog cards at 80-112px, profile item tiles
 * at 64-128px, list rows at 32-48px) were each pulling the whole thing. A
 * populated trophy case or shop page ran to about 10MB of images.
 * scripts/build-item-thumbs.mjs derives a 256px WebP next to each original at
 * build time; this is the half that uses them.
 *
 * Deliberately NOT applied to pets or the pinned detail view. Those genuinely
 * render at 192-256px, where the thumbnail would be doing no work and could
 * show its resampling.
 *
 * Only the bundled `/assets/items/*.png` set is rewritten. An admin-supplied
 * icon URL, an upload, or anything already pointing elsewhere passes straight
 * through: no thumbnail was generated for it, so there is nothing to point at.
 */
import type { SyntheticEvent } from "react";

/** Bundled item art, which is the only thing the build generates thumbs for. */
const BUNDLED_ITEM_ART = /^\/assets\/items\/([A-Za-z0-9._-]+)\.png$/;

/** Marks an <img> that has already fallen back, so a missing thumbnail can't
 *  loop between the two sources. */
const FELL_BACK = "itemThumbFallback";

/** The generated thumbnail for a bundled item icon, or null when the URL isn't
 *  one (or is already something else entirely). */
export function itemThumbUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = BUNDLED_ITEM_ART.exec(url);
  if (!m) return null;
  return `/assets/items/thumbs/${m[1]}.webp`;
}

/**
 * `src` + `onError` for an item icon rendered small.
 *
 * The fallback is what makes the whole thing safe to deploy: thumbnails are
 * generated during the web build, and if that step was skipped (sharp has no
 * usable native binary on this machine, say) the thumb 404s and the icon
 * quietly reverts to the original PNG. Worst case is today's behaviour, never
 * a broken image.
 */
export function itemThumbProps(url: string): {
  src: string;
  onError: (e: SyntheticEvent<HTMLImageElement>) => void;
} {
  const thumb = itemThumbUrl(url);
  return {
    src: thumb ?? url,
    onError: (e) => {
      const img = e.currentTarget;
      if (!thumb || img.dataset[FELL_BACK] === "1") return;
      img.dataset[FELL_BACK] = "1";
      img.src = url;
    },
  };
}
