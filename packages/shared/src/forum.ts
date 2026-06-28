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
 *  applicant; mods are owner-assigned helpers whose exact powers are the
 *  granular set in {@link ForumModPermission} (owner picks per mod). */
export type ForumRole = "owner" | "mod" | "member";

/* ============================================================
 * Granular moderator permissions
 *
 * A forum mod no longer has a fixed power set — the owner grants each mod
 * an explicit subset of these keys (stored as `forum_members.permissions_json`).
 * The forum OWNER (and site staff with `manage_any_forum`) implicitly hold
 * ALL of them. A plain `member` holds none. The server is the source of
 * truth and re-checks every key; the client mirrors the set (on
 * ForumViewerState) only to show/hide controls.
 *
 * Invariant preserved from the old fixed model: a mod can never edit or
 * delete content authored by the forum OWNER, even with edit_posts /
 * delete_posts — that's enforced server-side regardless of the grant.
 * ============================================================ */
export const FORUM_MOD_PERMISSIONS = [
  "lock_topics",          // lock / unlock topics against replies
  "pin_topics",           // sticky / unsticky topics
  "move_topics",          // move a topic between categories AND boards; merge
  "edit_posts",           // edit other members' posts (never the owner's)
  "delete_posts",         // delete other members' posts (never the owner's)
  "manage_prefixes",      // create / edit / assign topic prefixes (full curation)
  "create_tags",          // mint a tag on the fly when tagging (if allow_custom_tags)
  "review_applications",  // approve / reject membership applications
  "manage_members",       // promote members to mod, remove members
  "manage_usergroups",    // create/edit usergroups + assign members
  "ban_users",            // ban / unban users from the forum
  "handle_reports",       // view + resolve the forum's report queue
  "use_npc",              // post in the streamlined NPC format (voice an NPC)
] as const;

export type ForumModPermission = (typeof FORUM_MOD_PERMISSIONS)[number];

/** UI copy for each grantable permission (Roles tab checkboxes). */
export const FORUM_MOD_PERMISSION_META: Record<
  ForumModPermission,
  { label: string; description: string }
> = {
  lock_topics: { label: "Lock topics", description: "Lock or reopen topics against new replies." },
  pin_topics: { label: "Pin topics", description: "Sticky or unsticky topics to the top of a category." },
  move_topics: { label: "Move & merge topics", description: "Move a topic to another category or board, and merge topics." },
  edit_posts: { label: "Edit posts", description: "Edit other members' posts (never the owner's)." },
  delete_posts: { label: "Delete posts", description: "Remove other members' posts (never the owner's)." },
  manage_prefixes: { label: "Manage prefixes", description: "Create, edit, recolor, and category-scope the tag catalog." },
  create_tags: { label: "Create tags on the fly", description: "Mint a new topic tag while tagging (only when the forum allows custom tags)." },
  review_applications: { label: "Review applications", description: "Approve or reject membership applications." },
  manage_members: { label: "Manage members", description: "Promote members to moderator and remove members." },
  manage_usergroups: { label: "Manage usergroups", description: "Create and edit usergroups and assign members to them." },
  ban_users: { label: "Ban users", description: "Ban and unban users from this forum." },
  handle_reports: { label: "Handle reports", description: "See and resolve reported topics and posts." },
  use_npc: { label: "Voice NPCs", description: "Post in the streamlined NPC format (a named NPC with optional stats)." },
};

/* ============================================================
 * Member-FEATURE permissions (the second half of the unified registry).
 *
 * Moderation perms above answer "what may this person police"; feature perms
 * answer "what may this person DO". Both live in one registry (FORUM_PERMISSIONS)
 * so a usergroup can grant any of them. Feature perms are the baseline a forum's
 * DEFAULT usergroup starts with (FORUM_FEATURE_PERMISSIONS) so existing forums
 * stay fully open — every participant gets them until an owner narrows the
 * default group. `use_npc` stays in the moderation list (opt-in, as before).
 * ============================================================ */
export const FORUM_FEATURE_PERMISSIONS = [
  "post_topics",   // start new topics
  "post_replies",  // reply to topics
  "post_actions",  // use the streamlined Action (emote) post format
  "upload_images", // embed images in a post (![alt](url) markup)
  "create_polls",  // attach a poll to a new topic
] as const;

export type ForumFeaturePermission = (typeof FORUM_FEATURE_PERMISSIONS)[number];

export const FORUM_FEATURE_PERMISSION_META: Record<
  ForumFeaturePermission,
  { label: string; description: string }
> = {
  post_topics: { label: "Start topics", description: "Create new topics on the forum's boards." },
  post_replies: { label: "Post replies", description: "Reply to existing topics." },
  post_actions: { label: "Action posts", description: "Use the streamlined Action (emote) reply format." },
  upload_images: { label: "Embed images", description: "Put images in a post (the ![image](url) markup)." },
  create_polls: { label: "Create polls", description: "Attach a poll when starting a topic." },
};

