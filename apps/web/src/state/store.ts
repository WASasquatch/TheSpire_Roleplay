import { create } from "zustand";
import type {
  ChatMessage,
  DirectConversationSummary,
  DirectMessage,
  PermissionKey,
  PollUpdate,
  ProfileView,
  Role,
  RoomOccupant,
  RoomSummary,
  TheaterSync,
  Theme,
  TypingEntry,
} from "@thekeep/shared";
import { DEFAULT_THEME } from "@thekeep/shared";

export interface AuthMe {
  id: string;
  username: string;
  role: Role;
  /** Resolved permission set the server reports for this user (Phase
   *  2 granular permissions). Used by UI gates as the canonical
   *  source of truth, `me.permissions.includes("manage_emoticon_catalog")`
   *  beats `isAdminRole(me.role)` because it folds in per-user
   *  overrides + matrix role-grant edits without needing a re-login.
   *  Refreshes on the same /auth/me 60s poll the rest of the payload
   *  rides. */
  permissions: PermissionKey[];
  /**
   * Persistent incognito ("ghost") mode flag. When true the user is
   * hidden from userlists, room enter/leave is silent, and any chat
   * line they send renders as a system message under `incognitoAlias`
   * instead of their identity. Toggled by /incognito (gated on
   * `use_ghost_mode`). The ToolPanel uses this to flip the menu item
   * between "Go Incognito" and "Leave Incognito", and the chat shell
   * uses it to render the standing "you're hidden" banner.
   */
  incognitoMode: boolean;
  /** Display name shown on outgoing system lines while incognito.
   *  Null → server falls back to the literal "System". */
  incognitoAlias: string | null;
  /**
   * When this account's email was confirmed (ms epoch), or null if not
   * verified. Only meaningful when `emailVerificationEnabled` is on.
   * Drives the verify banner (nudge) / chat gate (block). Present on the
   * login + register responses and refreshed on every /auth/me poll.
   */
  emailVerifiedAt: number | null;
  /** Site policy: is email verification enabled? Undefined until the first
   *  /auth/me poll resolves it (login/register responses omit it). */
  emailVerificationEnabled?: boolean;
  /** Site policy enforcement mode when verification is on. */
  emailVerificationMode?: "nudge" | "block";
}

/**
 * Public site branding, fetched from /site (no auth required) on mount.
 * Drives the banner title, logo styling, BootSplash, AuthGate, and
 * `document.title`. Admin edits via /admin/settings refresh this.
 */
export interface SiteBranding {
  siteName: string;
  /**
   * Canonical site URL the banner logo links to. Empty string = no
   * wrapping (logo renders bare). The wrapper anchor is intentionally
   * unstyled, the logo still reads as a logo, not a chip; clicking
   * it just navigates.
   */
  siteUrl: string;
  bannerCoverCss: string | null;
  logoColor: string | null;
  logoFont: string | null;
  /**
   * URL for the banner/splash logo image. When set, the banner + splash
   * render this as an `<img>` in place of the `siteName` text. Empty
   * string = no logo, fall back to text title.
   */
  logoUrl: string;
  /** Master switch for /auth/register; surfaced so AuthGate can hide the tab. */
  registrationOpen: boolean;
  /** Sanitized welcome HTML rendered above the splash login form. */
  welcomeHtml: string;
  /** Sanitized disclaimer HTML rendered above the register form. */
  registerDisclaimerHtml: string;
  /**
   * Message retention window in ms; 0 means "kept indefinitely". Surfaced
   * here so the splash can tell visitors how long their messages will
   * persist before they commit to registering.
   */
  messageRetentionMs: number;
  /**
   * Session TTL in ms - how long a login persists before the user is
   * dropped back to the splash. Same surface rationale as retention.
   */
  sessionTtlMs: number;
  /**
   * Author-edit / author-delete grace window in ms for chat + DM
   * messages. Drives the per-message edit/delete control visibility
   * + the "Edit (within Xs)" tooltip copy. The server is the
   * authoritative gate; this value is just the soft client-side
   * mirror so the controls disappear at the right time.
   */
  editGraceMs: number;
  /**
   * Sitewide default theme - used by the splash so the login screen renders
   * in the admin-configured palette instead of inheriting whatever theme the
   * last logged-in user happened to leave on documentElement.
   */
  defaultTheme: Theme;
  /**
   * Raw JSON of `defaultTheme` from `site_settings.default_theme_json`, or
   * null when the admin hasn't set one. The splash distinguishes
   * "explicit admin default" (use it verbatim) from "no default at all"
   * (free to honor system prefers-color-scheme + pick Parchment or
   * Darkness automatically). Without this flag the splash can't tell
   * a real admin pick from the built-in DEFAULT_THEME fallback.
   */
  defaultThemeJson: string | null;
  /**
   * Master toggle for surfacing live community activity. When false the
   * splash hides its user/room counters (cold-start posture so the site
   * doesn't telegraph "dead community" to first visitors).
   */
  activityFeedsEnabled: boolean;
  /**
   * Splash featured-worlds carousel toggle. When true, the splash fetches a
   * randomized slice of open worlds from /worlds/featured and renders them
   * as a small browse strip below the welcome card.
   */
  featuredWorldsEnabled: boolean;
  /**
   * Splash stat: surface the rolling 24h chat message count.
   * Independent of `activityFeedsEnabled`, each toggle gates its own
   * section of the splash stats row, so admins can show the message
   * count alone (just chat volume), the online/room cluster alone,
   * or both together. When both are on, the splash renders them in
   * the same "·"-separated row so the cluster still reads as one beat.
   */
  splashMessages24hEnabled: boolean;
  /** Visual bio Designer (GrapesJS) availability. When on, the profile editor's
   *  bio tab offers a Designer/Source toggle (desktop only). Off by default. */
  profileDesignerEnabled: boolean;
  /**
   * Site-wide default theme style. Orthogonal to `defaultTheme` (palette).
   * Users without a per-user override (Profile.styleKey === null) inherit
   * this. Possible values come from the client-side style registry in
   * `lib/ornaments` ('medieval', 'modern', 'scifi'); unknown values fall
   * back to 'medieval'.
   */
  defaultStyleKey: string;
  /**
   * Master toggle for the Multi-Server Lift. When false (the default and
   * the only value any existing deploy ships with) the Server Rail never
   * renders and the chat shell is byte-identical to today; the `/servers`
   * routes 404 like any disabled feature. Optional so the `/site` payload
   * and cached branding from a pre-servers build hydrate cleanly to
   * "off". Flipped on by an admin once servers are ready to surface.
   */
  serversEnabled?: boolean;
  /**
   * Admin-configured per-preset design map. Keys are THEME_PRESETS names
   * (Parchment, Twilight, …); values are design keys (medieval/modern/
   * scifi). When the user's active palette matches a preset, this map
   * supplies the default design for them. Resolution order is
   * character.styleKey > master.styleKey > themeDesignMap[<preset>] >
   * defaultStyleKey > "medieval". Empty object = no pinning.
   */
  themeDesignMap: Record<string, string>;
}

export const DEFAULT_BRANDING: SiteBranding = {
  siteName: "The Spire",
  // Empty by default, no logo link wrapping. Admins set this via the
  // Branding tab; real value arrives on first /site fetch.
  siteUrl: "",
  bannerCoverCss: null,
  logoColor: null,
  logoFont: null,
  // Bundled default. Real value (possibly an `/uploads/...` path) arrives
  // via /site on first paint. Empty string would mean the admin cleared it.
  logoUrl: "/thespire-logo.png",
  registrationOpen: true,
  welcomeHtml: "",
  registerDisclaimerHtml: "",
  // Mirrors the schema defaults: retention disabled (0 = forever), session
  // TTL 30 days. Real values are pushed in by /site on first paint.
  messageRetentionMs: 0,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  // 5 minutes, mirrors the server migration default. Real value
  // arrives via /site on first paint.
  editGraceMs: 5 * 60 * 1000,
  defaultTheme: DEFAULT_THEME,
  // Null = no admin override; splash is free to pick light/dark
  // automatically based on system preference + the last-active cache.
  defaultThemeJson: null,
  // Off by default. Admin flips it on once there are real users to surface.
  activityFeedsEnabled: false,
  // Off by default. Admin flips it on after deciding the seeded worlds are
  // representative or after seeding the catalog with their own.
  featuredWorldsEnabled: false,
  // Off by default. Admin opt-in once they're sure their 24h volume reads
  // as healthy. Independent of `activityFeedsEnabled`, each toggle gates
  // its own splash section.
  splashMessages24hEnabled: false,
  // ON by default so the bio Designer reliably shows on desktop without
  // depending on a server round-trip; admins can turn it OFF in settings.
  profileDesignerEnabled: true,
  // Flagship style. Site admins can change this to any registered style
  // key ('medieval', 'modern', 'scifi'); unknown keys fall back to this
  // value at render time.
  defaultStyleKey: "medieval",
  // Off by default — the chat shell stays exactly as it is today until an
  // admin turns the Multi-Server Lift on.
  serversEnabled: false,
  // Empty by default, every theme falls straight through to
  // defaultStyleKey. Admins seed pinned designs via the migration and
  // can edit them in the admin settings UI.
  themeDesignMap: {},
};

