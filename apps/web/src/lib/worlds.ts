import type { WorldCollaborator, WorldPage } from "@thekeep/shared";
import { readError } from "./http.js";
export { deriveSlug } from "@thekeep/shared";

/**
 * Owner-only: add a user as an editing collaborator on this world.
 * Server validates that the caller owns the world AND that the named
 * user exists. Returns the updated collaborator list.
 */
export async function addWorldCollaborator(
  idOrSlug: string,
  username: string,
): Promise<{ collaborators: WorldCollaborator[] }> {
  const r = await fetch(`/worlds/${encodeURIComponent(idOrSlug)}/collaborators`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username }),
  });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as { collaborators: WorldCollaborator[] };
}

/**
 * Owner-only (or self-leave): drop a collaborator. Returns the updated
 * collaborator list. The server lets a collaborator remove themselves
 * even if they're not the owner — same UX as "leave" elsewhere.
 */
export async function removeWorldCollaborator(
  idOrSlug: string,
  userId: string,
): Promise<{ collaborators: WorldCollaborator[] }> {
  const r = await fetch(
    `/worlds/${encodeURIComponent(idOrSlug)}/collaborators/${encodeURIComponent(userId)}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as { collaborators: WorldCollaborator[] };
}

export interface WorldTreeNode {
  page: WorldPage;
  depth: number;
  children: WorldTreeNode[];
}

/**
 * Build a tree from the flat page list returned by /worlds/:idOrSlug.
 * Sorted by (sortOrder asc, createdAt asc) at each level. Depth is
 * pre-computed so callers don't have to re-walk the tree to indent.
 */
export function buildWorldTree(pages: WorldPage[]): WorldTreeNode[] {
  const byParent = new Map<string | null, WorldPage[]>();
  for (const p of pages) {
    const key = p.parentPageId;
    const arr = byParent.get(key) ?? [];
    arr.push(p);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
  }
  function build(parentId: string | null, depth: number): WorldTreeNode[] {
    return (byParent.get(parentId) ?? []).map((p) => ({
      page: p,
      depth,
      children: build(p.id, depth + 1),
    }));
  }
  return build(null, 0);
}

/** URL pattern used for shareable world links: /w/<slug>. */
const WORLD_URL_RX = /^\/w\/([a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?)\/?$/i;

/**
 * Parse the current location for a world deep-link. Returns the slug-or-id
 * captured from the path, or null if the URL isn't a world link. Consumed
 * on first paint and on popstate so back/forward navigation works.
 */
export function parseWorldFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(WORLD_URL_RX);
  return m?.[1] ?? null;
}

/**
 * Sync the browser URL to reflect whether a world viewer is open.
 *   - Opening a world  -> push /w/<slug>
 *   - Closing a world  -> push /
 *   - Already in sync  -> no-op (avoids double history entries)
 *
 * Uses pushState so the back button takes the user to the previous state
 * (typically: chat). Callers that want to *replace* the current URL
 * without adding history (e.g. normalizing /w/<id> -> /w/<slug>) should
 * use the replace flag.
 */
export function syncWorldUrl(slug: string | null, opts: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const current = parseWorldFromUrl();
  const target = slug ? `/w/${slug}` : "/";
  // Avoid pushing identical state (would clutter history with duplicates).
  if (slug && current === slug) return;
  if (!slug && !current) return;
  if (opts.replace) {
    window.history.replaceState({}, "", target);
  } else {
    window.history.pushState({}, "", target);
  }
}

/** Build the absolute URL for a world (used by Copy Link). */
export function worldShareUrl(slug: string): string {
  if (typeof window === "undefined") return `/w/${slug}`;
  return `${window.location.origin}/w/${slug}`;
}
