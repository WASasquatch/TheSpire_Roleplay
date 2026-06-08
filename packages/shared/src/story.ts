import type { Theme } from "./theme.js";

/**
 * The Scriptorium, long-form fiction wire types. Stories are authored
 * by identities (master account OR a specific character) and surface in
 * three places:
 *
 *   1. The splash page catalog (SFW, public stories only).
 *   2. The in-app catalog (everything the viewer is allowed to see).
 *   3. The author's "My Stories" tab in the writing editor.
 *
 * Visibility is orthogonal to rating: visibility says WHO can see the
 * story, rating says WHAT the story contains. Anonymous splash viewers
 * see G / PG / PG-13 only; R / NC-17 are stripped from the splash
 * response server-side regardless of visibility (the splash never
 * leaks NSFW thumbnails to crawlers or unauthenticated browsers).
 */

/**
 * Visibility tier, mirrors world visibility, with `unlisted` added so
 * an author can share a beta-reader link without putting the story in
 * the public catalog.
 *
 *   - private:   author + invited collaborators only
 *   - unlisted:  anyone with the URL can read; not in any catalog
 *   - public:    listed in catalogs; readable per rating gate
 */
export type StoryVisibility = "private" | "unlisted" | "public";

/**
 * Rating tier, single-select. Drives the splash-page filter and the
 * NSFW gate for anonymous viewers.
 */
export type StoryRating = "G" | "PG" | "PG-13" | "R" | "NC-17";

/** Catalog list of all rating tiers in display order. */
export const STORY_RATINGS = ["G", "PG", "PG-13", "R", "NC-17"] as const;

/**
 * Splash-strip-safe ratings, ratings whose CARD (cover, title, summary)
 * may surface on anonymous-visible carousel-style preview surfaces
 * without a click-through. Stricter than {@link PUBLIC_READABLE_RATINGS}
 * because preview surfaces show content unconditionally, a thumbnail
 * for an R-rated cover may itself be NSFW.
 */
export const SFW_RATINGS: readonly StoryRating[] = ["G", "PG", "PG-13"] as const;

/**
 * Ratings whose full BODY anonymous viewers may read. The intent here
 * is to mask only the explicit tier (NC-17, graphic sex, extreme
 * gore) behind the login wall. Strong content up to and including R
 * is reachable without an account; the catalog still labels each
 * card with its rating chip so readers self-select.
 *
 * NC-17 cards still APPEAR in the public catalog (so the count is
 * honest and the existence of the work isn't hidden), but opening
 * one anonymously returns a private-stub forcing login/register.
 */
export const PUBLIC_READABLE_RATINGS: readonly StoryRating[] = ["G", "PG", "PG-13", "R"] as const;

/** True iff this rating requires an authenticated viewer to OPEN the
 *  story body. Catalog visibility is unaffected, cards still render. */
export function ratingRequiresAuth(rating: StoryRating): boolean {
  return rating === "NC-17";
}

/**
 * Author-facing copy describing what each rating tier covers. Drives
 * the RatingPicker card selector in the Overview tab + New Story
 * wizard so the author understands the bracket they're picking instead
 * of guessing at industry shorthand.
 *
 * The descriptions are intentionally explicit about WHERE the line
 * sits between R and NC-17, the difference is "depicted vs. graphic"
 * (R: sex / violence occurs, NC-17: sex / violence is depicted in
 * graphic detail). Picking the right tier matters because R is
 * publicly readable and NC-17 requires login.
 */
