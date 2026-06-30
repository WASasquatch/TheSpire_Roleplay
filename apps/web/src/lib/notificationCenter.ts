/**
 * Notification Center client helpers — thin fetch wrappers over the
 * /me/notifications routes. The live badge + new rows arrive over the socket
 * (notifications:badge / notifications:new, wired in App); these cover the boot
 * seed, the slide-over's paged list, and the read/seen acknowledgements.
 *
 * Distinct from lib/notifications.ts, which is the BROWSER-toast helper for
 * live chat messages — this module is the unified inbox API.
 */
import type { NotificationBadge, NotificationPage } from "@thekeep/shared";

/** Cheap boot/poll fetch: unread totals (+ per-server for the rail dots). */
export async function fetchNotifBadge(): Promise<NotificationBadge> {
  const r = await fetch("/me/notifications/unread", { credentials: "include" });
  if (!r.ok) throw new Error("unread fetch failed");
  return (await r.json()) as NotificationBadge;
}

/** A newest-first inbox page (optionally filtered by category). */
export async function fetchNotifications(opts?: {
  cursor?: number | null;
  category?: string | null;
  limit?: number;
}): Promise<NotificationPage> {
  const p = new URLSearchParams();
  if (opts?.cursor) p.set("cursor", String(opts.cursor));
  if (opts?.category) p.set("category", opts.category);
  if (opts?.limit) p.set("limit", String(opts.limit));
  const qs = p.toString();
  const r = await fetch(`/me/notifications${qs ? `?${qs}` : ""}`, { credentials: "include" });
  if (!r.ok) throw new Error("notifications fetch failed");
  return (await r.json()) as NotificationPage;
}

/** Mark rows (or everything) read; returns the fresh badge. */
export async function markNotificationsRead(ids: string[] | "all"): Promise<NotificationBadge> {
  const r = await fetch("/me/notifications/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ ids }),
  });
  if (!r.ok) throw new Error("mark read failed");
  return (await r.json()) as NotificationBadge;
}

/** Acknowledge the badge (mark all seen) without consuming the rows. */
export async function markNotificationsSeen(): Promise<void> {
  await fetch("/me/notifications/seen", { method: "POST", credentials: "include" }).catch(() => {});
}

/** Read the viewer's muted-category preferences. */
export async function fetchNotifPrefs(): Promise<{ mutedCategories: string[] }> {
  const r = await fetch("/me/notification-prefs", { credentials: "include" });
  if (!r.ok) throw new Error("prefs fetch failed");
  return (await r.json()) as { mutedCategories: string[] };
}

/** Replace the viewer's muted-category list. */
export async function saveNotifPrefs(mutedCategories: string[]): Promise<void> {
  await fetch("/me/notification-prefs", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ mutedCategories }),
  });
}