const BRANDING_CACHE_KEY = "tk:branding:v1";

/**
 * Read the most recent branding from localStorage so the BootSplash and
 * AuthGate render with the right name on first paint, before /site replies.
 * On a fresh install (no cache), falls back to DEFAULT_BRANDING.
 *
 * Defensive: any parse error returns the default. Never throws.
 */
export function loadCachedBranding(): SiteBranding {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_BRANDING;
    const raw = localStorage.getItem(BRANDING_CACHE_KEY);
    if (!raw) return DEFAULT_BRANDING;
    const parsed = JSON.parse(raw) as Partial<SiteBranding>;
    return {
      siteName: typeof parsed.siteName === "string" ? parsed.siteName : DEFAULT_BRANDING.siteName,
      siteUrl: typeof parsed.siteUrl === "string" ? parsed.siteUrl : DEFAULT_BRANDING.siteUrl,
      bannerCoverCss: typeof parsed.bannerCoverCss === "string" || parsed.bannerCoverCss === null
        ? parsed.bannerCoverCss
        : null,
      logoColor: typeof parsed.logoColor === "string" || parsed.logoColor === null
        ? parsed.logoColor
        : null,
      logoFont: typeof parsed.logoFont === "string" || parsed.logoFont === null
        ? parsed.logoFont
        : null,
      logoUrl: typeof parsed.logoUrl === "string"
        ? parsed.logoUrl
        : DEFAULT_BRANDING.logoUrl,
      registrationOpen: typeof parsed.registrationOpen === "boolean"
        ? parsed.registrationOpen
        : DEFAULT_BRANDING.registrationOpen,
      welcomeHtml: typeof parsed.welcomeHtml === "string"
        ? parsed.welcomeHtml
        : DEFAULT_BRANDING.welcomeHtml,
      registerDisclaimerHtml: typeof parsed.registerDisclaimerHtml === "string"
        ? parsed.registerDisclaimerHtml
        : DEFAULT_BRANDING.registerDisclaimerHtml,
      messageRetentionMs: typeof parsed.messageRetentionMs === "number" && parsed.messageRetentionMs >= 0
        ? parsed.messageRetentionMs
        : DEFAULT_BRANDING.messageRetentionMs,
      sessionTtlMs: typeof parsed.sessionTtlMs === "number" && parsed.sessionTtlMs > 0
        ? parsed.sessionTtlMs
        : DEFAULT_BRANDING.sessionTtlMs,
      editGraceMs: typeof parsed.editGraceMs === "number" && parsed.editGraceMs >= 0
        ? parsed.editGraceMs
        : DEFAULT_BRANDING.editGraceMs,
      // Theme is structured; fall through to DEFAULT_THEME if the cached
      // payload is malformed instead of letting a partial value slip in.
      defaultTheme: parsed.defaultTheme && typeof parsed.defaultTheme === "object"
        ? { ...DEFAULT_BRANDING.defaultTheme, ...parsed.defaultTheme }
        : DEFAULT_BRANDING.defaultTheme,
      defaultThemeJson: typeof parsed.defaultThemeJson === "string" || parsed.defaultThemeJson === null
        ? parsed.defaultThemeJson
        : DEFAULT_BRANDING.defaultThemeJson,
      activityFeedsEnabled: typeof parsed.activityFeedsEnabled === "boolean"
        ? parsed.activityFeedsEnabled
        : DEFAULT_BRANDING.activityFeedsEnabled,
      featuredWorldsEnabled: typeof parsed.featuredWorldsEnabled === "boolean"
        ? parsed.featuredWorldsEnabled
        : DEFAULT_BRANDING.featuredWorldsEnabled,
      splashMessages24hEnabled: typeof parsed.splashMessages24hEnabled === "boolean"
        ? parsed.splashMessages24hEnabled
        : DEFAULT_BRANDING.splashMessages24hEnabled,
      profileDesignerEnabled: typeof parsed.profileDesignerEnabled === "boolean"
        ? parsed.profileDesignerEnabled
        : DEFAULT_BRANDING.profileDesignerEnabled,
      defaultStyleKey: typeof parsed.defaultStyleKey === "string" && parsed.defaultStyleKey.length > 0
        ? parsed.defaultStyleKey
        : DEFAULT_BRANDING.defaultStyleKey,
      serversEnabled: typeof parsed.serversEnabled === "boolean"
        ? parsed.serversEnabled
        : DEFAULT_BRANDING.serversEnabled ?? false,
      themeDesignMap: sanitizeThemeDesignMap(parsed.themeDesignMap),
    };
  } catch {
    return DEFAULT_BRANDING;
  }
}

/**
 * Defensive coercion for `themeDesignMap` coming from the cache or the
 * `/site` payload. Drops anything that isn't `Record<string, string>`,
 * since the column is admin-editable and a malformed entry would crash
 * the style resolver. Empty object is a valid value (meaning "no
 * pinning, fall through to defaultStyleKey").
 */
export function sanitizeThemeDesignMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

export function saveCachedBranding(b: SiteBranding): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(b));
  } catch { /* quota or privacy mode - silently skip */ }
}

/**
 * Cache the user's most recently *resolved* active theme (palette
 * after all character / master / branding fallbacks). The splash
 * reads this on a fresh tab, before /auth/me has resolved, so a
 * brief sign-out doesn't bounce a user who chose Darkness through a
 * flash of the Parchment splash. localStorage (not sessionStorage)
 * so the value survives a tab close + reopen: the user's *theme
 * preference* is account-global, not tab-local (unlike character
 * identity and current room, which use sessionStorage).
 *
 * Stored as the JSON-serialized Theme object so a custom palette
 * survives too, not just preset names.
 */
// Bumped to v2 after the gated-write fix: v1 caches captured the
// light DEFAULT_THEME fallback that the activeTheme effect emitted
// while the splash was visible (me === null). Reading a v1 cache
// would land the splash on the wrong palette even for users whose
// real last-active theme was dark. Bumping the key makes existing
// v1 entries inert so every client falls through to
// prefers-color-scheme on the next splash visit; the cache will
// re-populate cleanly the first time the user signs in.
const LAST_ACTIVE_THEME_KEY = "tk:lastActiveTheme:v2";

export function saveCachedActiveTheme(theme: Theme): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(LAST_ACTIVE_THEME_KEY, JSON.stringify(theme));
  } catch { /* private-mode, splash will fall back to prefers-color-scheme */ }
}

export function loadCachedActiveTheme(): Theme | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(LAST_ACTIVE_THEME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    // Use the same `normalizeTheme` shape-fill guard as the branding
    // cache: a partial / corrupt entry shouldn't render with missing
    // slots; the fallback fills in the default values.
    return { ...DEFAULT_THEME, ...parsed } as Theme;
  } catch {
    return null;
  }
}

export function clearCachedActiveTheme(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(LAST_ACTIVE_THEME_KEY);
  } catch { /* swallow */ }
}

/**
 * Local-only UI prefs that aren't worth a round-trip to the server.
 * Persisted to localStorage so a tab reload (or a post-deploy bundle
 * pickup) doesn't wipe the user's customizations. Each key is small
 * and read-only outside the matching setter, so no schema or
 * migration concerns.
 */
const FONT_STEP_KEY = "tk:fontStep:v1";

function loadFontStep(): 0 | 1 | 2 | 3 {
  try {
    if (typeof localStorage === "undefined") return 1;
    const raw = localStorage.getItem(FONT_STEP_KEY);
    if (raw === null) return 1;
    const n = parseInt(raw, 10);
    return n === 0 || n === 1 || n === 2 || n === 3 ? n : 1;
  } catch {
    return 1;
  }
}

function saveFontStep(n: 0 | 1 | 2 | 3): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(FONT_STEP_KEY, String(n));
  } catch { /* quota or privacy mode - silently skip */ }
}

// Monotonic key source for ephemeral theater reactions. A plain counter
// (not Date.now) guarantees uniqueness even for reactions that land in
// the same millisecond, which is the React list-key invariant the float
// animation relies on.
let theaterReactionSeq = 0;
function nextTheaterReactionId(): number {
  theaterReactionSeq += 1;
  return theaterReactionSeq;
}

