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

import { resolveUiRoute } from "@thekeep/shared";
import { resolveDynamicChipLabel } from "./uiRouteDynamicLabel.js";

/**
 * Hydrate every dynamic UI-route chip inside `container`. Returns a
 * cleanup function that cancels any in-flight fetches.
 *
 * Generic over every dynamic chip kind: any chip stamped with
 * `data-tk-ui-route-dynamic` (by `renderUiRouteChipsInHtml` +
 * `dynamicMarkerFor`) gets its label resolved via the shared
 * `resolveDynamicChipLabel` and its `.tk-ui-route-chip-label` span
 * rewritten in place. Adding a new dynamic chip needs no change here.
 */
export function hydrateDynamicUiRouteChips(container: HTMLElement): () => void {
  let cancelled = false;
  // querySelectorAll returns a snapshot, safe to iterate without
  // worrying about mid-iteration DOM mutations from the hydrator's
  // own writes.
  const chips = container.querySelectorAll<HTMLElement>("[data-tk-ui-route-dynamic]");
  for (const chip of Array.from(chips)) {
    const token = chip.getAttribute("data-tk-ui-route");
    const entry = token ? resolveUiRoute(token) : null;
    if (!entry) continue;
    void resolveDynamicChipLabel(entry).then((label) => {
      if (cancelled || !label) return;
      // Rewrite the dedicated label span only, leaving the leading icon
      // span intact. The plain textContent setter would erase the glyph.
      const labelSpan = chip.querySelector<HTMLElement>(".tk-ui-route-chip-label");
      if (labelSpan) labelSpan.textContent = label;
    });
  }
  return () => {
    cancelled = true;
  };
}
