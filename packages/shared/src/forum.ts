/**
 * Forums — user-owned message boards (see plan.md, "Forums Revamp").
 *
 * Vocabulary (one term per concept, used in code, routes, and UI):
 *   - Forum:    the container (name, slug, theme, banner, settings). New
 *               top-level entity, `forums` table.
 *   - Board:    a room INSIDE a forum (`rooms.forumId` set, replyMode
 *               "nested"). Boards reuse all existing room/topic machinery.
 *   - Category: existing `room_thread_categories` bucket inside a board.
 *   - Topic/Reply: existing nested-room messages.
 *
 * Wire types here are shared by the server routes, the Forums Catalog
 * modal, the admin Forums tab, and the public `/f/<slug>` page.
 */

/** Forum-level role held in `forum_members`. Owner is the approved
 *  applicant; mods are owner-assigned helpers with topic-level powers
 *  only (no category management, no touching owner-authored content). */
export type ForumRole = "owner" | "mod" | "member";

/** Who may post: `open` = any signed-in non-banned user; `application` =
 *  membership application reviewed by the owner/mods. Visibility is NOT
 *  gated in v1 — every forum is listed and has a public landing. */
export type ForumPostingMode = "open" | "application";

/** `featured` pins to the top of the catalog rail (admin-curated, like
 *  worlds); owners flip between active and archived. */
export type ForumStatus = "active" | "featured" | "archived";

/** Membership / creation application lifecycle (mirrors world_applications). */
export type ForumApplicationStatus = "pending" | "approved" | "rejected" | "withdrawn";

/* ============================================================
 * Validation constants (shared by client forms + server Zod)
 * ============================================================ */

/** Slug shape: lowercase letters, digits, underscore. Short enough for a
 *  share URL, long enough for a real name: `/f/shadows_of_darkness`. */
export const FORUM_SLUG_RE = /^[a-z0-9_]{3,40}$/;

/** Slugs that must never become forums — they collide with real routes,
 *  upload paths, or future reserved surfaces. Checked case-insensitively. */
export const RESERVED_FORUM_SLUGS: ReadonlySet<string> = new Set([
  "admin", "api", "auth", "assets", "uploads", "static",
  "f", "p", "w", "u", "profiles", "rooms", "worlds", "forums", "forum",
  "spire_system", "login", "logout", "register", "settings", "help",
  "terms", "privacy", "rules", "about", "new", "create", "edit",
  // Static segments under /forums/* — a forum with one of these slugs
  // would be unreachable behind the same-named API route.
  "applications", "slug_availability", "slug-availability", "mine", "by_slug",
]);

export const FORUM_NAME_MIN = 3;
export const FORUM_NAME_MAX = 60;
export const FORUM_TAGLINE_MAX = 200;
/** The creation application's "what is your forum for" prose. */
export const FORUM_PURPOSE_MIN = 30;
export const FORUM_PURPOSE_MAX = 500;
/** Membership-application answer (free text shown to the owner). */
export const FORUM_MEMBER_ANSWER_MAX = 500;
/** Boards per forum (admin-tunable later; the route enforces this default). */
export const FORUM_MAX_BOARDS_DEFAULT = 10;
/** Owned forums per user (admin-tunable later). */
export const FORUM_MAX_OWNED_DEFAULT = 2;
/** Days an applicant must wait after a rejection before re-applying. */
export const FORUM_REAPPLY_COOLDOWN_DAYS = 7;

/* ============================================================
 * Wire shapes
 * ============================================================ */