/** The full unified permission registry: moderation + member features. A
 *  usergroup may grant ANY of these; a member's effective set is the union of
 *  their groups (+ default group + any direct mod grant). */
export const FORUM_PERMISSIONS = [
  ...FORUM_MOD_PERMISSIONS,
  ...FORUM_FEATURE_PERMISSIONS,
] as const;

export type ForumPermission = ForumModPermission | ForumFeaturePermission;

/** UI copy for every permission, both halves of the registry. */
export const FORUM_PERMISSION_META: Record<ForumPermission, { label: string; description: string }> = {
  ...FORUM_MOD_PERMISSION_META,
  ...FORUM_FEATURE_PERMISSION_META,
};

/** Which half a permission belongs to, for grouping the checkbox grid. */
export function forumPermissionCategory(key: ForumPermission): "moderation" | "feature" {
  return (FORUM_FEATURE_PERMISSIONS as readonly string[]).includes(key) ? "feature" : "moderation";
}

export function isForumPermission(s: string): s is ForumPermission {
  return (FORUM_PERMISSIONS as readonly string[]).includes(s);
}

/** Tolerant parse of a stored permission array (groups + direct grants). */
export function parseForumPermissions(json: string | null | undefined): ForumPermission[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    const out = new Set<ForumPermission>();
    for (const v of arr) if (typeof v === "string" && isForumPermission(v)) out.add(v);
    return [...out];
  } catch {
    return [];
  }
}

/** Canonical (sorted) serialization so equal sets compare equal in storage. */
export function serializeForumPermissions(perms: readonly ForumPermission[]): string {
  return JSON.stringify([...new Set(perms)].filter(isForumPermission).sort());
}

/* ============================================================
 * Account NPCs (per-account, reusable in any forum)
 * ============================================================ */

export const NPC_NAME_MAX = 40;
export const NPC_MAX_STATS = 12;
export const NPC_STAT_LABEL_MAX = 24;
export const NPC_STAT_VALUE_MAX = 40;
export const NPC_MAX_PER_ACCOUNT = 50;

/** One labeled stat line on an NPC (e.g. {label:"HP", value:"30/30"}). */
export interface NpcStat {
  label: string;
  value: string;
}

/** A saved, per-account NPC the owner can voice in any forum (subject to the
 *  forum's use_npc grant). Re-selecting it restores name + stats. */
export interface UserNpcWire {
  id: string;
  name: string;
  stats: NpcStat[];
  updatedAt: number;
}