interface ChatState {
  me: AuthMe | null;
  setMe: (me: AuthMe | null) => void;
  /** False until the initial /auth/me probe resolves. Prevents AuthGate flicker on reload. */
  authChecked: boolean;
  setAuthChecked: (b: boolean) => void;
  /**
   * Reason the user was bounced back to the splash, if any. Set by the
   * `auth:expired` socket handler / 401 backstop poll, cleared when the
   * splash is dismissed (successful login). Drives a banner on AuthGate
   * so users don't wonder why they're staring at the login form again.
   */
  kickReason: string | null;
  setKickReason: (r: string | null) => void;
  /**
   * Per-tab active character id. Mirrored here (separately from the
   * App.tsx local state) so any component or fetch can grab the
   * current identity without prop-drilling. Friend + DM endpoints
   * pass this as `?characterId=...` so the server scopes responses
   * to the right identity. Null means "OOC / master."
   */
  activeCharacterId: string | null;
  setActiveCharacterIdStore: (id: string | null) => void;
  /**
   * Server-reported version observed by the periodic /auth/me poll when
   * it differs from the build version this tab loaded. When set, the
   * chat shell shows a sticky "you're running an old copy" banner
   * with a Refresh button. Cleared on reload (the tab fetches the
   * fresh bundle and the comparison stops mismatching).
   */
  staleVersion: string | null;
  /**
   * Optional admin-authored release note attached to the current deploy
   * via `remote-deploy.sh --update-msg "..."`. Rendered alongside the
   * version drift on `StaleVersionBanner` so users get a hint of what
   * changed before they refresh. Null when the deploy didn't carry a
   * note (or when no drift has been detected yet).
   */
  staleUpdateMessage: string | null;
  setStaleVersion: (version: string | null, updateMessage?: string | null) => void;

  currentRoomId: string | null;
  setCurrentRoom: (id: string | null) => void;

  /**
   * Server (Multi-Server Lift) the CURRENT room belongs to. Derived state:
   * set ONLY from `room:state`'s `room.serverId` (via {@link setCurrentServerId})
   * so it can never drift from the room the viewer is actually in — the
   * Server Rail reads it to highlight the active server's icon, and the
   * `/rooms` fetch scopes to it (only when `branding.serversEnabled`). Null
   * means "not resolved yet" or the room predates server scoping; with the
   * flag off it stays null and nothing reads it. */
  currentServerId: string | null;
  /** The system/default server's id, learned from the catalog. Lets the rail
   *  mark the home server and lets the shell fall back to it. Null until the
   *  catalog loads (or the feature is off). */
  defaultServerId: string | null;
  setCurrentServerId: (id: string | null) => void;
  setDefaultServerId: (id: string | null) => void;

  /**
   * Forum surface (catalog modal / public landing) currently overriding the
   * ROOT design — a design can't be subtree-scoped (its CSS keys off
   * `html[data-theme-style]`). The scoped-design hook publishes the forum's
   * palette + style here so App's authoritative theme effect re-asserts it
   * instead of clobbering it back to the viewer's own design (the cause of
   * the post-login "half forum / half my theme" mix). Null = no override. */
  scopedRootDesign: { theme: Theme; styleKey: string | null } | null;
  setScopedRootDesign: (d: { theme: Theme; styleKey: string | null } | null) => void;

  /** Equipped room-transition key for the CURRENT identity (active character
   *  or OOC). Null = instant switch. Loaded by App on identity change and
   *  updated when the user equips one in the shop; read by the room-switch
   *  hook to play the effect. */
  myActiveTransitionKey: string | null;
  setMyActiveTransitionKey: (key: string | null) => void;

  rooms: Record<string, RoomSummary>;
  occupants: Record<string, RoomOccupant[]>;
  messagesByRoom: Record<string, ChatMessage[]>;

  appendMessage: (msg: ChatMessage) => void;
  /** Replace an existing message in-place (used for edit/delete grace updates). */
  updateMessage: (msg: ChatMessage) => void;
  /** Merge a live poll:update (tallies / totalVoters / closedAt) into the
   *  matching poll message wherever it's cached — chat buffers AND forum
   *  topic buckets. The viewer's own `myVote` is preserved (the server
   *  broadcast is viewer-agnostic; the PollCard owns its own selection). */
  applyPollUpdate: (u: PollUpdate) => void;
  setMessages: (roomId: string, msgs: ChatMessage[]) => void;
  /** Drop a batch of messages by id from a room's buffer (the `/trash`
   *  bulk-delete purge). No-op when none of the ids are present. */
  removeMessages: (roomId: string, ids: string[]) => void;
  /** Drop EVERY buffered message authored by a user across all rooms. Used
   *  when a block lands live so the blocked user's lines vanish immediately
   *  instead of lingering until the next room load. */
  purgeUserMessages: (userId: string) => void;
  /**
   * Prepend an older window of messages onto the front of a room's
   * buffer. Used by the scroll-to-top infinite history loader; the
   * server returns a chronologically-ordered page strictly older than
   * the oldest message currently in the buffer, and we splice it on
   * with id-dedupe so an overlap (server reordered, race with a live
   * append) doesn't double-render any line.
   */
  prependMessages: (roomId: string, msgs: ChatMessage[]) => void;
  /**
   * Per-room "there are still older messages on the server" hint.
   * Seeded true when the room is joined (since the initial backlog
   * is capped at 50 and the user may have much more history), set
   * false when an older-history fetch returns `hasMore: false`, and
   * also false on rooms that don't make sense to paginate (cleared
   * by an admin /clear, freshly created, etc.).
   */
  roomHistoryHasMore: Record<string, boolean>;
  setRoomHistoryHasMore: (roomId: string, hasMore: boolean) => void;
  /**
   * Window the in-memory buffer back down to the newest `keep`
   * messages, dropping older rows from memory. Called by MessageList
   * only while the reader is parked at the bottom, so unbounded growth
   * from a long live session or repeated load-older doesn't pile up
   * thousands of off-screen placeholder rows + IntersectionObservers.
   * The dropped rows are still on the server and re-hydrate via the
   * scroll-up load-older fetch (keyed on the new oldest row's
   * createdAt), so `roomHistoryHasMore` is forced true on any trim,
   * there is now older content not resident in memory.
   */
  trimRoomToRecent: (roomId: string, keep: number) => void;

