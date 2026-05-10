import type { WorldPage } from "@thekeep/shared";

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

/**
 * Slug derivation matching the server: lowercase, non-alphanumerics → `-`,
 * trim leading/trailing dashes, cap 60 chars. Used by the editor to
 * preview the slug before sending the create request.
 */
export function deriveSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