/** Parse a stored NPC stats JSON into a clean, capped stat list. Tolerant. */
export function parseNpcStats(json: string | null | undefined): NpcStat[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    const out: NpcStat[] = [];
    for (const s of arr) {
      if (out.length >= NPC_MAX_STATS) break;
      if (s && typeof s.label === "string" && typeof s.value === "string") {
        const label = s.label.trim().slice(0, NPC_STAT_LABEL_MAX);
        const value = s.value.trim().slice(0, NPC_STAT_VALUE_MAX);
        if (label) out.push({ label, value });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeNpcStats(stats: readonly NpcStat[]): string {
  return JSON.stringify(parseNpcStats(JSON.stringify(stats)));
}

/** The set a freshly-appointed mod gets when the owner doesn't customize —
 *  the classic "topic janitor" powers, minus the sensitive ones (ban,
 *  manage members) which the owner must grant deliberately. */
export const FORUM_MOD_DEFAULT_PERMISSIONS: ForumModPermission[] = [
  "lock_topics", "pin_topics", "move_topics", "edit_posts", "delete_posts", "review_applications",
];

export function isForumModPermission(s: string): s is ForumModPermission {
  return (FORUM_MOD_PERMISSIONS as readonly string[]).includes(s);
}

/** Parse a stored `permissions_json` string into a clean, de-duped set of
 *  valid keys. Tolerant: bad JSON / unknown keys are dropped, never thrown.
 *  Used by the server (authority) and any client that reads the raw row. */
export function parseForumModPermissions(json: string | null | undefined): ForumModPermission[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    const out = new Set<ForumModPermission>();
    for (const v of arr) if (typeof v === "string" && isForumModPermission(v)) out.add(v);
    return [...out];
  } catch {
    return [];
  }
}

/** Canonical serialization (sorted) for storage so equal sets compare equal. */
export function serializeForumModPermissions(perms: readonly ForumModPermission[]): string {
  const clean = [...new Set(perms)].filter(isForumModPermission).sort();
  return JSON.stringify(clean);
}

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
  /** Owner-defined topic prefixes (the chip catalog). Empty when none. */
  prefixes: ForumPrefixWire[];
  /** Owner toggle: a mod with `create_tags` may mint a tag on the fly when
   *  tagging (off = curated catalog only, offered per category). */
  allowCustomTags: boolean;
  /** Every category across the forum's boards, for the prefix category-scope
   *  picker in settings. Small; sent to all viewers (names already public). */
  categories: ForumCategoryRef[];
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
  /**
   * Whether the viewer counts as a member for read/post gating. Broader than a
   * non-null `role`: it's also true for the forum owner, site staff with
   * `manage_any_forum`, and EVERY signed-in user on the system/default forum
   * (implicit membership). UI should gate "join" prompts on this, not on
   * `role`, or an implicit member of the default forum gets nagged to join
   * something they already belong to.
   */
  isMember: boolean;
  /** Active ban, if any. `until` null = permanent. */
  ban: { until: number | null; reason: string | null } | null;
  /** Pending membership application exists. */
  membershipPending: boolean;
  /** Resolved "may open boards / post" verdict for this viewer. */
  canParticipate: boolean;
  /** Owner-tier control (forum owner OR site staff with manage_any_forum):
   *  shows the settings gear / owner console. */
  canManage: boolean;
  /** This viewer's effective forum permissions — the UNION of the default
   *  usergroup, every group they're in, and any direct mod grant (owner/staff
   *  hold every key, so `canManage` implies all). Spans the whole registry
   *  (moderation + member features). Client UI gates each control on the
   *  matching key; the server re-checks regardless. */
  permissions: ForumPermission[];
}

/** One row in the owner's Roles tab: a forum moderator + their grants.
 *  (The owner is listed separately, with all powers implied.) */
export interface ForumModEntry {
  userId: string;
  username: string;
  /** Avatar snapshot for the picker/list (null = glyph fallback). */
  avatarUrl: string | null;
  since: number;
  permissions: ForumModPermission[];
}

/** One forum the signed-in viewer owns or moderates (GET /me/forums),
 *  with their effective permission set. Drives the profile "Ban from
 *  forum" action + its forum-picker when they manage several. */
export interface ForumManagedEntry {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  permissions: ForumModPermission[];
}

/* ============================================================
 * Topic prefixes / tags
 * ============================================================ */

export const FORUM_PREFIX_LABEL_MAX = 24;
/** Short hover explanation of a tag. */
export const FORUM_PREFIX_TOOLTIP_MAX = 140;
export const FORUM_MAX_PREFIXES = 30;
/** A 3/6-digit hex color (validated client + server). */
export const FORUM_PREFIX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** One owner-defined topic prefix (label + chip color). */
export interface ForumPrefixWire {
  id: string;
  label: string;
  color: string;
  /** Short hover explanation of what the tag means. Null = none. */
  tooltip: string | null;
  sortOrder: number;
  /** room_thread_category ids this tag is offered in. Empty = global (every
   *  topic); non-empty = only topics in those categories show it in the
   *  picker. A topic keeps an assigned tag even if later moved out of scope. */
  categoryIds: string[];
}

/** A category across a forum's boards, for the prefix category-scope picker
 *  (ForumDetail.categories). `boardName` groups the picker by board. */
export interface ForumCategoryRef {
  id: string;
  name: string;
  boardName: string;
}

/** Parse a stored `category_ids_json` into a clean string-id array. Tolerant:
 *  bad JSON / non-strings drop to []. Used by the server (read + scope check). */
export function parsePrefixCategoryIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return [...new Set(arr.filter((v): v is string => typeof v === "string" && v.length > 0))];
  } catch {
    return [];
  }
}

/** Is a prefix offered on a topic in `categoryId`? Global tags (no categories)
 *  are offered everywhere; scoped tags only in their listed categories. */
export function prefixAppliesToCategory(
  prefix: Pick<ForumPrefixWire, "categoryIds">,
  categoryId: string | null,
): boolean {
  return prefix.categoryIds.length === 0 || (categoryId !== null && prefix.categoryIds.includes(categoryId));
}

/* ============================================================
 * Usergroups (unified permissions + auto-join rules)
 * ============================================================ */

export const FORUM_USERGROUP_NAME_MAX = 40;
export const FORUM_MAX_USERGROUPS = 40;
/** Cap on auto-join rules per group (keeps the on-post evaluation cheap). */
export const FORUM_MAX_AUTO_RULES = 6;

/** One auto-join rule. A user joins a group when they satisfy EVERY rule on
 *  it (AND). Evaluated lazily when a member posts in the forum. */
export type ForumAutoRule =
  | { kind: "post_count"; min: number }       // total non-deleted posts in the forum
  | { kind: "topic_count"; min: number }      // topics started in the forum
  | { kind: "posted_in_category"; categoryId: string } // has a post in this category
  | { kind: "account_age_days"; min: number } // account age
  | { kind: "member_age_days"; min: number }; // time since joining this forum

