/**
 * Tiny cross-component signal bridging the BannerMarquee (top of chat)
 * and the Room Info bar's "bring back announcements" button. They don't
 * share a parent, so instead of prop-drilling:
 *
 *   - BannerMarquee publishes whether it's currently HIDDEN (there are
 *     enabled banners but the viewer dismissed them) plus a `resurrect`
 *     callback bound to its content-aware dismiss key.
 *   - RoomInfoBar subscribes via `useMarqueeHidden()` to show the button
 *     only when there's something to bring back, and calls
 *     `resurrectMarquee()` on click.
 *
 * A `useSyncExternalStore` shape mirrors `dismissedBanners.ts`, so the
 * button appears/disappears on the same tick the marquee is dismissed or
 * restored.
 */

import { useSyncExternalStore } from "react";

let hidden = false;
let resurrectFn: (() => void) | null = null;
const listeners = new Set<() => void>();

/** Called by BannerMarquee whenever its hidden-state changes. */
export function setMarqueeHidden(next: boolean, resurrect: () => void): void {
  resurrectFn = resurrect;
  if (next === hidden) return;
  hidden = next;
  for (const l of listeners) l();
}

/** Bring the dismissed marquee back (clears its dismissal). No-op when
 *  the marquee isn't mounted / nothing is registered. */
export function resurrectMarquee(): void {
  resurrectFn?.();
}

function isHidden(): boolean {
  return hidden;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True when there ARE announcements but the viewer has dismissed them. */
export function useMarqueeHidden(): boolean {
  return useSyncExternalStore(subscribe, isHidden, () => false);
}
