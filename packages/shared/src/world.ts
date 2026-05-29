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

/**
 * Catalog metadata enums. Closed sets (enums-by-convention, validated at
 * the Zod layer not the DB) so the catalog filter UI can render them as
 * a known checklist / dropdown without an extra round-trip.
 *
 * Genre defaults to `"other"` for legacy rows that haven't been updated
 * yet. The seed worlds get specific genres in
 * `apps/server/src/seed_worlds.ts`.
 */
export type WorldGenre =
  | "fantasy"
  | "modern"
  | "scifi"
  | "horror"
  | "western"
  | "steampunk"
  | "mythological"
  | "other";

/**
 * `featured` is admin-curated only — owners can't self-promote. The
 * splash carousel + catalog "Featured" filter both read this slot.
 * `archived` hides a world from default catalog views while keeping
 * member links + chat-history references valid.
 */
export type WorldStatus = "active" | "featured" | "archived";

/**
 * `pacing` is a soft signal to potential members about the cadence the
 * world's owner expects. Null = unspecified.
 *
 * Ordered roughly from least to most committed:
 *   - "freeform"     : Anyone, any character, drop in anytime. The most
 *                      permissive option. Good for community sandboxes
 *                      and casual hangouts where anything goes.
 *   - "drop-in"      : Pick-up scenes, no plot continuity expected.
 *                      Slightly more focused than freeform.
 *   - "casual"       : Pick-up scenes with some recurring threads;
 *                      low commitment but not totally ad-hoc.
 *   - "slice-of-life": Ambient, low-stakes scenes. Daily-life RP,
 *                      tavern hangs, quiet character moments.
 *   - "structured"   : Planned scenes / arcs the owner curates.
 *   - "long-form"    : Extended arcs with deep character commitment.
 */
export type WorldPacing =
  | "freeform"
  | "drop-in"
  | "casual"
  | "slice-of-life"
  | "structured"
  | "long-form";

/**
 * Curated descriptive tags. Each is normalized to lowercase + kebab on
 * the way in. Admins can extend by adding entries here and shipping —
 * no migration needed since tags live as comma-separated strings on
 * `worlds.tags`. Owners can also save free-form custom tags via the
 * editor; the canonical list just powers the filter chips + the
 * editor's "common tags" picker.
 */
export const CANONICAL_TAGS = [
  "combat-heavy",
  "low-magic",
  "high-magic",
  "intrigue",
  "romance-friendly",
  "exploration",
  "mystery",
  "slice-of-life",
  "war",
  "political",
  "courtly",
  "frontier",
  "urban",
  "wilderness",
  "investigation",
] as const;
export type CanonicalTag = (typeof CANONICAL_TAGS)[number];

/**
 * Closed safety-signal set. Distinct from descriptive tags so the
 * catalog can offer an "exclude these warnings" filter without
 * conflating it with positive interest signals. New warnings require a
 * code change (and a UI label update in the catalog component), which
 * is the right friction for a safety-relevant taxonomy.
 */
export const CONTENT_WARNINGS = [
  "violence",
  "nsfw",
  "body-horror",
  "dark-themes",
  "substance",
  "self-harm",
  "death",
  "discrimination",
] as const;
export type ContentWarning = (typeof CONTENT_WARNINGS)[number];

/**
 * Wire-side normalization for tag/CW lists. The DB stores
 * comma-separated strings; the network shape is `string[]` to keep
 * client logic simple. Both directions go through these helpers so
 * empty strings, stray whitespace, and case differences never leak
 * out as duplicate entries.
 */
export function parseTagList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const t = part.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function serializeTagList(tags: ReadonlyArray<string>): string {
  return parseTagList(tags.join(",")).join(",");
}

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
  /** Number of rooms linked to this world (one-to-one via roomWorldLinks). */
  linkedRoomCount: number;
  /**
   * Per-world theme JSON, applied only inside the world's editor / viewer
   * modals so authors can give their wiki a custom look without imposing it
   * on chat. Null = inherit the viewer's chat theme.
   */
  theme: Theme | null;
  /** Catalog metadata. See enums + helpers above. */
  genre: WorldGenre;
  tags: string[];
  contentWarnings: string[];
  status: WorldStatus;
  coverImageUrl: string | null;
  pacing: WorldPacing | null;
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
  /** True iff the viewer owns this world (master account match). Used by
   *  the client to show the owner-only Collaborators panel + Delete button. */
  viewerIsOwner: boolean;
  /** True iff the viewer can edit this world's metadata + pages. Owner,
   *  admin, OR anyone in `collaborators`. The client gates the Edit
   *  affordance on this so non-editors don't see a UI that 403s on save. */
  viewerCanEdit: boolean;
  /** Editing collaborators the owner has invited. Always populated;
   *  the wiki shows the list to everyone for transparency, but the
   *  add/remove controls are gated on `viewerIsOwner`. */
  collaborators: WorldCollaborator[];
}

/**
 * One non-owner user who has been granted edit rights on this world.
 * Returned by GET /worlds/:idOrSlug and by the POST/DELETE collaborator
 * endpoints (which return the refreshed list).
 */
export interface WorldCollaborator {
  userId: string;
  username: string;
  /** Epoch ms when the collaborator was added. Null on a row that
   *  predates the `added_at` column (none today, future-proof). */
  addedAt: number | null;
}

/**
 * Returned by GET /worlds/:idOrSlug when an anonymous viewer asks for a
 * private world that exists. Mirrors the profile-private-stub pattern so
 * the client can prompt sign-in instead of treating it as a 404. HTTP 200,
 * discriminated by the `private: true` flag.
 */
export interface PrivateWorldStub {
  private: true;
  name: string;
  slug: string;
  /** True iff the viewer is anonymous and signing in might unlock access. */
  requiresAuth: boolean;
}

/**
 * A row in the public world catalog (visibility="open"). Now carries
 * the filterable metadata so the catalog modal can render filter
 * chips, cover thumbnails, and warning glyphs without a second fetch
 * per card.
 */
export interface WorldCatalogEntry {
  id: string;
  slug: string;
  ownerUsername: string;
  name: string;
  description: string | null;
  pageCount: number;
  memberCount: number;
  linkedRoomCount: number;
  genre: WorldGenre;
  tags: string[];
  contentWarnings: string[];
  status: WorldStatus;
  coverImageUrl: string | null;
  pacing: WorldPacing | null;
  updatedAt: number;
}

/** Paged catalog response. `total` is the unfiltered count for the bucket. */
export interface WorldCatalogPage {
  entries: WorldCatalogEntry[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
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

/**
 * Slug derivation for worlds and pages: lowercase, non-alphanumerics → `-`,
 * trim leading/trailing dashes, cap at 60 chars. The server uses this as a
 * fallback when the user doesn't supply an explicit slug; the editor uses
 * it for the live preview the user sees while typing a name. Both sides
 * import from here so the preview never lies about what the server will
 * accept.
 */
export function deriveSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
