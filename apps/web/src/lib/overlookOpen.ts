/**
 * Open-the-Overlook dispatch, a one-event bus in the same spirit as
 * `uiRouteOpen`.
 *
 * The canvas can be requested from surfaces that sit several components deep
 * inside other windows (the world editor's nav, the world viewer's tab
 * strip), and every one of them would otherwise need a setter threaded down
 * from the Chat shell. The shell subscribes once; callers just fire.
 *
 * Not folded into the `{token}` UI-route catalog on purpose: those tokens are
 * a public, user-typeable surface, and a canvas is addressed by the room or
 * world you are already looking at rather than by a name someone types into
 * chat. (`/overlook` reaches the room canvas through the `ui:hint` socket
 * event, which is the server-side equivalent.)
 */
import type { OverlookScope, WorldEntityLight } from "@thekeep/shared";

export const OVERLOOK_OPEN_EVENT = "tk:open-overlook";

export interface OverlookOpenDetail {
  scope: OverlookScope;
  /** Room id, or world id-or-slug. */
  scopeId: string;
  /** Titlebar text until the payload lands with the canonical name. */
  name: string;
  /**
   * World entries to offer the "pull in entries" seeding tool. Only sent by
   * world surfaces, which already have them loaded.
   */
  worldEntities?: WorldEntityLight[];
}

export function openOverlook(detail: OverlookOpenDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OverlookOpenDetail>(OVERLOOK_OPEN_EVENT, { detail }));
}

export function onOverlookOpen(handler: (detail: OverlookOpenDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => handler((e as CustomEvent<OverlookOpenDetail>).detail);
  window.addEventListener(OVERLOOK_OPEN_EVENT, listener);
  return () => window.removeEventListener(OVERLOOK_OPEN_EVENT, listener);
}