export const STORY_RATING_INFO: Record<StoryRating, {
  label: string;
  short: string;
  /** Long-form description shown on the picker card. */
  description: string;
  /** Whether anonymous readers can open the body. */
  publicReadable: boolean;
}> = {
  "G":     {
    label: "G",
    short: "All ages",
    description: "Family-friendly. No violence beyond cartoon-level, no sexual content, no harsh language. Suitable for any reader.",
    publicReadable: true,
  },
  "PG":    {
    label: "PG",
    short: "Mild themes",
    description: "Brief mild language, comic-style action, light romantic content (hand-holding, a kiss). Some scary moments without lasting harm.",
    publicReadable: true,
  },
  "PG-13": {
    label: "PG-13",
    short: "Teen content",
    description: "Moderate violence, occasional strong language, brief partial nudity or suggestive scenes without explicit depiction. Action with consequences; conflict with stakes.",
    publicReadable: true,
  },
  "R":     {
    label: "R",
    short: "Adult themes",
    description: "Strong violence, harsh language, sexual content and nudity. Acts may occur on the page but are NOT depicted in explicit detail, that's NC-17 territory. Publicly readable; readers expect mature situations.",
    publicReadable: true,
  },
  "NC-17": {
    label: "NC-17",
    short: "Explicit / NSFW",
    description: "Graphic sexual content and / or extreme gore. Depicted in explicit detail rather than implied. Cards stay listed in the public catalog so the work exists in the index, but opening the story requires an account.",
    publicReadable: false,
  },
};

/**
 * Story lifecycle status. Drives a chip on the cover + a filter in
 * the catalog.
 */
export type StoryStatus = "draft" | "in_progress" | "complete" | "hiatus" | "abandoned";

export const STORY_STATUSES = ["draft", "in_progress", "complete", "hiatus", "abandoned"] as const;

/**
 * Genre taxonomy. Closed enum so the catalog filter chips can render
 * a known list without an extra round-trip.
 */
export type StoryGenre =
  | "fantasy"
  | "modern"
  | "scifi"
  | "horror"
  | "western"
  | "steampunk"
  | "mythological"
  | "slice-of-life"
  | "romance"
  | "mystery"
  | "historical"
  | "crossover"
  | "other";

export const STORY_GENRES: readonly StoryGenre[] = [
  "fantasy", "modern", "scifi", "horror", "western", "steampunk",
  "mythological", "slice-of-life", "romance", "mystery", "historical",
  "crossover", "other",
] as const;

/**
 * Curated tag list. Owners can author free-form tags too; this list
 * powers the catalog's filter chips + the editor's "common tags"
 * picker.
 */
export const STORY_CANONICAL_TAGS = [
  "action",
  "adventure",
  "angst",
  "comedy",
  "drama",
  "fluff",
  "found-family",
  "hurt-comfort",
  "introspection",
  "mystery",
  "political",
  "romance",
  "slow-burn",
  "slice-of-life",
  "tragedy",
  "world-building",
] as const;
export type StoryCanonicalTag = (typeof STORY_CANONICAL_TAGS)[number];

/**
 * Closed content-warning set. Extends the world CW vocabulary with
 * fiction-specific warnings the Scriptorium needs to surface. Readers
 * can blocklist a CW and the catalog respects it.
 */
export const STORY_CONTENT_WARNINGS = [
  "violence",
  "gore",
  "nsfw",
  "explicit-sexual",
  "dubcon",
  "noncon",
  "body-horror",
  "dark-themes",
  "substance",
  "self-harm",
  "suicide",
  "death",
  "discrimination",
] as const;
export type StoryContentWarning = (typeof STORY_CONTENT_WARNINGS)[number];

/** Per-chapter publication status. */
export type StoryChapterStatus = "draft" | "published";

/** Hard cap on chapter count. */
export const STORY_CHAPTER_CAP = 500;

/** Hard cap on total tags per story. */
export const STORY_TAG_CAP = 20;

/** Hard cap on per-story autosave snapshots kept in history. Publish frames are kept indefinitely. */
export const STORY_AUTOSAVE_HISTORY_CAP = 20;

/** Slug derivation for stories, same rules as worlds. */
export function deriveStorySlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Strip HTML and count whitespace-separated tokens. Same function used
 * server-side on save and client-side in the editor's live word count.
 */
export function countWords(html: string): number {
  if (!html) return 0;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return 0;
  return text.split(" ").length;
}

/* ----- Scriptorium writing-reward math (shared so the editor can preview, and
 *       the server stays authoritative with the exact same numbers) ----- */

/**
 * Monday (UTC) that starts the week containing `date`, as YYYY-MM-DD. This is
 * the Scriptorium weekly-streak key — the writing analog of the eidolon daily
 * day-key. Readable, and gives exact week-gap math via `weekNumFromKey`.
 */