  /**
   * Paginated forum topics, keyed by roomId then by category key.
   * categoryKey is the threadCategoryId for a real category or
   * `"_uncat"` for the synthetic Uncategorized bucket.
   *
   * Why separate from `messagesByRoom`:
   *   - The forum view in nested-mode rooms shows topics ordered by
   *     `lastActivityAt DESC` and paginated 20-at-a-time via
   *     `GET /rooms/:id/topics`. The chat backlog (last 50 messages
   *     via room:join) is the wrong substrate, busy threads can
   *     push every topic out of the window, and we want explicit
   *     "Load older" navigation, not implicit "scroll up".
   *   - `messagesByRoom` is still the source of truth for REPLIES
   *     (the topic's live conversation). Both buffers update in
   *     parallel: new topic ⟶ here; new reply ⟶ messagesByRoom AND
   *     `bumpTopicActivity` here.
   *
   * `pending` holds topics arrived from other users while the user
   * was reading. We don't insert them inline (that would reflow what
   * they're reading); instead the renderer shows a "X new topics"
   * pill, and flushing the pill prepends them to `topics`.
   */
  forumTopicsByRoom: Record<string, Record<string, {
    topics: ChatMessage[];
    hasMore: boolean;
    loading: boolean;
    /** Topics from socket events waiting behind a "X new topics" pill. */
    pending: ChatMessage[];
    /** 1-indexed page the bucket is currently showing. Drives the
     *  pagination strip (Prev / 1 2 … N / Next). Defaults to 1 on
     *  bucket creation. */
    currentPage: number;
    /** Total pages in the non-sticky pool for this category. Used by
     *  the strip to decide how many page numbers to render and
     *  whether to disable Prev/Next. 1 when there are zero or fewer
     *  non-stickies than one page's worth. */
    totalPages: number;
    /** Total non-sticky topic count for this category. Surfaced in
     *  the pagination strip as "Page X of Y, N topics" for context. */
    totalCount: number;
    /** Page size the server actually used to compute totalPages.
     *  Mirrors `siteSettings.forumTopicsPerPage` for the common
     *  case; a request that overrode `perPage` reflects that here
     *  so the strip's math stays self-consistent. */
    perPage: number;
  }>>;
  /** Replace a category bucket entirely (used on first page load AND
   *  on every page-navigation click). Replaces topics + updates the
   *  pagination metadata in one shot. */
  setForumTopicsPage: (
    roomId: string,
    categoryKey: string,
    topics: ChatMessage[],
    pageInfo: { currentPage: number; totalPages: number; totalCount: number; perPage: number },
  ) => void;
  /** LEGACY append helper, preserved for the cursor-page path on
   *  the off chance an older surface still calls it. New surfaces
   *  use `setForumTopicsPage` only. */
  appendForumTopicsPage: (roomId: string, categoryKey: string, topics: ChatMessage[], hasMore: boolean) => void;
  /** Mark a bucket as in-flight (UI shows a spinner / disables the button). */
  setForumTopicsLoading: (roomId: string, categoryKey: string, loading: boolean) => void;
  /**
   * Bumped by MessageList's forum toolbar (pin/lock/delete) + edit-save
   * after a SUCCESSFUL mutation. In chat the socket `message:update` echo
   * repaints, so nothing subscribes; the Forums Catalog (whose viewer is
   * never in the board's socket room) subscribes and refetches its
   * buckets + active thread so those actions reflect immediately.
   */
  forumActionTick: number;
  bumpForumActionTick: () => void;
  /** Unread forum-notification count (replies to your topics, quotes,
   *  watched-topic activity). Seeded by a boot fetch, kept live by the
   *  `forum:notifications` socket pulse. Drives the rail + bell badges. */
  forumNotifUnread: number;
  setForumNotifUnread: (n: number) => void;
  /** Prepend a brand-new topic that the *viewer themselves* just created. Inserts directly, no pill. */
  prependOwnForumTopic: (roomId: string, categoryKey: string, topic: ChatMessage) => void;
  /** Queue a topic that arrived from another user behind the "new topics" pill. */
  queuePendingForumTopic: (roomId: string, categoryKey: string, topic: ChatMessage) => void;
  /** Flush pending → topics (user clicked the pill). */
  flushPendingForumTopics: (roomId: string, categoryKey: string) => void;
  /** Re-emit an existing topic with updated fields (edit/lock/unlock). Searches every bucket of the room. */
  updateForumTopic: (msg: ChatMessage) => void;
  /** Bump a topic's lastActivityAt + re-sort its bucket (called when a reply lands). */
  bumpTopicActivity: (roomId: string, topicId: string, lastActivityAt: number) => void;
  /** Drop a topic from every bucket of a room (called when a topic is soft-deleted). */
  removeForumTopic: (roomId: string, topicId: string) => void;
  setOccupants: (roomId: string, occ: RoomOccupant[]) => void;
  setRoom: (room: RoomSummary) => void;

  /**
   * Phase 4 typing indicator, who is currently typing in each
   * room, keyed by roomId. Server filters out the viewer and
   * anyone they've ignored before sending, so the renderer can
   * splat this directly into the indicator strip.
   *
   * Cleared wholesale on each `chat:typing:update`; the server is
   * authoritative on the set.
   */
  typersByRoom: Record<string, TypingEntry[]>;
  setTypers: (roomId: string, typers: TypingEntry[]) => void;

  /**
   * Live theater (watch-party) playback state per room, from the
   * `theater:sync` socket event. The TheaterPanel reads the entry for
   * the current room and extrapolates the live position from
   * `serverTimeMs`. Undefined until the room first reports state.
   */
  theaterSyncByRoom: Record<string, { roomId: string } & TheaterSync>;
  setTheaterSync: (sync: { roomId: string } & TheaterSync) => void;
  /**
   * Ephemeral floating reactions over the theater video. Appended on
   * each `theater:reaction` echo and consumed + dropped by the panel
   * once its float animation finishes. Capped so a room whose panel
   * isn't mounted can't accumulate unbounded.
   */
  theaterReactions: Array<{ id: number; roomId: string; emoji: string; side: "left" | "right"; displayName: string }>;
  pushTheaterReaction: (r: { roomId: string; emoji: string; side: "left" | "right"; displayName: string }) => void;
  dropTheaterReaction: (id: number) => void;

  notice: { code: string; message: string } | null;
  setNotice: (n: { code: string; message: string } | null) => void;

  openProfile: ProfileView | null;
  setOpenProfile: (p: ProfileView | null) => void;

  /** Request to open the Story reader for a story id, from anywhere (e.g. the
   *  Scriptorium rankings). App owns the actual reader state; it watches this,
   *  opens the reader, and clears it back to null. */
  openStoryReaderId: string | null;
  setOpenStoryReader: (storyId: string | null) => void;

  /**
   * Editor target - null means closed.
   * mode "master" → edits the master account (no characterId).
   * mode "character" → edits the character with that id.
   *
   * `adminContext` opens the editor in admin-act-on-other-user mode:
   * - Mounted from the admin Users tab (per-character Edit button).
   * - Skips `/me/profile` + `/characters` fetches (those return the
   *   CALLER's data, not the target user's).
   * - Loads the named character via `GET /characters/:id` (admin
   *   allowed), saves via `PUT /characters/:id` (admin allowed).
   * - Hides the master/character switcher, admin edits ONE
   *   character at a time. To edit a different one, close + reopen
   *   from the admin user row.
   * - Shows an "Editing as admin: X (owned by Y)" banner so the
   *   admin knows what they're touching.
   */
  editor:
    | {
        mode: "master" | "character";
        characterId: string | null;
        adminContext?: { ownerUserId: string; ownerUsername: string };
        /**
         * Optional tab the editor opens on. Used by deep-links from
         * surfaces that want the user to land on a specific tab,
         * e.g. the Earning shop's "Configure in Edit Profile → Flair"
         * pointer after buying a profile-customization flair lands on
         * "flair", and the Direct Messenger / Profile back-link could
         * land on "privacy". Omit for the default "description" tab.
         */
        initialTab?: "description" | "profile" | "appearance" | "privacy" | "links" | "gallery" | "flair" | "journal";
      }
    | null;
  openEditor: (target: {
    mode: "master" | "character";
    characterId: string | null;
    adminContext?: { ownerUserId: string; ownerUsername: string };
    initialTab?: "description" | "profile" | "appearance" | "privacy" | "links" | "gallery" | "flair" | "journal";
  }) => void;
  closeEditor: () => void;

  /** Local UI font-size step (cycled by the Size button). */
  fontStep: 0 | 1 | 2 | 3;
  setFontStep: (n: 0 | 1 | 2 | 3) => void;

  /** 0 = auto-refresh off; otherwise interval in seconds (5-3600). */
  refreshIntervalSec: number;
  setRefreshIntervalSec: (n: number) => void;

  /** Public site branding - see SiteBranding. */
  branding: SiteBranding;
  setBranding: (b: SiteBranding) => void;

  /**
   * Admin-configurable input length caps. Loaded from `/me/profile`
   * on first auth-ed bootstrap so any composer (chat, DM, forum
   * topic title, bio) can pull the live cap from a single source.
   * Defaults match the server's schema defaults; populated for real
   * once /me/profile lands.
   */
  inputLimits: {
    maxBioLength: number;
    maxMessageLength: number;
    maxDirectMessageLength: number;
    maxForumPostLength: number;
    maxForumTopicTitleLength: number;
  };
  setInputLimits: (l: ChatState["inputLimits"]) => void;