export type ForumAutoRuleKind = ForumAutoRule["kind"];

/** UI copy for each auto-rule kind. */
export const FORUM_AUTO_RULE_META: Record<ForumAutoRuleKind, { label: string; unit: string | null }> = {
  post_count: { label: "Post count at least", unit: "posts" },
  topic_count: { label: "Topics started at least", unit: "topics" },
  posted_in_category: { label: "Has posted in category", unit: null },
  account_age_days: { label: "Account age at least", unit: "days" },
  member_age_days: { label: "Forum member for at least", unit: "days" },
};

/** Tolerant parse of a stored `auto_rules_json`. Drops malformed entries. */
export function parseForumAutoRules(json: string | null | undefined): ForumAutoRule[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    const out: ForumAutoRule[] = [];
    for (const r of arr) {
      if (out.length >= FORUM_MAX_AUTO_RULES) break;
      if (!r || typeof r.kind !== "string") continue;
      if (r.kind === "posted_in_category") {
        if (typeof r.categoryId === "string" && r.categoryId) out.push({ kind: "posted_in_category", categoryId: r.categoryId });
      } else if (
        (r.kind === "post_count" || r.kind === "topic_count" || r.kind === "account_age_days" || r.kind === "member_age_days") &&
        typeof r.min === "number" && Number.isFinite(r.min) && r.min >= 1
      ) {
        // Floor of 1: a `min: 0` threshold matches everyone who posts (it's
        // always true), which would silently auto-grant the group — including
        // any moderation perms on it — to the whole active membership.
        out.push({ kind: r.kind, min: Math.floor(r.min) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeForumAutoRules(rules: readonly ForumAutoRule[]): string {
  return JSON.stringify(rules);
}

/** One usergroup as shown in the owner's Usergroups settings tab. */
export interface ForumUsergroupWire {
  id: string;
  name: string;
  color: string | null;
  permissions: ForumPermission[];
  /** The implicit baseline group (every participant); not manually joinable. */
  isDefault: boolean;
  sortOrder: number;
  autoRules: ForumAutoRule[];
  /** Explicit members (manual + auto). The default group reports 0 — its
   *  membership is everyone, so it isn't enumerated. */
  memberCount: number;
}

/** One explicit member row in a group's roster (GET .../usergroups/:gid/members). */
export interface ForumUsergroupMemberWire {
  userId: string;
  username: string;
  avatarUrl: string | null;
  /** True = earned via auto-rules; false = added by a manager. */
  isAuto: boolean;
  addedAt: number;
}

/* ============================================================
 * Report queue
 * ============================================================ */

export const FORUM_REPORT_REASON_MAX = 500;
export type ForumReportStatus = "open" | "resolved" | "dismissed";

/** One row in a forum's report queue. Author/snippet/title are resolved at
 *  read time (not snapshotted) so an edited post shows its current text. */
export interface ForumReportWire {
  id: string;
  status: ForumReportStatus;
  reason: string;
  reporterUsername: string;
  /** Display name of the reported post's author. */
  reportedAuthorName: string;
  /** Plain-text snippet of the reported post. */
  reportedSnippet: string;
  messageId: string;
  topicId: string | null;
  topicTitle: string | null;
  boardRoomId: string | null;
  createdAt: number;
  resolvedByUsername: string | null;
  resolutionNote: string | null;
  resolvedAt: number | null;
}

/** One entry in a forum's Mod Log (audit rows scoped to the forum). */
export interface ForumModLogEntry {
  id: string;
  /** AuditAction string, e.g. "forum_topic_lock", "forum_ban". */
  action: string;
  actorUsername: string;
  targetUsername: string | null;
  reason: string | null;
  /** Action-specific extras (title, locked/sticky state, from/to, etc.). */
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

/** One row in the Members directory. Mods carry their granular permissions;
 *  the owner and plain members carry an empty set. */
export interface ForumMemberEntry {
  userId: string;
  username: string;
  avatarUrl: string | null;
  role: ForumRole;
  permissions: ForumModPermission[];
  joinedAt: number;
}

/** A user-lookup search hit (shared by the forum mod/ban/member pickers). */
export interface ForumUserSearchHit {
  userId: string;
  username: string;
  avatarUrl: string | null;
  /** Character display names on the account, for recognizing who this is. */
  characterNames: string[];
  /** Already a mod / owner / banned in the forum being managed — lets the
   *  picker disable or annotate the row. */
  forumRole: ForumRole | null;
  banned: boolean;
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
  /** Assigned prefix id (resolve against ForumDetail.prefixes), or null. */
  prefixId: string | null;
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
