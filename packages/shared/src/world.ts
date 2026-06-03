import type { Theme } from "./theme.js";
import type { AvatarCrop } from "./profile.js";

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
  /** Vibe stats — 0..100 per axis, or null when the author hasn't tuned it. */
  vibeStats: WorldVibeStats;
  /** How members join. See `WorldJoinMode`. */
  joinMode: WorldJoinMode;
  /**
   * Author's application-question prompts (max 5). Empty array =
   * application form has no Q&A and just captures the applicant's
   * intent to join. Only meaningful when `joinMode === "application"`.
   */
  applicationQuestions: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Single membership row, used in profile + "My Worlds" lists.
 *
 * v3 (migration 0187): memberships are per-identity, not per-master.
 * `characterId` is null for the master's OOC face, non-null for a
 * specific character. The same user can appear here multiple times
 * for the same world if their OOC and a character both joined.
 *
 * `isPrimary` was retired in 0187 — there's no per-master "primary
 * world" anymore (the userlist grouping it drove was the leak that
 * outed character→master linkage in the rail).
 */
export interface WorldMembership {
  worldId: string;
  worldSlug: string;
  worldName: string;
  ownerUsername: string;
  /** Identity the membership belongs to. Null = OOC. */
  characterId: string | null;
  /**
   * Display name of the joining identity. For OOC, this is the
   * master's username (matches every other surface that labels OOC
   * as the username). For a character, it's the character's name.
   */
  identityDisplayName: string;
  joinedAt: number;
}

/** Brief member entry rendered in a world's "Members" section.
 *
 *  Privacy: this list omits users whose master profile is private or
 *  NSFW-flagged — they explicitly opted out of public affiliation, so
 *  they shouldn't appear in any world's member gallery either. The
 *  server applies the filter in `memberListFor`; the client can take
 *  the wire list at face value.
 */
/**
 * One occupant in a world's member gallery. Per migration 0187 this
 * is keyed by IDENTITY (not master), so the same userId can appear
 * twice — once for the OOC face, once for each character that
 * joined separately.
 *
 * Display rules:
 *   - characterId === null → OOC face. `displayName` is the
 *     master's username, `avatarUrl` is the master avatar.
 *   - characterId !== null → a specific character. `displayName`
 *     is the character's display name, `avatarUrl` is the
 *     character's avatar (falling back to the master's avatar if
 *     the character has none — handled server-side).
 */