/** Catalog-rail / list entry. Cheap to assemble for many forums. */
export interface ForumSummary {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  logoUrl: string | null;
  status: ForumStatus;
  postingMode: ForumPostingMode;
  isSystem: boolean;
  ownerUserId: string;
  /** Master username of the owner (resolved at read time for display). */
  ownerUsername: string;
  boardCount: number;
  memberCount: number;
  /** Most recent topic/reply activity across the forum's boards (ms), null
   *  for a freshly-created forum with no posts yet. */
  lastActivityAt: number | null;
  createdAt: number;
  /** Signed-in viewers only: there's been topic/reply activity since this
   *  viewer last opened the forum in the catalog. Drives the rail dot. */
  unseen?: boolean;
  /** Signed-in viewers only: this viewer's role in the forum (owner / mod /
   *  member), or null when they hold none. Lets surfaces like the Tools menu
   *  list owned + joined forums as quick bookmarks without a detail fetch. */
  viewerRole?: ForumRole | null;
  /** Signed-in viewers only: this viewer has opened the forum before (a visit
   *  marker exists). For open forums — which carry no formal membership — this
   *  is the "interacted with" signal the bookmark list keys on. */
  visited?: boolean;
}

/** One board row inside ForumDetail. A board IS a room; this carries just
 *  what the forum content view needs to render the board list. */
export interface ForumBoardSummary {
  roomId: string;
  name: string;
  /** Room topic doubles as the board's short description line. */
  topic: string | null;
  topicCount: number;
  lastActivityAt: number | null;
  archived: boolean;
  /** Owner flag: this board is private (owner/mods/members only). Drives
   *  the owner-console toggle state; visible to everyone so the lock chip
   *  renders for all. */
  membersOnly: boolean;
  /** Resolved for THIS viewer: `membersOnly && !viewerIsMember`. When true
   *  the board lists but its contents are withheld behind a lock prompt.
   *  Owner/mod/member viewers always see `false`. */
  locked: boolean;
}

/** Full forum view (catalog content pane + /f/ page). */
export interface ForumDetail extends ForumSummary {
  descriptionHtml: string | null;
  bannerImageUrl: string | null;
  /** Vertical banner focus (0 top … 100 bottom, 50 center): which band
   *  of the banner image survives the header's cover-crop. */
  bannerFocusY: number;
  /** Normalized per-forum theme JSON string (client runs normalizeTheme). */
  themeJson: string | null;
  /** Per-forum DESIGN style (ornaments/chrome: medieval, glass, …) — the
   *  second theming axis, orthogonal to the palette. Null = the viewer's
   *  own design. Applied scoped to the forum's modal card only. */
  themeStyleKey: string | null;
  /** Owner-set prompt above the membership application's answer field
   *  (postingMode "application" only). Null = generic prompt. */
  applicationPrompt: string | null;
  /** Owner toggle: anonymous visitors on /f/<slug> may READ the boards
   *  (topics + replies) without an account. Posting always needs login. */
  publicBrowsing: boolean;
  linkedWorld: {
    id: string;
    name: string;
    ownerUsername: string;
    /** Truncated (~240 chars) world description for the header strip. */
    description: string | null;
  } | null;
  boards: ForumBoardSummary[];
  /** Viewer-specific gates, resolved server-side. Null when anonymous. */
  viewer: ForumViewerState | null;
  /** Landing-page statistics (traditional forum index numbers). Optional
   *  on the wire for forward/backward compat; the detail route always
   *  sends it. Online figures are SITE presence (boards carry none). */
  stats?: {
    /** Live topics across the forum's boards. */
    topics: number;
    /** Replies across the forum's boards. */
    replies: number;
    /** Distinct accounts that have posted on the boards. */
    writers: number;
    online: {
      /** Online users with PUBLIC profiles (capped server-side). */
      publicNames: string[];
      /** Online users keeping private/incognito — count only, never named. */
      hiddenCount: number;
      /** Accounts that opened THIS forum in the last 15 minutes. */
      browsingRecently: number;
    };
  };
}

/** The caller's relationship to a forum — drives every client-side gate
 *  (the server re-checks everything; this is advisory UI state). */
export interface ForumViewerState {
  role: ForumRole | null;
  /** Active ban, if any. `until` null = permanent. */
  ban: { until: number | null; reason: string | null } | null;
  /** Pending membership application exists. */
  membershipPending: boolean;
  /** Resolved "may open boards / post" verdict for this viewer. */
  canParticipate: boolean;
  /** Owner-tier control (forum owner OR site staff with manage_any_forum):
   *  shows the settings gear / owner console. */
  canManage: boolean;
}

