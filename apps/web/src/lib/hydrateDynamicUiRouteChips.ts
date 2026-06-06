/**
 * Post-mount hydration for dynamic UI-route chips embedded in
 * server-sanitized HTML surfaces (the BannerMarquee body + the
 * scheduled-announce `bodyHtml` render path in MessageList).
 *
 * Static chips ({rules}, {shop}, …) render their final label up-front
 * from the catalog and need nothing extra. Dynamic chips
 * ({scriptorium:latest:story}) carry a `data-tk-ui-route-dynamic`
 * marker added by `renderUiRouteChipsInHtml`, this helper scans for
 * that marker, fetches the resolved label, and rewrites the
 * `.tk-ui-route-chip-label` span in place.
 *
 * Idempotent: re-running on the same container with the same
 * elements is a no-op once the spans have been swapped (the chip
 * stores the resolved label as the span's text content; subsequent
 * runs see the same text and the fetch result short-circuits via
 * the shared TTL cache in `latestStory.ts`).
 *
 * Cancellation: the returned cleanup flips a local flag so an
 * in-flight fetch that resolves after the component unmounts can't
 * write into a detached DOM node.
 */

import { fetchLatestPublishedStory } from "./latestStory.js";

/**
 * Hydrate every dynamic UI-route chip inside `container`. Returns a
 * cleanup function that cancels any in-flight fetches.
 */
export function hydrateDynamicUiRouteChips(container: HTMLElement): () => void {
  let cancelled = false;
  // querySelectorAll returns a snapshot, safe to iterate without
  // worrying about mid-iteration DOM mutations from the hydrator's
  // own writes.
  const latestStoryChips = container.querySelectorAll<HTMLElement>(
    '[data-tk-ui-route-dynamic="latest-story"]',
  );
  if (latestStoryChips.length > 0) {
    void fetchLatestPublishedStory().then((r) => {
      if (cancelled || !r?.title) return;
      for (const chip of Array.from(latestStoryChips)) {
        // Rewrite the dedicated label span only, leaves the leading
        // icon span (📖) intact. Falling back to the chip's plain
        // textContent setter would erase the icon glyph.
        const labelSpan = chip.querySelector<HTMLElement>(".tk-ui-route-chip-label");
        if (labelSpan) labelSpan.textContent = r.title;
      }
    });
  }
  return () => {
    cancelled = true;
  };
}