export function isoWeekKey(date: Date = new Date()): string {
  const dayNum = Math.floor(date.getTime() / 86_400_000); // days since epoch (UTC)
  // 1970-01-01 (dayNum 0) was a Thursday; offset to the most recent Monday.
  const offsetToMonday = (((dayNum + 3) % 7) + 7) % 7;
  const monday = new Date((dayNum - offsetToMonday) * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

/** Integer week index for a key from `isoWeekKey` (consecutive weeks differ by
 *  exactly 1), used for gap math. */
export function weekNumFromKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  const dayNum = Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
  return Math.floor((dayNum + 3) / 7);
}

export interface WeeklyStreakState {
  streakCount: number;
  lastPublishWeekKey: string | null;
  bestStreak: number;
}
export interface WeeklyStreakRoll {
  streakCount: number;
  bestStreak: number;
  lastPublishWeekKey: string;
  /** True when this publish was the first of a new week (the streak moved). */
  advanced: boolean;
}

/**
 * Advance the weekly publishing streak. Publishing again the same week is a
 * no-op; a consecutive week (gap of exactly 1) increments; a gap of two or
 * more weeks resets to 1 (no grace — stricter than the eidolon daily loop).
 */
export function rollWeeklyStreak(prev: WeeklyStreakState, thisWeekKey: string): WeeklyStreakRoll {
  if (prev.lastPublishWeekKey === thisWeekKey) {
    return { streakCount: prev.streakCount, bestStreak: prev.bestStreak, lastPublishWeekKey: thisWeekKey, advanced: false };
  }
  let streak: number;
  if (!prev.lastPublishWeekKey) {
    streak = 1;
  } else {
    const gap = weekNumFromKey(thisWeekKey) - weekNumFromKey(prev.lastPublishWeekKey);
    streak = gap === 1 ? prev.streakCount + 1 : 1;
  }
  const bestStreak = Math.max(prev.bestStreak, streak);
  return { streakCount: streak, bestStreak, lastPublishWeekKey: thisWeekKey, advanced: true };
}

/** Payout multiplier from the current weekly streak: 1 + perWeekBonus·(weeks-1),
 *  clamped to [1, maxMultiplier]. */
export function scriptoriumStreakMultiplier(
  streakCount: number,
  cfg: { perWeekBonus: number; maxMultiplier: number },
): number {
  const mult = 1 + cfg.perWeekBonus * Math.max(0, streakCount - 1);
  return Math.min(cfg.maxMultiplier, Math.max(1, mult));
}

/** Base (pre-streak) reward for a chapter of `wordCount` words: a continuous
 *  per-word payout that scales with length, or zero below the word floor. */
export function scriptoriumChapterBaseReward(
  wordCount: number,
  cfg: { xpPerWord: number; currencyPerWord: number; wordFloor: number },
): { xp: number; currency: number } {
  if (wordCount < cfg.wordFloor) return { xp: 0, currency: 0 };
  return {
    xp: Math.round(wordCount * cfg.xpPerWord),
    currency: Math.round(wordCount * cfg.currencyPerWord),
  };
}

/**
 * Compact author identity. Mirrors the "identity = master OR character"
 * model used by messages, profiles, and reviews elsewhere.
 */
export interface StoryAuthor {
  userId: string;
  masterUsername: string;
  characterId: string | null;
  characterName: string | null;
  characterAvatarUrl: string | null;
  masterAvatarUrl: string | null;
}

/**
 * The "card" shape used in catalog views. Cheap to render; excludes
 * the synopsis HTML and chapter bodies so a 24-card page is a single
 * round-trip.
 */
export interface StoryCard {
  id: string;
  slug: string;
  title: string;
  summary: string;
  coverImageUrl: string | null;
  author: StoryAuthor;
  genre: StoryGenre;
  rating: StoryRating;
  status: StoryStatus;
  visibility: StoryVisibility;
  tags: string[];
  contentWarnings: string[];
  linkedWorld: { id: string; slug: string; name: string } | null;
  totalWords: number;
  totalChapters: number;
  readerCount: number;
  applauseCount: number;
  reviewCount: number;
  avgRating: number | null;
  publishedAt: number | null;
  updatedAt: number;
}

/** Lightweight chapter row used in the editor's chapter list + reader TOC. */
export interface StoryChapterRef {
  id: string;
  storyId: string;
  sortOrder: number;
  title: string;
  status: StoryChapterStatus;
  wordCount: number;
  contentWarnings: string[];
  publishedAt: number | null;
  updatedAt: number;
}

/** Full chapter shape returned when the reader opens a chapter or the author edits. */
export interface StoryChapter extends StoryChapterRef {
  bodyHtml: string;
  authorNotesHtml: string;
  createdAt: number;
}

/** Story landing-page payload. */
export interface StoryDetail {
  story: StoryCard & {
    synopsisHtml: string;
    theme: Theme | null;
    allowReviews: boolean;
    allowApplause: boolean;
    createdAt: number;
  };
  chapters: StoryChapterRef[];
  viewerCanEdit: boolean;
  viewerIsAuthor: boolean;
  readingPosition: StoryReadingPosition | null;
}

/** Paged catalog response. */
export interface StoryCatalogPage {
  entries: StoryCard[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/** Per-version snapshot returned by the version history pane. */
export interface StoryChapterVersion {
  id: string;
  chapterId: string;
  version: number;
  bodyHtml: string;
  authorNotesHtml: string;
  reason: "autosave" | "publish" | "manual";
  savedByUserId: string | null;
  savedAt: number;
}

/**
 * Reading position pointer. The reader's own; never exposed to author
 * or admins.
 */
export interface StoryReadingPosition {
  storyId: string;
  lastChapterId: string | null;
  lastAnchorId: string | null;
  /** 0..100 (integer; the wire converts from the stored x10 form). */
  percentThrough: number;
  updatedAt: number;
}

/**
 * Returned when an anonymous viewer hits a story they can't see.
 * Mirrors the private-world-stub pattern so the client can prompt
 * sign-in instead of rendering a flat 404.
 */
export interface PrivateStoryStub {
  private: true;
  title: string;
  slug: string;
  /** Why the viewer is blocked. */
  reason: "visibility" | "rating";
  /** True iff anonymous; the client surfaces a "sign in" CTA. */
  requiresAuth: boolean;
}

/* ---------- Reviews + Applause (Phase 6) ---------- */

/** Edit grace mirrors chat / DM grace (60s). */
export const STORY_REVIEW_EDIT_GRACE_MS = 60_000;

/** Maximum prose body length on a review (sanitized HTML pre-strip). */
export const STORY_REVIEW_BODY_MAX = 20_000;

/** Maximum prose body length on a review reply. */
export const STORY_REVIEW_REPLY_MAX = 5_000;

/**
 * Brief reviewer identity, embedded in each review + reply. Same shape
 * as `StoryAuthor` so the renderer can reuse the avatar/name fallback
 * logic.
 */
export interface StoryReviewer {
  userId: string;
  masterUsername: string;
  characterId: string | null;
  characterName: string | null;
  characterAvatarUrl: string | null;
  masterAvatarUrl: string | null;
}

/** A single review and its (optional, one-level) replies. */
export interface StoryReview {
  id: string;
  storyId: string;
  reviewer: StoryReviewer;
  /** 1..5 stars. */
  rating: number;
  bodyHtml: string;
  pinnedByAuthor: boolean;
  /** True iff the author hid it. Hidden reviews are filtered server-side
   *  for everyone except the author + the reviewer themselves. */
  hiddenByAuthor: boolean;
  /** ms-since-epoch the edit grace expires; null = grace passed. */
  editGraceExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  replies: StoryReviewReply[];
}

export interface StoryReviewReply {
  id: string;
  reviewId: string;
  replyer: StoryReviewer;
  bodyHtml: string;
  createdAt: number;
  updatedAt: number;
}

/** Paged review listing, returned by GET /stories/:id/reviews. */
export interface StoryReviewPage {
  /** Pinned reviews float to the top here, regardless of recency. */
  reviews: StoryReview[];
  /** Total review count for the story (matches stories.reviewCount). */
  total: number;
  /** Average star rating across visible reviews; null when no reviews. */
  avgRating: number | null;
  /** True iff the viewer has already left a review on this story. */
  viewerHasReviewed: boolean;
}

/** Wire shape for the applause toggle endpoint. */
export interface StoryApplauseState {
  /** Total applause count for the target after the toggle. */
  count: number;
  /** Whether the viewer is currently applauding (after toggle). */
  viewerApplauded: boolean;
}

/* ---------- Subscriptions (Phase 7) ---------- */

/** Per-viewer subscription state for a story. */
export interface StorySubscriptionState {
  storyId: string;
  /** True iff the caller is subscribed. */
  subscribed: boolean;
  /** True iff they've opted into web-push for this story. */
  pushEnabled: boolean;
  /** Total subscriber count (rollup, visible to author + reader). */
  subscriberCount: number;
}

/**
 * Payload of the `story:chapter-published` socket event the server
 * emits to every subscriber when an author publishes a new chapter.
 * Includes enough context for the client to render an inline system
 * message without a follow-up fetch.
 */
export interface StoryChapterPublishedEvent {
  storyId: string;
  storySlug: string;
  storyTitle: string;
  authorHandle: string;
  authorDisplayName: string;
  chapterId: string;
  chapterTitle: string;
  chapterIndex: number;
  publishedAt: number;
}

/* ---------- Reports (Phase 10) ---------- */

/** What kind of object a report points at. */
export type StoryReportTargetKind = "story" | "chapter" | "review" | "review_reply";

export const STORY_REPORT_TARGET_KINDS: readonly StoryReportTargetKind[] = [
  "story", "chapter", "review", "review_reply",
] as const;

/** Lifecycle states for a report row. Same shape as the chat-reports table. */
export type StoryReportStatus = "open" | "reviewed" | "dismissed";

/**
 * Wire shape for the admin queue. The `snapshot` field is a free-form
 * object captured at report time so the queue still renders if the
 * reported content has since been deleted.
 */
export interface StoryReport {
  id: string;
  targetKind: StoryReportTargetKind;
  targetId: string;
  storyId: string;
  storyTitle: string;
  /** Reporter's master username (admin queue surface, no characters needed here). */
  reporterUsername: string;
  reporterUserId: string;
  reason: string | null;
  snapshot: Record<string, unknown>;
  status: StoryReportStatus;
  resolvedByUsername: string | null;
  resolvedAt: number | null;
  resolutionNote: string | null;
  createdAt: number;
}

/** Admin-side filter on the queue listing. */
export interface StoryReportFilter {
  status?: StoryReportStatus;
  targetKind?: StoryReportTargetKind;
  storyId?: string;
}

/* ---------- Collaboration (Phase 5) ---------- */

/**
 * Soft-lock lease length and recommended heartbeat interval (ms).
 * Client refreshes every ~2 minutes; server expires the row 5 minutes
 * after the last refresh. The asymmetry covers a one-missed-heartbeat
 * grace period (network blip, mobile suspend) before another
 * collaborator can take over.
 */
export const STORY_CHAPTER_LOCK_LEASE_MS = 5 * 60 * 1000;
export const STORY_CHAPTER_LOCK_HEARTBEAT_MS = 2 * 60 * 1000;

/** Wire shape returned by lock acquire / refresh / GET. */
export interface StoryChapterLockState {
  chapterId: string;
  /** True iff the lock is now held by the caller. */
  heldByMe: boolean;
  /** Display info for the holder when someone else is editing. Null when free or held by caller. */
  holder: { userId: string; username: string } | null;
  /** ms-since-epoch the lease expires (lastRefresh + lease). */
  expiresAt: number;
  /**
   * Chapter's current `updatedAt` so the client's heartbeat can
   * detect divergence (someone saved while we were editing). The
   * client tracks the value seen on chapter load; when the lock
   * response carries a newer value, it surfaces a "diverged" banner.
   */
  currentUpdatedAt: number;
}

/**
 * Per-story role granted to a collaborator. The story's owner is
 * implicit (`stories.authorUserId`) and never appears in the
 * collaborators table.
 *
 *   reader    , read drafts only
 *   editor    , edit existing chapters + manage codex
 *   co_author , edit + add chapters, publish
 *
 * Owner (implicit) is the only role with manage-collaborators +
 * delete-story powers. Admins inherit owner-level access via the
 * existing `isAdminRole` check.
 */
export type StoryCollaboratorRole = "reader" | "editor" | "co_author";

export const STORY_COLLABORATOR_ROLES: readonly StoryCollaboratorRole[] = [
  "reader", "editor", "co_author",
] as const;

/** Permissions matrix surfaced server-side so the client can mirror it. */
export interface StoryRolePermissions {
  readDrafts: boolean;
  editChapters: boolean;
  addChapters: boolean;
  manageCodex: boolean;
  manageCollaborators: boolean;
  publish: boolean;
  deleteStory: boolean;
}

/**
 * Resolve permissions for a (claimed) role. Owner / admin permissions
 * are computed at the call site since they're not stored in the
 * collaborators table.
 */
export function permissionsForCollaboratorRole(role: StoryCollaboratorRole): StoryRolePermissions {
  switch (role) {
    case "reader":
      return {
        readDrafts: true,
        editChapters: false,
        addChapters: false,
        manageCodex: false,
        manageCollaborators: false,
        publish: false,
        deleteStory: false,
      };
    case "editor":
      return {
        readDrafts: true,
        editChapters: true,
        addChapters: false,
        manageCodex: true,
        manageCollaborators: false,
        publish: false,
        deleteStory: false,
      };
    case "co_author":
      return {
        readDrafts: true,
        editChapters: true,
        addChapters: true,
        manageCodex: true,
        manageCollaborators: false,
        publish: true,
        deleteStory: false,
      };
  }
}

/** Wire shape for one collaborator row. */
export interface StoryCollaborator {
  storyId: string;
  userId: string;
  username: string;
  /** Optional avatar shown in the collaborators list. */
  avatarUrl: string | null;
  role: StoryCollaboratorRole;
  /** Master username of the inviter; null when the inviter has been deleted. */
  invitedByUsername: string | null;
  invitedAt: number;
  /** Null while the invite is pending; non-null after the recipient accepts. */
  acceptedAt: number | null;
}

/**
 * Outbound listing for a user's pending collaboration invites, shown
 * in the catalog's My Stories tab when there are any. Carries enough
 * story metadata that the recipient can decide without opening the
 * story first.
 */
export interface StoryCollaboratorInvite {
  storyId: string;
  storyTitle: string;
  storySlug: string;
  storyAuthorUsername: string;
  role: StoryCollaboratorRole;
  invitedByUsername: string | null;
  invitedAt: number;
}

/* ---------- Codex (Phase 8) ---------- */

/** Three discriminated entity kinds in a story's codex. */
export type StoryEntityKind = "character" | "location" | "plot";

export const STORY_ENTITY_KINDS: readonly StoryEntityKind[] = [
  "character", "location", "plot",
] as const;

/**
 * Closed-enum status values for `kind: "plot"` entities. Renderer
 * displays these as colored chips (planned → muted, payoff → action,
 * resolved → success). Stored as a string in `statsJson.status`.
 */
export const STORY_PLOT_STATUSES = ["planned", "setup", "payoff", "resolved"] as const;
export type StoryPlotStatus = (typeof STORY_PLOT_STATUSES)[number];

/** Wire shape for one codex entity. */
export interface StoryEntity {
  id: string;
  storyId: string;
  kind: StoryEntityKind;
  slug: string;
  name: string;
  summary: string;
  bodyHtml: string;
  /** Free-form kv. Plot entities reserve `status` (StoryPlotStatus). */
  stats: Record<string, string>;
  imageUrl: string | null;
  isPublic: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** Body cap for an entity's long-form description (sanitized HTML). */
export const STORY_ENTITY_BODY_MAX = 20_000;

/** Per-entity-kind cap so a codex doesn't grow unboundedly. */
export const STORY_ENTITY_PER_KIND_CAP = 200;

/* ---------- User catalog prefs (Phase 9) ---------- */

/**
 * Per-user Scriptorium catalog preferences. Wire shape returned by
 * `/me/profile` and accepted by `/me/profile` PATCH.
 *
 *   showNsfw   , Opt-in for R / NC-17 cards in the catalog. Anonymous
 *                 viewers are gated server-side regardless; this gates
 *                 signed-in viewers too. Default off.
 *   cwBlocklist, Always-hide list. Cards tagged with ANY warning in
 *                 this set are filtered out of catalog responses.
 */
export interface UserStoryPrefs {
  showNsfw: boolean;
  cwBlocklist: string[];
}