export interface WorldMemberRef {
  userId: string;
  /** Master username — surfaced for the "by" attribution on hover. */
  username: string;
  /** Identity slot: null for OOC, the character id otherwise. */
  characterId: string | null;
  /** The identity's display name (master username for OOC, character name otherwise). */
  displayName: string;
  /** Avatar URL appropriate to the identity, null = initials fallback. */
  avatarUrl: string | null;
  /** Owner-picked zoom + focal point applied when rendering this
   *  member's avatar. The gallery thumbnail respects this so the
   *  same crop the owner chose for their profile carries over. */
  avatarCrop: AvatarCrop;
  joinedAt: number;
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
  /**
   * True iff the viewer's CURRENT identity (the character they're
   * voicing, or OOC) is a member of this world. Other identities of
   * the same master may also be members — this flag only reflects
   * the current face. The catalog uses this to switch the action
   * button between Join / Apply / Joined.
   */
  viewerIsMember: boolean;
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
  /**
   * The viewer's most recent application against this world, if any.
   * Drives the "Apply" / "Pending" / "Rejected — Re-apply" button
   * state in the catalog and on the world page. Null when the viewer
   * has never applied OR when joinMode isn't "application".
   *
   * Owner viewers don't get their own row populated here — they see
   * the full list via the editor's Applications pane instead.
   */
  viewerApplication: WorldApplicationEntry | null;
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
  /** Vibe stats — 0..100 per axis, null = unset (renders as muted "—"). */
  vibeStats: WorldVibeStats;
  /** Drives the catalog button label ("Join" / "Apply" / hidden for invite-only). */
  joinMode: WorldJoinMode;
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

/* ============================================================
 *  Vibe stats — fixed axis catalog
 * ============================================================ */

/**
 * Eight axes the world author tunes on 0..100 sliders to describe
 * the feel of their setting. The catalog renders them as horizontal
 * bars on each world card and offers min/max range filters per axis.
 *
 * The list is INTENTIONALLY FIXED so cross-world comparison stays
 * meaningful — a "high combat" world means the same thing in every
 * card. Adding or removing an axis is a schema migration.
 *
 * Each axis carries:
 *   - `key`     : the wire-format key + DB-column suffix
 *   - `label`   : capitalized display name on the bar
 *   - `desc`    : short hover/tooltip explanation for authors picking
 *                 a value (helps disambiguate Mystery vs Horror, etc.)
 */
export const WORLD_VIBE_AXES = [
  { key: "combat", label: "Combat", desc: "How central physical conflict and action scenes are to play." },
  { key: "magic", label: "Magic", desc: "How present supernatural / magical elements are in the setting." },
  { key: "technology", label: "Technology", desc: "Tech baseline from primitive (low) to far-future (high)." },
  { key: "romance", label: "Romance", desc: "Expected weight of romantic plotlines between characters." },
  { key: "politics", label: "Politics", desc: "Court intrigue, factions, governance, scheming." },
  { key: "mystery", label: "Mystery", desc: "Investigation, puzzles, hidden truths, slow reveals." },
  { key: "horror", label: "Horror", desc: "Dread, body horror, psychological terror, dark themes." },
  { key: "exploration", label: "Exploration", desc: "Discovery, travel, wilderness, mapping the unknown." },
] as const;

export type WorldVibeAxisKey = (typeof WORLD_VIBE_AXES)[number]["key"];

/**
 * Plain key→value bag for the eight axes. Server fills nulls for
 * axes the author hasn't tuned; the renderer treats null as a muted
 * "—" instead of a 0% bar so "deliberately none" and "not set" stay
 * visually distinct.
 *
 * The accepted value range is 0..100 inclusive; the route layer
 * clamps and rejects out-of-range submissions.
 */
export type WorldVibeStats = {
  [K in WorldVibeAxisKey]: number | null;
};

/* ============================================================
 *  joinMode + applications
 * ============================================================ */

/**
 * How prospective members join a world:
 *   - "open"        : one-click Join (default, matches pre-v3 behavior).
 *   - "application" : Apply button → form with `applicationQuestions`
 *                     → owner reviews in the editor's Applications
 *                     tab → approve auto-adds to world_members.
 *   - "invite-only" : no public Join / Apply button surfaces; only
 *                     the owner can add members (admin tooling or a
 *                     direct DB insert today).
 *
 * Orthogonal to `visibility` — a `private` world can still ask for
 * applications from people who got the link, and a `public` world
 * can stay open-join.
 */
export type WorldJoinMode = "open" | "application" | "invite-only";

/**
 * Hard caps on the application form. Five questions is enough to
 * capture a useful screen ("character concept", "experience level",
 * "schedule", etc.) without turning the apply step into a chore.
 */
export const WORLD_APP_MAX_QUESTIONS = 5;
export const WORLD_APP_QUESTION_MAX_LEN = 280;
export const WORLD_APP_ANSWER_MAX_LEN = 2000;
export const WORLD_APP_REVIEW_NOTE_MAX_LEN = 1000;

/**
 * Status lifecycle for a `world_applications` row:
 *   pending → approved | rejected | withdrawn (terminal)
 * Terminal rows stay as an audit trail; a partial unique index keeps
 * "at most one pending per (world, applicant)" without blocking a
 * fresh re-apply after a terminal outcome.
 */
export type WorldApplicationStatus = "pending" | "approved" | "rejected" | "withdrawn";

/**
 * Wire shape returned by the application list endpoints. Owners see
 * the full Q&A; applicants see their own submission (so they can
 * verify what they sent + see the reject reason).
 */
export interface WorldApplicationEntry {
  id: string;
  worldId: string;
  applicantUserId: string;
  /** Master username — surfaced for transparency under the identity. */
  applicantUsername: string;
  /**
   * Identity the application was filed under: null = OOC, non-null
   * = a specific character of the applicant. Owner reviewing the
   * pending list sees the character's name (or OOC label) — the
   * master is shown in muted text underneath for accountability.
   */
  applicantCharacterId: string | null;
  /** Display name to render in the review pane: character's display
   *  name when applicantCharacterId is non-null, master's username
   *  for OOC applications. */
  applicantDisplayName: string;
  /** Avatar URL appropriate to the applying identity. Null = use initials fallback. */
  applicantAvatarUrl: string | null;
  /**
   * Snapshot of the world's question list at the time of submission.
   * Length matches `answers`. Snapshotted so later edits to the
   * world's questions don't garble historical applications.
   */
  questions: string[];
  /** Applicant's free-text answer per question (same length as `questions`). */
  answers: string[];
  status: WorldApplicationStatus;
  submittedAt: number;
  reviewedAt: number | null;
  reviewedByUserId: string | null;
  reviewedByUsername: string | null;
  /** Optional author feedback shown to the applicant on the rejection / approval. */
  reviewNote: string | null;
}

/** Returned from POST .../applications when the applicant submits. */
export interface WorldApplicationSubmitResult {
  ok: true;
  application: WorldApplicationEntry;
}

/**
 * Returned from GET .../applications for the world owner. Pending
 * first, then a small tail of recently-terminal rows so the author
 * can spot-check their own past decisions. The catalog viewer-side
 * fetch returns at most ONE row (the viewer's own current/last app
 * against this world) via `viewerApplication` on WorldDetail.
 */
export interface WorldApplicationList {
  pending: WorldApplicationEntry[];
  recent: WorldApplicationEntry[];
}

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
