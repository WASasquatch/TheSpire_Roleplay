import type { Theme } from "./theme.js";

/**
 * Worldbuilding wire types. A world is a hierarchical wiki owned by a user
 * that can be linked to chat rooms (one world per room). Pages form a tree
 * via parent_page_id; the client renders a sidebar nav populated from the
 * tree and a content pane for the selected page.
 *
 * Visibility tiers:
 *   - private: owner only
 *   - public:  anyone with the URL or who sees it linked from a room
 *   - open:    public + listed in the world catalog + non-owners can link
 *              it to rooms they own/mod
 */
export type WorldVisibility = "private" | "public" | "open";

export interface WorldSummary {
  id: string;
  slug: string;
  ownerUserId: string;
  ownerUsername: string;
  name: string;
  description: string | null;
  visibility: WorldVisibility;
  pageCount: number;
  /** Number of users who've joined this world (excluding the owner unless they explicitly joined). */
  memberCount: number;
  /**
   * Per-world theme JSON, applied only inside the world's editor / viewer
   * modals so authors can give their wiki a custom look without imposing it
   * on chat. Null = inherit the viewer's chat theme.
   */
  theme: Theme | null;
  createdAt: number;
  updatedAt: number;
}

/** Single membership row, used in profile + world member lists. */
export interface WorldMembership {
  worldId: string;
  worldSlug: string;
  worldName: string;
  ownerUsername: string;
  isPrimary: boolean;
  joinedAt: number;
}

/** Brief member entry rendered in a world's "Members" section. */
export interface WorldMemberRef {
  userId: string;
  username: string;
  joinedAt: number;
  isPrimary: boolean;
}

/**
 * Single world page in the tree. `parentPageId` null = top-level.
 * `bodyHtml` is sanitized server-side via the same allow-list as bios.
 * Children are NOT inlined here; the client builds the tree from a flat
 * page list returned alongside the world.
 */
export interface WorldPage {
  id: string;
  worldId: string;
  parentPageId: string | null;
  slug: string;
  title: string;
  bodyHtml: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Full world payload: summary + flat page list + member list. The client
 * computes the tree and depth client-side so a single fetch loads the wiki.
 */
export interface WorldDetail {
  world: WorldSummary;
  pages: WorldPage[];
  members: WorldMemberRef[];
  /** True iff the requesting viewer is currently a member of this world. */
  viewerIsMember: boolean;
  /** True iff the requesting viewer's primary membership points at this world. */
  viewerPrimary: boolean;
}

/** A row in the public world catalog (visibility="open"). */
export interface WorldCatalogEntry {
  id: string;
  slug: string;
  ownerUsername: string;
  name: string;
  description: string | null;
  pageCount: number;
  memberCount: number;
  updatedAt: number;
}

/** Brief info about a world linked to a room. Surfaced via RoomSummary so the chat can render a banner. */
export interface LinkedWorldRef {
  id: string;
  slug: string;
  name: string;
  ownerUsername: string;
}

/** Hard upper bound on world page tree depth (root = depth 0). Enforced server-side. */
export const WORLD_PAGE_DEPTH_CAP = 10;