  /* =========================================================
   *  Direct messages (Phase 4)
   * ========================================================= */
  /**
   * Per-conversation message buffer. Keyed by conversationId. Each
   * list stays sorted oldest → newest; the store action handles
   * dedupe by id (server can fan a message to multiple sockets of
   * the same user). Trimmed lazily, the DmThread caps display at
   * its own rendering layer.
   */
  dmMessagesByConv: Record<string, DirectMessage[]>;
  /** Conversation summaries for the rail. Keyed by conversationId. */
  dmConversations: Record<string, DirectConversationSummary>;
  /**
   * The OTHER user id of the currently-open DM panel, or null when no
   * panel is open. We key on the user id rather than the conversation
   * id because the conversation row may not exist server-side until
   * the first message is sent, letting the panel mount with just an
   * otherUserId removes the "first-DM bootstrapping" footgun.
   *
   * The companion `openDmOtherCharacterId` is the *pinned* character
   * id on that thread; together they identify the conversation
   * uniquely. A master account with three characters can have four
   * concurrent threads (OOC + each character), so matching only on
   * userId would conflate them, that's the per-identity partition
   * leak the privacy model is built around.
   */
  openDmOtherUserId: string | null;
  openDmOtherCharacterId: string | null;
  /**
   * Pending friend requests received by the current user. Source of truth
   * is `/me/friend-requests`; the store mirror powers the in-chat prompt
   * card and the DM thread's bottom-pinned banner, so both surfaces stay
   * in sync without each having to refetch independently.
   */
  pendingFriendRequests: Array<{
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    /**
     * The friender's character id pinned to THIS request, or null
     * when the sender was on their master OOC handle. Required for
     * the accept/decline buttons to identify the exact row, resolving
     * by username alone is ambiguous because `resolveIdentityByName`
     * matches the master account first, so a request sent from a
     * character would never match and would loop forever in the
     * pending list.
     */
    frienderCharacterId: string | null;
    /**
     * My (receiver) character id at the time the request was fetched.
     * Echoed back by `/me/friend-requests` per entry so the
     * accept/decline buttons don't have to thread the per-fetch
     * identity through the UI separately.
     */
    friendedCharacterId: string | null;
    createdAt: number;
  }>;
  setPendingFriendRequests: (list: ChatState["pendingFriendRequests"]) => void;
  removePendingFriendRequest: (userId: string) => void;
  /** Local mirror of `users.dms_enabled`. Updated from /me/profile + the prefs PUT. */
  dmsEnabled: boolean;
  /**
   * Per-event in-app sound toggles. Mirrors the three boolean columns
   * on `users` (sound_dm_enabled, sound_chat_enabled, sound_alert_enabled).
   * Read by `lib/sound.ts` before every play() so a toggle in the
   * profile editor takes effect immediately, without an Audio reload.
   */
  soundPrefs: { dm: boolean; whisper: boolean; chat: boolean; alert: boolean };
  setSoundPrefs: (p: { dm: boolean; whisper: boolean; chat: boolean; alert: boolean }) => void;
  /**
   * Per-user input-behavior opt-outs. Mirrors two boolean columns on
   * `users` (disable_input_history, disable_thesaurus). Read by the
   * Composer + SynonymPopup so a profile-editor toggle takes effect
   * immediately, no reload needed. Both default to `false` (= feature
   * enabled) so a freshly mounted store before /me/profile lands
   * behaves identically to a user who has never touched the toggles.
   */
  inputPrefs: { disableHistory: boolean; disableThesaurus: boolean };
  setInputPrefs: (p: { disableHistory: boolean; disableThesaurus: boolean }) => void;
  /**
   * Viewer-side flair opt-outs. Mirrors three boolean columns on `users`
   * (disable_name_styles / disable_border_styles / disable_inline_avatars).
   * Read by StyledName, BorderedAvatar, and UserNameTag so the viewer can
   * turn OFF rendering of OTHER people's cosmetic flair for a smoother
   * experience on older hardware. All default `false` (= flair shown) so a
   * freshly mounted store, before /me/profile lands, renders normally.
   */
  flairPrefs: { disableNameStyles: boolean; disableBorderStyles: boolean; disableInlineAvatars: boolean };
  setFlairPrefs: (p: { disableNameStyles: boolean; disableBorderStyles: boolean; disableInlineAvatars: boolean }) => void;
  /**
   * The viewer's default forum id (mirrors `users.default_forum_id`). The
   * Forums catalog opens to it when launched without a deep-link; set from the
   * Forums toolbar star. Null = no preference. Synced via /me/profile.
   */
  defaultForumId: string | null;
  setDefaultForumId: (id: string | null) => void;
  /**
   * Counter bumped each time the socket (re)connects. Any open
   * ThreadPane watches this and re-runs its history seed when it
   * changes, that's the catch-up path for `dm:new` events the
   * client missed while disconnected (Socket.io drops `emit`s when
   * the recipient socket isn't connected; there's no replay).
   */
  dmReseedTick: number;

  /**
   * While the Messages modal is open, the character id its inbox is
   * currently filtered to (`null` = master / OOC). `undefined` when
   * the modal is closed.
   *
   * Why this exists: `dmConversations` holds only ONE identity's
   * threads at a time (every `/me/dms` fetch full-replaces the map).
   * The modal lets the user browse a DIFFERENT identity's inbox than
   * their global voice via the character-switcher chips, by design the
   * chip filter does NOT change `activeCharacterId`. The App-level DM
   * refetches (socket reconnect via `onConnect`, and the `dm:new`
   * unknown-conversation refetch) are scoped to the GLOBAL
   * `activeCharacterId`; if they fire while the modal is filtered to
   * another identity they replace the map with the global identity's
   * threads, wiping the open thread's conversation row. ThreadPane then
   * can't resolve the conversation and snaps back to its "start the
   * conversation" empty state, the messages appear to vanish and the
   * rail shows the wrong inbox. Mirroring the filter here lets those
   * refetches reload the SAME identity the user is looking at, falling
   * back to the global voice only when the modal is closed.
   */
  dmInboxFilterCharId: string | null | undefined;
  setDmInboxFilterCharId: (id: string | null | undefined) => void;

  setDmConversations: (list: DirectConversationSummary[]) => void;
  upsertDmConversation: (c: DirectConversationSummary) => void;
  setDmMessages: (conversationId: string, msgs: DirectMessage[]) => void;
  appendDmMessage: (msg: DirectMessage) => void;
  updateDmMessage: (msg: DirectMessage) => void;
  setOpenDmOtherUser: (otherUserId: string | null, otherCharacterId?: string | null) => void;
  setDmsEnabled: (enabled: boolean) => void;
  bumpDmReseed: () => void;

  /**
   * Bumped when the server broadcasts `commands:updated` after an
   * admin edits a custom command. Both the Composer's autocomplete
   * cache and the HelpModal key their `/commands` fetch on this so a
   * new/renamed/removed command surfaces without forcing users to
   * reload their tab.
   */
  commandsVersion: number;
  bumpCommandsVersion: () => void;
  /**
   * Monotonic counter the App-level `friend:request` socket listener
   * bumps on every echo (new request, accept, decline, unfriend).
   * MessagesModal keys its refreshLists effect on this so the
   * friends list / DM conversations / pending inbox re-poll
   * whenever friend state changes elsewhere, without this, accepting
   * a request only refreshed the acceptor's own modal (via its local
   * refreshKey bump in `acceptRequest`); the other party's modal
   * showed the stale list until they closed and reopened the modal
   * or hit a full page refresh.
   */
  friendsVersion: number;
  bumpFriendsVersion: () => void;
  /**
   * Monotonic counter for "the per-identity DM unread counts may
   * have changed." Bumped:
   *   - by ThreadPane after the `/me/dms/:id/read` POST resolves
   *     (the server-side read marker write happens BEFORE the
   *     response, so any refetch fired after this point sees the
   *     fresh unread count instead of the stale one)
   *   - by the App-level `dm:read` socket listener when the echo
   *     comes back to OUR own sockets, so sibling tabs of the
   *     same user refresh their chip badges too
   * MessagesModal's `inboxCounts` effect keys on this to refetch
   * `/me/inbox-counts`. Without it, the per-character chip pip
   * stayed stale after opening a conversation because the local
   * optimistic `unreadCount: 0` raced ahead of the server-side
   * read-marker write.
   */
  inboxCountsVersion: number;
  bumpInboxCountsVersion: () => void;
  /**
   * Per-identity unread DM + pending-friend-request counts, keyed on
   * characterId (`null` = master / OOC). Hoisted from
   * MessagesModal's local state into the store so the chat-shell ✉
   * badge can sum unread across ALL of the user's identities,
   * `dmConversations` only holds the currently-active identity's
   * threads, so a DM that lands on Char B while the viewer is on
   * Char A would otherwise leave the badge at zero with no signal
   * to the recipient that a message arrived for one of their other
   * identities. Refreshed by {@link refreshInboxCounts} on every
   * `dm:new` / `dm:read` / `friend:request` socket echo so the
   * badge stays current without the messenger having to be open.
   */
  inboxCountsByIdentity: Map<string | null, import("@thekeep/shared").InboxIdentityCount>;
  /** Best-effort fetch of `/me/inbox-counts` that overwrites
   *  {@link inboxCountsByIdentity}. Silent on failure, counts are
   *  non-critical and stale data is preferable to a thrown error.
   *  Cheap (one indexed SQL query); safe to call after every
   *  inbound DM event. */
  refreshInboxCounts: () => Promise<void>;
}

/**
 * Sort comparator for forum-topic buckets. The invariant the store
 * maintains across every mutation:
 *   1. Stickies first (admin-pinned), within stickies by lastActivityAt DESC.
 *   2. Then non-stickies, by lastActivityAt DESC.
 * `createdAt` is the fallback when lastActivityAt is somehow absent
 * (shouldn't happen on data from the topics endpoint, but defensive).
 */
function compareTopicsForBucket(a: ChatMessage, b: ChatMessage): number {
  const aSticky = a.isSticky ? 1 : 0;
  const bSticky = b.isSticky ? 1 : 0;
  if (aSticky !== bSticky) return bSticky - aSticky;
  return (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt);
}

