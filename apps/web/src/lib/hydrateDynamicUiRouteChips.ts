/**
 * Post-mount hydration for UI-route chips embedded in server-sanitized
 * HTML surfaces (the BannerMarquee body + the scheduled-announce
 * `bodyHtml` render path in MessageList). Two passes:
 *
 *   1. ICONS — `renderUiRouteChipsInHtml` emits an EMPTY placeholder span
 *      (`[data-tk-ui-route-icon="<LucideName>"]`) for every chip's glyph,
 *      because the shared HTML generator has no React/lucide. This pass
 *      mounts the matching `<UiRouteIcon>` into each placeholder so the
 *      HTML chips show the same lucide icon as the React chat chips.
 *
 *   2. DYNAMIC LABELS — chips whose label resolves at render time
 *      ({scriptorium:latest:story}, {ranking:<board>}, {world:<slug>}, …)
 *      carry a `data-tk-ui-route-dynamic` marker; this pass fetches the
 *      resolved label and rewrites the `.tk-ui-route-chip-label` span.
 *
 * Idempotent: an icon placeholder we've already filled is flagged with
 * `data-tk-icon-hydrated` and skipped, and label fetches short-circuit on
 * the shared TTL cache. In practice this effect re-runs only when the body
 * HTML changes (new DOM, fresh unflagged placeholders), so there's no
 * same-node double-mount.
 *
 * Cleanup: cancels in-flight label fetches and unmounts the icon roots
 * (deferred a microtick so unmounting can't fire mid-commit).
 */

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resolveUiRoute } from "@thekeep/shared";
import { resolveDynamicChipLabel } from "./uiRouteDynamicLabel.js";
import { UiRouteIcon } from "./uiRouteIcons.js";

export function hydrateDynamicUiRouteChips(container: HTMLElement): () => void {
  let cancelled = false;
  const roots: Root[] = [];

  // 1. Icons — mount a lucide component into each unfilled placeholder.
  const iconSpans = container.querySelectorAll<HTMLElement>(
    "[data-tk-ui-route-icon]:not([data-tk-icon-hydrated])",
  );
  for (const span of Array.from(iconSpans)) {
    const name = span.getAttribute("data-tk-ui-route-icon");
    if (!name) continue;
    span.setAttribute("data-tk-icon-hydrated", "1");
    const root = createRoot(span);
    root.render(createElement(UiRouteIcon, { name }));
    roots.push(root);
  }

  // 2. Dynamic labels — resolve + rewrite the label span in place.
  const chips = container.querySelectorAll<HTMLElement>("[data-tk-ui-route-dynamic]");
  for (const chip of Array.from(chips)) {
    const token = chip.getAttribute("data-tk-ui-route");
    const entry = token ? resolveUiRoute(token) : null;
    if (!entry) continue;
    void resolveDynamicChipLabel(entry).then((label) => {
      if (cancelled || !label) return;
      // Rewrite the dedicated label span only, leaving the icon span intact.
      const labelSpan = chip.querySelector<HTMLElement>(".tk-ui-route-chip-label");
      if (labelSpan) labelSpan.textContent = label;
    });
  }

  return () => {
    cancelled = true;
    for (const root of roots) {
      // Defer: React warns if a root is unmounted synchronously while
      // another render/commit is in flight, which effect cleanup can be.
      queueMicrotask(() => root.unmount());
    }
  };
}
