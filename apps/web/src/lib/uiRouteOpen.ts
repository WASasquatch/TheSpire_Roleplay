/**
 * UI-route dispatch, the in-process event bus that connects a
 * `{token}` chip click (in chat, in the banner marquee, or in a
 * scheduled-announcement body) to the matching modal setter on the
 * Chat shell.
 *
 * The Chat component subscribes to `tk:open-ui-route` once at mount;
 * every consumer (markdown chip, HTML chip delegate listener) calls
 * `openUiRoute(token)` and the resolution + dispatch happens in one
 * place. Adding a new modal target = adding one branch to the Chat
 * listener AND one row to the shared catalog, no per-call wiring.
 *
 * Custom-event indirection (instead of, say, threading a setter prop
 * down through the markdown renderer) means every render surface
 * stays decoupled from the Chat shell's internals. The same chip
 * markup works inside `<MessageList>`, the marquee, an announcement
 * line in chat, or a future surface that hasn't been imagined yet.
 */

import type React from "react";
import { resolveUiRoute, type UiRoute, type UiRouteTarget } from "@thekeep/shared";
import { recordNav } from "./nav-metrics.js";

/** Event name fired on the window when a chip is clicked. */
export const UI_ROUTE_EVENT = "tk:open-ui-route";

export interface UiRouteOpenDetail {
  /** The raw token the chip carried (already lowercase). */
  token: string;
  /** Resolved catalog entry, handlers narrow on `entry.target.kind`. */
  entry: UiRoute;
}

/**
 * Dispatch a UI route open event. Returns true when a known token was
 * dispatched, false when the token was unknown (no event fired). The
 * caller decides what to do with `false`; in practice the markdown
 * chip never renders for unknown tokens so callers can ignore it.
 */
export function openUiRoute(token: string): boolean {
  const entry = resolveUiRoute(token);
  if (!entry) return false;
  if (typeof window === "undefined") return false;
  // Analytics choke point 2 (plan_ext.md §3): the single dispatch point for
  // nearly every modal opened via a chip, marquee, or /command ui:hint.
  // Record the target kind as the key + the raw token (a stable catalog
  // token, not free text) as meta.
  recordNav("modal", entry.target.kind, { token: token.toLowerCase() });
  const detail: UiRouteOpenDetail = { token: token.toLowerCase(), entry };
  window.dispatchEvent(new CustomEvent<UiRouteOpenDetail>(UI_ROUTE_EVENT, { detail }));
  return true;
}

/**
 * Convenience for the Chat shell's `useEffect` listener, typed
 * helper around `addEventListener` so the consumer doesn't have to
 * widen-then-narrow the event detail every time.
 */
export function onUiRouteOpen(handler: (detail: UiRouteOpenDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  function listener(ev: Event) {
    const ce = ev as CustomEvent<UiRouteOpenDetail>;
    if (!ce.detail) return;
    handler(ce.detail);
  }
  window.addEventListener(UI_ROUTE_EVENT, listener);
  return () => window.removeEventListener(UI_ROUTE_EVENT, listener);
}

/** Re-export so the Chat listener can narrow on the target kind
 *  without pulling shared directly. */
export type { UiRouteTarget };

/**
 * Attribute the HTML-chip generator stamps on every rendered
 * `<button>`, used by the delegated click handler to recognize the
 * chip when its surrounding markup was rendered through
 * `dangerouslySetInnerHTML` (banner marquee, scheduled-announce
 * bodyHtml branch). React's synthetic event system can't bind
 * onClick to elements it didn't render, so we listen at the host
 * container and check the event target.
 */
export const UI_ROUTE_DATA_ATTR = "data-tk-ui-route";

/**
 * Delegated click handler factory, pass the result to a wrapping
 * element's `onClick` prop. Inspects the click target chain for a
 * `[data-tk-ui-route]` ancestor and, if found, dispatches the open
 * event and prevents the default chain from continuing (so a banner
 * click that opens a modal doesn't also trigger banner-collapse or
 * its parent's tap-to-toggle).
 */
export function handleUiRouteClickInHtml(
  e: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
): boolean {
  let node = e.target as HTMLElement | null;
  while (node && node !== e.currentTarget) {
    if (node.dataset && node.dataset.tkUiRoute) {
      e.stopPropagation();
      e.preventDefault();
      openUiRoute(node.dataset.tkUiRoute);
      return true;
    }
    node = node.parentElement;
  }
  return false;
}