/** Default empty-bucket shape, used by every action that may run
 *  against a category the loader hasn't filled yet (a live topic
 *  socket arriving for an as-yet-unseen category, a defensive
 *  fallback in setLoading, etc.). Page metadata defaults to a 1-page
 *  empty bucket; the first real `setForumTopicsPage` call overwrites
 *  it with server-derived totals. `perPage: 20` mirrors the prior
 *  hardcoded fallback so back-of-envelope math reads consistently
 *  even before the first fetch completes. */
function emptyBucket(): {
  topics: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  pending: ChatMessage[];
  currentPage: number;
  totalPages: number;
  totalCount: number;
  perPage: number;
} {
  return {
    topics: [],
    hasMore: false,
    loading: false,
    pending: [],
    currentPage: 1,
    totalPages: 1,
    totalCount: 0,
    perPage: 20,
  };
}

export const useChat = create<ChatState>((set) => ({
  me: null,
  setMe: (me) => set({ me }),
  authChecked: false,
  setAuthChecked: (b) => set({ authChecked: b }),
  kickReason: null,
  setKickReason: (r) => set({ kickReason: r }),
  staleVersion: null,
  staleUpdateMessage: null,
  setStaleVersion: (version, updateMessage) => set({
    staleVersion: version,
    // When the version itself is cleared (e.g. after a refresh tears
    // the store down), drop any leftover release note too. When the
    // caller omits the second arg, leave the existing note in place,
    // not all callsites have the message handy, and we don't want a
    // re-set of the same version to wipe an already-rendered note.
    ...(version === null
      ? { staleUpdateMessage: null }
      : updateMessage !== undefined
        ? { staleUpdateMessage: updateMessage }
        : {}),
  }),
  activeCharacterId: null,
  setActiveCharacterIdStore: (id) => set({ activeCharacterId: id }),

  currentRoomId: null,
  setCurrentRoom: (id) => set({ currentRoomId: id }),

  currentServerId: null,
  defaultServerId: null,
  setCurrentServerId: (id) => set({ currentServerId: id }),
  setDefaultServerId: (id) => set({ defaultServerId: id }),

  scopedRootDesign: null,
  setScopedRootDesign: (d) => set({ scopedRootDesign: d }),

  myActiveTransitionKey: null,
  setMyActiveTransitionKey: (key) => set({ myActiveTransitionKey: key }),

  rooms: {},
  occupants: {},
  typersByRoom: {},
  messagesByRoom: {},

  appendMessage: (msg) =>
    set((s) => {
      const list = s.messagesByRoom[msg.roomId] ?? [];
      // Idempotent on duplicate id. The server may deliver the same
      // message via two paths (room broadcast + explicit sender emit, or
      // a reconnect-replay landing on top of a live append), appending
      // again would render the line twice. Cheap O(n) tail scan since
      // duplicates almost always arrive within a handful of entries of
      // the canonical insertion.
      for (let i = list.length - 1; i >= 0 && i >= list.length - 16; i--) {
        if (list[i]!.id === msg.id) return {};
      }
      return {
        messagesByRoom: { ...s.messagesByRoom, [msg.roomId]: [...list, msg] },
      };
    }),

  updateMessage: (msg) =>
    set((s) => {
      // Fast path: the update's roomId matches the bucket we cached it
      // in. True for every non-whisper message and for whispers between
      // people in the same room.
      const list = s.messagesByRoom[msg.roomId];
      if (list) {
        const idx = list.findIndex((m) => m.id === msg.id);
        if (idx >= 0) {
          const next = list.slice();
          next[idx] = { ...msg, roomId: msg.roomId };
          return { messagesByRoom: { ...s.messagesByRoom, [msg.roomId]: next } };
        }
      }
      // Slow path: cross-room whisper overlay. The server broadcasts the
      // update keyed to the sender's room, but the recipient cached the
      // message under whichever room they were viewing when it arrived.
      // Scan every bucket so the edit/delete lands regardless of which
      // view holds the row. Bucket roomId on the cached copy is
      // preserved, only the body / editedAt / deletedAt etc. change.
      let touched = false;
      const nextByRoom: Record<string, ChatMessage[]> = {};
      for (const rid of Object.keys(s.messagesByRoom)) {
        const buf = s.messagesByRoom[rid];
        if (!buf) continue;
        const idx = buf.findIndex((m) => m.id === msg.id);
        if (idx < 0) { nextByRoom[rid] = buf; continue; }
        const next = buf.slice();
        next[idx] = { ...msg, roomId: rid };
        nextByRoom[rid] = next;
        touched = true;
      }
      if (!touched) return {};
      return { messagesByRoom: nextByRoom };
    }),

  applyPollUpdate: (u) =>
    set((s) => {
      const merge = (m: ChatMessage): ChatMessage =>
        m.id === u.messageId && m.poll
          ? { ...m, poll: { ...m.poll, tallies: u.tallies, totalVoters: u.totalVoters, closedAt: u.closedAt } }
          : m;

      // Chat buffers.
      let msgTouched = false;
      const nextByRoom: Record<string, ChatMessage[]> = {};
      for (const rid of Object.keys(s.messagesByRoom)) {
        const buf = s.messagesByRoom[rid];
        if (!buf) continue;
        const idx = buf.findIndex((m) => m.id === u.messageId);
        if (idx < 0) { nextByRoom[rid] = buf; continue; }
        const next = buf.slice();
        next[idx] = merge(buf[idx]!);
        nextByRoom[rid] = next;
        msgTouched = true;
      }

      // Forum topic buckets (the poll topic lives here in forum mode).
      let topicTouched = false;
      const nextForum: typeof s.forumTopicsByRoom = {};
      for (const rid of Object.keys(s.forumTopicsByRoom)) {
        const room = s.forumTopicsByRoom[rid];
        if (!room) continue;
        const nextRoom: typeof room = {};
        let roomTouched = false;
        for (const cat of Object.keys(room)) {
          const bucket = room[cat]!;
          const topics = bucket.topics.map(merge);
          const pending = bucket.pending.map(merge);
          const changed =
            topics.some((t, i) => t !== bucket.topics[i]) ||
            pending.some((t, i) => t !== bucket.pending[i]);
          if (changed) { nextRoom[cat] = { ...bucket, topics, pending }; roomTouched = true; topicTouched = true; }
          else nextRoom[cat] = bucket;
        }
        nextForum[rid] = roomTouched ? nextRoom : room;
      }

      if (!msgTouched && !topicTouched) return {};
      return {
        ...(msgTouched ? { messagesByRoom: nextByRoom } : {}),
        ...(topicTouched ? { forumTopicsByRoom: nextForum } : {}),
      };
    }),

  setMessages: (roomId, msgs) =>
    set((s) => ({ messagesByRoom: { ...s.messagesByRoom, [roomId]: msgs } })),

  removeMessages: (roomId, ids) =>
    set((s) => {
      const list = s.messagesByRoom[roomId];
      if (!list || ids.length === 0) return {};
      const drop = new Set(ids);
      const next = list.filter((m) => !drop.has(m.id));
      if (next.length === list.length) return {};
      return { messagesByRoom: { ...s.messagesByRoom, [roomId]: next } };
    }),

  purgeUserMessages: (userId) =>
    set((s) => {
      let touched = false;
      const nextByRoom: Record<string, ChatMessage[]> = {};
      for (const rid of Object.keys(s.messagesByRoom)) {
        const buf = s.messagesByRoom[rid];
        if (!buf) continue;
        // Drop lines the blocked user authored AND whispers addressed to
        // them (so a whisper the viewer sent to a now-blocked user clears too).
        const next = buf.filter((m) => m.userId !== userId && m.toUserId !== userId);
        if (next.length !== buf.length) touched = true;
        nextByRoom[rid] = next;
      }
      return touched ? { messagesByRoom: nextByRoom } : {};
    }),

  prependMessages: (roomId, older) =>
    set((s) => {
      if (older.length === 0) return {};
      const current = s.messagesByRoom[roomId] ?? [];
      // Dedupe by id, a live `message:new` may have landed within the
      // window we just fetched (race between socket and HTTP), and the
      // server-returned page is the authoritative ordering up to the
      // boundary so the live row stays put.
      const seen = new Set(current.map((m) => m.id));
      const extras = older.filter((m) => !seen.has(m.id));
      if (extras.length === 0) return {};
      return {
        messagesByRoom: { ...s.messagesByRoom, [roomId]: [...extras, ...current] },
      };
    }),

  roomHistoryHasMore: {},
  setRoomHistoryHasMore: (roomId, hasMore) =>
    set((s) => ({ roomHistoryHasMore: { ...s.roomHistoryHasMore, [roomId]: hasMore } })),
  trimRoomToRecent: (roomId, keep) =>
    set((s) => {
      const list = s.messagesByRoom[roomId];
      if (!list || list.length <= keep) return {};
      const next = list.slice(list.length - keep);
      return {
        messagesByRoom: { ...s.messagesByRoom, [roomId]: next },
        // We dropped older rows from memory; they still exist server-
        // side, so re-enable "load older" regardless of its prior value
        // (we may have been at the genuine start of history before the
        // trim). The scroll-up fetch re-hydrates them on demand.
        roomHistoryHasMore: { ...s.roomHistoryHasMore, [roomId]: true },
      };
    }),

  forumTopicsByRoom: {},
  forumActionTick: 0,
  bumpForumActionTick: () => set((s) => ({ forumActionTick: s.forumActionTick + 1 })),
  forumNotifUnread: 0,
  setForumNotifUnread: (n) => set({ forumNotifUnread: n }),

  setForumTopicsPage: (roomId, categoryKey, topics, pageInfo) =>
    set((s) => {
      const room = s.forumTopicsByRoom[roomId] ?? {};
      const prev = room[categoryKey];
      return {
        forumTopicsByRoom: {
          ...s.forumTopicsByRoom,
          [roomId]: {
            ...room,
            [categoryKey]: {
              topics,
              // `hasMore` is the legacy boolean; we keep it set from
              // page < totalPages so any old code path that still
              // reads it (the cursor-mode fallback) doesn't break.
              hasMore: pageInfo.currentPage < pageInfo.totalPages,
              loading: false,
              // Preserve pending across a page swap, a topic queued
              // behind the pill is still "new" relative to what the
              // user has seen. Pending only flushes onto page 1, but
              // we don't clear it when the user navigates AWAY from
              // page 1 because they'll come back.
              pending: prev?.pending ?? [],
              currentPage: pageInfo.currentPage,
              totalPages: pageInfo.totalPages,
              totalCount: pageInfo.totalCount,
              perPage: pageInfo.perPage,
            },
          },
        },
      };
    }),

  appendForumTopicsPage: (roomId, categoryKey, topics, hasMore) =>
    set((s) => {
      const room = s.forumTopicsByRoom[roomId] ?? {};
      const prev = room[categoryKey];
      if (!prev) {
        // Defensive: append on an empty bucket behaves like setPage
        // with a stub pagination block, we don't know totalPages
        // from a legacy append path, so we use a 1-page assumption
        // and let the next clean fetch correct it.
        return {
          forumTopicsByRoom: {
            ...s.forumTopicsByRoom,
            [roomId]: {
              ...room,
              [categoryKey]: {
                topics,
                hasMore,
                loading: false,
                pending: [],
                currentPage: 1,
                totalPages: hasMore ? 2 : 1,
                totalCount: topics.length,
                perPage: topics.length || 20,
              },
            },
          },
        };
      }
      // De-dup by id: a topic could already be in the bucket if a live
      // event slipped in between the page boundary and this append.
      const seen = new Set(prev.topics.map((t) => t.id));
      const extra = topics.filter((t) => !seen.has(t.id));
      return {
        forumTopicsByRoom: {
          ...s.forumTopicsByRoom,
          [roomId]: {
            ...room,
            [categoryKey]: {
              ...prev,
              topics: [...prev.topics, ...extra],
              hasMore,
              loading: false,
            },
          },
        },
      };
    }),

  setForumTopicsLoading: (roomId, categoryKey, loading) =>
    set((s) => {
      const room = s.forumTopicsByRoom[roomId] ?? {};
      const prev = room[categoryKey] ?? emptyBucket();
      return {
        forumTopicsByRoom: {
          ...s.forumTopicsByRoom,
          [roomId]: { ...room, [categoryKey]: { ...prev, loading } },
        },
      };
    }),

  prependOwnForumTopic: (roomId, categoryKey, topic) =>
    set((s) => {
      const room = s.forumTopicsByRoom[roomId] ?? {};
      const prev = room[categoryKey] ?? emptyBucket();
      // Don't double-insert if the topic is already at the head.
      if (prev.topics.some((t) => t.id === topic.id)) return {};
      return {
        forumTopicsByRoom: {
          ...s.forumTopicsByRoom,
          [roomId]: {
            ...room,
            [categoryKey]: {
              ...prev,
              topics: [topic, ...prev.topics],
              // A brand-new topic bumps the total non-sticky count
              // and may push the last page over the perPage boundary.
              totalCount: prev.totalCount + 1,
              totalPages: Math.max(1, Math.ceil((prev.totalCount + 1) / prev.perPage)),
            },
          },
        },
      };
    }),

  queuePendingForumTopic: (roomId, categoryKey, topic) =>
    set((s) => {
      const room = s.forumTopicsByRoom[roomId] ?? {};
      const prev = room[categoryKey] ?? emptyBucket();
      // De-dup: ignore if already pending OR already visible (the
      // user might have just flushed and this is a late echo).
      if (prev.pending.some((t) => t.id === topic.id)) return {};
      if (prev.topics.some((t) => t.id === topic.id)) return {};
      return {
        forumTopicsByRoom: {
          ...s.forumTopicsByRoom,
          [roomId]: {
            ...room,
            [categoryKey]: { ...prev, pending: [topic, ...prev.pending] },
          },
        },
      };
    }),

  flushPendingForumTopics: (roomId, categoryKey) =>
    set((s) => {
      const room = s.forumTopicsByRoom[roomId];
      const prev = room?.[categoryKey];
      if (!prev || prev.pending.length === 0) return {};
      return {
        forumTopicsByRoom: {
          ...s.forumTopicsByRoom,
          [roomId]: {
            ...room,
            [categoryKey]: {
              ...prev,
              topics: [...prev.pending, ...prev.topics],
              pending: [],
            },
          },
        },
      };
    }),

  updateForumTopic: (msg) =>
    set((s) => {
      const room = s.forumTopicsByRoom[msg.roomId];
      if (!room) return {};
      // The bucket the topic now belongs in, by its (possibly changed)
      // category. A category move lands the topic in a different bucket
      // than the one currently holding it, so we may have to pull it out
      // of its old bucket and drop it into the target bucket.
      const targetKey = msg.threadCategoryId ?? "_uncat";
      let touched = false;
      let foundIn: string | null = null;
      const nextRoom: typeof room = {};
      for (const [key, bucket] of Object.entries(room)) {
        const idx = bucket.topics.findIndex((t) => t.id === msg.id);
        if (idx < 0) {
          nextRoom[key] = bucket;
          continue;
        }
        foundIn = key;
        if (key === targetKey) {
          // Same bucket: update in place + re-sort (handles a sticky
          // toggle lifting/dropping the row; idempotent for lock/edit).
          const next = bucket.topics.slice();
          next[idx] = msg;
          next.sort(compareTopicsForBucket);
          nextRoom[key] = { ...bucket, topics: next };
        } else {
          // Moved out of this bucket: drop the row here; the target
          // bucket is handled below.
          const next = bucket.topics.slice();
          next.splice(idx, 1);
          nextRoom[key] = { ...bucket, topics: next };
        }
        touched = true;
      }
      // If the topic moved to a category whose bucket is loaded but
      // didn't already contain it, insert + re-sort there. (If the
      // target bucket isn't loaded we just drop the stale copy; the
      // bucket will fetch the topic fresh when it loads.)
      if (foundIn && foundIn !== targetKey) {
        const target = nextRoom[targetKey];
        if (target) {
          const next = [...target.topics, msg];
          next.sort(compareTopicsForBucket);
          nextRoom[targetKey] = { ...target, topics: next };
        }
      }
      if (!touched) return {};
      return { forumTopicsByRoom: { ...s.forumTopicsByRoom, [msg.roomId]: nextRoom } };
    }),

  bumpTopicActivity: (roomId, topicId, lastActivityAt) =>
    set((s) => {
      const room = s.forumTopicsByRoom[roomId];
      if (!room) return {};
      // Find which bucket holds the topic, mutate its lastActivityAt,
      // and re-sort that bucket so the bucket-wide invariant holds:
      //   1. stickies first (isSticky=true), ordered by lastActivityAt DESC
      //   2. then non-stickies, ordered by lastActivityAt DESC
      // A full sort is cheap at typical bucket sizes (≤ a few hundred
      // topics after several Load-Older clicks) and trivially handles
      // edge cases like a sticky receiving a reply.
      let touchedKey: string | null = null;
      const nextRoom: typeof room = {};
      for (const [key, bucket] of Object.entries(room)) {
        const idx = bucket.topics.findIndex((t) => t.id === topicId);
        if (idx < 0) {
          nextRoom[key] = bucket;
          continue;
        }
        const updated: ChatMessage = { ...bucket.topics[idx]!, lastActivityAt };
        const next = bucket.topics.slice();
        next[idx] = updated;
        next.sort(compareTopicsForBucket);
        nextRoom[key] = { ...bucket, topics: next };
        touchedKey = key;
      }
      if (!touchedKey) return {};
      return { forumTopicsByRoom: { ...s.forumTopicsByRoom, [roomId]: nextRoom } };
    }),

  removeForumTopic: (roomId, topicId) =>
    set((s) => {
      const room = s.forumTopicsByRoom[roomId];
      if (!room) return {};
      let touched = false;
      const nextRoom: typeof room = {};
      for (const [key, bucket] of Object.entries(room)) {
        if (!bucket.topics.some((t) => t.id === topicId)) {
          nextRoom[key] = bucket;
          continue;
        }
        nextRoom[key] = { ...bucket, topics: bucket.topics.filter((t) => t.id !== topicId) };
        touched = true;
      }
      if (!touched) return {};
      return { forumTopicsByRoom: { ...s.forumTopicsByRoom, [roomId]: nextRoom } };
    }),

  setOccupants: (roomId, occ) =>
    set((s) => ({ occupants: { ...s.occupants, [roomId]: occ } })),

  setTypers: (roomId, typers) =>
    set((s) => {
      // Clean up empty arrays, keeps the dict small and lets the
      // indicator-renderer's `Object.keys` check stay cheap.
      if (typers.length === 0) {
        if (!s.typersByRoom[roomId]) return {};
        const next = { ...s.typersByRoom };
        delete next[roomId];
        return { typersByRoom: next };
      }
      return { typersByRoom: { ...s.typersByRoom, [roomId]: typers } };
    }),

  setRoom: (room) => set((s) => ({ rooms: { ...s.rooms, [room.id]: room } })),

  theaterSyncByRoom: {},
  setTheaterSync: (sync) =>
    set((s) => ({ theaterSyncByRoom: { ...s.theaterSyncByRoom, [sync.roomId]: sync } })),
  theaterReactions: [],
  pushTheaterReaction: (r) =>
    set((s) => {
      const id = nextTheaterReactionId();
      // Cap at 60 so a room whose panel never mounts (reactions still
      // arrive over the socket) can't grow this array without bound.
      const next = [...s.theaterReactions, { id, ...r }];
      return { theaterReactions: next.length > 60 ? next.slice(next.length - 60) : next };
    }),
  dropTheaterReaction: (id) =>
    set((s) => ({ theaterReactions: s.theaterReactions.filter((r) => r.id !== id) })),

  notice: null,
  setNotice: (n) => set({ notice: n }),

  openProfile: null,
  setOpenProfile: (p) => set({ openProfile: p }),
  openStoryReaderId: null,
  setOpenStoryReader: (storyId) => set({ openStoryReaderId: storyId }),

  editor: null,
  openEditor: (target) => set({ editor: target }),
  closeEditor: () => set({ editor: null }),

  // fontStep is local-only (no server mirror) and the user cycles it
  // via the Tools panel. Persist to localStorage so a tab reload,
  // which happens every time the user picks up a fresh post-deploy
  // bundle, but also any plain refresh, restores their choice
  // instead of snapping back to the default. The previous "in-memory
  // only" behavior made deploys look like they were wiping custom
  // sizes when really any reload did it.
  fontStep: loadFontStep(),
  setFontStep: (n) => {
    saveFontStep(n);
    set({ fontStep: n });
  },

  refreshIntervalSec: 0,
  setRefreshIntervalSec: (n) => set({ refreshIntervalSec: n }),

  // Seed from localStorage so BootSplash/AuthGate render with the configured
  // site name on the very first paint (no flash before /site responds).
  branding: loadCachedBranding(),
  setBranding: (b) => {
    saveCachedBranding(b);
    set({ branding: b });
  },

  // Defaults mirror the server-side defaults in db/schema.ts; populated
  // for real once `/me/profile` lands and feeds setInputLimits.
  inputLimits: {
    maxBioLength: 50_000,
    maxMessageLength: 4000,
    maxDirectMessageLength: 4000,
    maxForumPostLength: 8000,
    maxForumTopicTitleLength: 120,
  },
  setInputLimits: (l) => set({ inputLimits: l }),

  /* ----- direct messages ----- */
  dmMessagesByConv: {},
  dmConversations: {},
  openDmOtherUserId: null,
  openDmOtherCharacterId: null,
  pendingFriendRequests: [],
  setPendingFriendRequests: (list) => set({ pendingFriendRequests: list }),
  removePendingFriendRequest: (userId) =>
    set((s) => ({ pendingFriendRequests: s.pendingFriendRequests.filter((r) => r.userId !== userId) })),
  dmsEnabled: true,
  soundPrefs: { dm: true, whisper: true, chat: true, alert: true },
  setSoundPrefs: (p) => set({ soundPrefs: p }),
  inputPrefs: { disableHistory: false, disableThesaurus: false },
  setInputPrefs: (p) => set({ inputPrefs: p }),
  flairPrefs: { disableNameStyles: false, disableBorderStyles: false, disableInlineAvatars: false },
  setFlairPrefs: (p) => set({ flairPrefs: p }),
  defaultForumId: null,
  setDefaultForumId: (id) => set({ defaultForumId: id }),
  dmReseedTick: 0,

  setDmConversations: (list) => set(() => {
    const next: Record<string, DirectConversationSummary> = {};
    for (const c of list) next[c.id] = c;
    return { dmConversations: next };
  }),
  upsertDmConversation: (c) => set((s) => ({
    dmConversations: { ...s.dmConversations, [c.id]: c },
  })),
  setDmMessages: (conversationId, msgs) => set((s) => ({
    dmMessagesByConv: { ...s.dmMessagesByConv, [conversationId]: [...msgs] },
  })),
  appendDmMessage: (msg) => set((s) => {
    const list = s.dmMessagesByConv[msg.conversationId] ?? [];
    // Same dedupe-by-id discipline as `appendMessage`: the server
    // can fan a single DM to multiple sockets of the same user, so
    // the client treats inbound messages as idempotent. Look back
    // at the last 16 entries; a duplicate almost always arrives
    // within a couple of items of the original.
    for (let i = list.length - 1; i >= 0 && i >= list.length - 16; i--) {
      if (list[i]!.id === msg.id) return {};
    }
    return {
      dmMessagesByConv: { ...s.dmMessagesByConv, [msg.conversationId]: [...list, msg] },
    };
  }),
  updateDmMessage: (msg) => set((s) => {
    const list = s.dmMessagesByConv[msg.conversationId];
    if (!list) return {};
    const idx = list.findIndex((m) => m.id === msg.id);
    if (idx < 0) return {};
    const next = list.slice();
    next[idx] = msg;
    return {
      dmMessagesByConv: { ...s.dmMessagesByConv, [msg.conversationId]: next },
    };
  }),
  setOpenDmOtherUser: (otherUserId, otherCharacterId = null) => set({
    openDmOtherUserId: otherUserId,
    openDmOtherCharacterId: otherUserId === null ? null : otherCharacterId,
  }),
  setDmsEnabled: (enabled) => set({ dmsEnabled: enabled }),
  bumpDmReseed: () => set((s) => ({ dmReseedTick: s.dmReseedTick + 1 })),

  dmInboxFilterCharId: undefined,
  setDmInboxFilterCharId: (id) => set({ dmInboxFilterCharId: id }),

  commandsVersion: 0,
  bumpCommandsVersion: () => set((s) => ({ commandsVersion: s.commandsVersion + 1 })),

  friendsVersion: 0,
  bumpFriendsVersion: () => set((s) => ({ friendsVersion: s.friendsVersion + 1 })),

  inboxCountsVersion: 0,
  bumpInboxCountsVersion: () => set((s) => ({ inboxCountsVersion: s.inboxCountsVersion + 1 })),

  inboxCountsByIdentity: new Map(),
  refreshInboxCounts: async () => {
    try {
      const r = await fetch("/me/inbox-counts", { credentials: "include" });
      if (!r.ok) return;
      const j = await r.json() as {
        counts?: ReadonlyArray<import("@thekeep/shared").InboxIdentityCount>;
      };
      if (!j || !Array.isArray(j.counts)) return;
      const m = new Map<string | null, import("@thekeep/shared").InboxIdentityCount>();
      for (const row of j.counts) m.set(row.characterId, row);
      set({ inboxCountsByIdentity: m });
    } catch {
      // Counts are non-critical decoration, never bubble.
    }
  },
}));