/** Owner-console board cap + name rule (same charset as chat rooms — a
 *  board IS a room and room names are globally unique). */
export const FORUM_BOARD_NAME_RX = /^[\p{L}\p{N}_\-' ]{1,40}$/u;
export const FORUM_DESCRIPTION_MAX = 5000;

/** Forum-creation application (admin review queue + applicant status). */
export interface ForumCreationApplicationWire {
  id: string;
  applicantUserId: string;
  applicantUsername: string;
  requestedName: string;
  requestedSlug: string;
  purpose: string;
  status: ForumApplicationStatus;
  submittedAt: number;
  reviewedAt: number | null;
  reviewedByUsername: string | null;
  reviewNote: string | null;
}

/** Forum membership application (owner settings queue). */
export interface ForumMembershipApplicationWire {
  id: string;
  forumId: string;
  applicantUserId: string;
  applicantUsername: string;
  answer: string | null;
  status: ForumApplicationStatus;
  submittedAt: number;
  reviewedAt: number | null;
  reviewedByUsername: string | null;
  reviewNote: string | null;
}

/** Normalize + validate a requested slug; returns the canonical lowercase
 *  slug or null when unusable. Shared by the live availability check and
 *  the server's create path so they can never disagree. */
export function normalizeForumSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  if (!FORUM_SLUG_RE.test(slug)) return null;
  if (RESERVED_FORUM_SLUGS.has(slug)) return null;
  return slug;
}

/* ============================================================
 * In-modal board reading (Phase 1B)
 * ============================================================ */

/** One topic card in a board's topic list (the in-modal reader). */
export interface ForumTopicCard {
  id: string;
  title: string;
  /** Plain-text body snippet for the card (markdown stripped server-side
   *  isn't attempted — clients render the snippet as plain text). */
  snippet: string;
  authorUserId: string;
  authorDisplayName: string;
  /** Author avatar snapshot from the message row (null = glyph fallback). */
  authorAvatarUrl: string | null;
  /** Author chat-color snapshot (hex or theme token; resolve client-side). */
  authorColor: string | null;
  characterId: string | null;
  categoryId: string | null;
  isSticky: boolean;
  locked: boolean;
  /** Direct replies to the topic (deeper chains aren't counted). */
  replyCount: number;
  createdAt: number;
  lastActivityAt: number;
}

/** Category chip for the in-modal board reader. */
export interface ForumBoardCategory {
  id: string;
  name: string;
  iconUrl: string | null;
  sortOrder: number;
  /** Owner flag: category is private (owner/mods/members only). */
  membersOnly: boolean;
  /** Resolved for THIS viewer: `membersOnly && !viewerIsMember`. When true
   *  the chip renders locked and its topics are absent from the feed. */
  locked: boolean;
}

/** Page of topics for a board. `hasMore` drives "Load older topics";
 *  pagination cursors on the oldest lastActivityAt in the page. */
export interface ForumBoardTopicsPage {
  boardName: string;
  categories: ForumBoardCategory[];
  topics: ForumTopicCard[];
  hasMore: boolean;
}

/* ============================================================
 * Notification center (replies / quotes / watched topics)
 * ============================================================ */

/** Why the viewer was notified. reply = someone answered THEIR topic;
 *  quote = someone quoted one of their posts; watch = a topic they
 *  watch got a new reply. */
export type ForumNotificationKind = "reply" | "quote" | "watch";

/** One inbox row. Actor name / topic title / snippet are snapshots
 *  taken at post time, so the inbox reads correctly after renames. */
export interface ForumNotificationWire {
  id: string;
  kind: ForumNotificationKind;
  forumId: string;
  boardRoomId: string;
  topicId: string;
  messageId: string;
  actorName: string;
  topicTitle: string;
  snippet: string;
  createdAt: number;
  read: boolean;
}
