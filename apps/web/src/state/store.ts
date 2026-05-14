import { create } from "zustand";
import type {
  ChatMessage,
  DirectConversationSummary,
  DirectMessage,
  ProfileView,
  Role,
  RoomOccupant,
  RoomSummary,
  Theme,
} from "@thekeep/shared";
import { DEFAULT_THEME } from "@thekeep/shared";

export interface AuthMe {
  id: string;
  username: string;
  role: Role;
}

/**
 * Public site branding, fetched from /site (no auth required) on mount.
 * Drives the banner title, logo styling, BootSplash, AuthGate, and
 * `document.title`. Admin edits via /admin/settings refresh this.
 */
export interface SiteBranding {
  siteName: string;
  bannerCoverCss: string | null;
  logoColor: string | null;
  logoFont: string | null;
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
   * Sitewide default theme - used by the splash so the login screen renders
   * in the admin-configured palette instead of inheriting whatever theme the
   * last logged-in user happened to leave on documentElement.
   */
  defaultTheme: Theme;
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
   * Site-wide default theme style. Orthogonal to `defaultTheme` (palette).
   * Users without a per-user override (Profile.styleKey === null) inherit
   * this. Possible values come from the client-side style registry in
   * `lib/ornaments` ('medieval', 'modern', 'scifi'); unknown values fall
   * back to 'medieval'.
   */
  defaultStyleKey: string;
}

export const DEFAULT_BRANDING: SiteBranding = {
  siteName: "The Spire",
  bannerCoverCss: null,
  logoColor: null,
  logoFont: null,
  registrationOpen: true,
  welcomeHtml: "",
  registerDisclaimerHtml: "",
  // Mirrors the schema defaults: retention disabled (0 = forever), session
  // TTL 30 days. Real values are pushed in by /site on first paint.
  messageRetentionMs: 0,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  defaultTheme: DEFAULT_THEME,
  // Off by default. Admin flips it on once there are real users to surface.
  activityFeedsEnabled: false,
  // Off by default. Admin flips it on after deciding the seeded worlds are
  // representative or after seeding the catalog with their own.
  featuredWorldsEnabled: false,
  // Flagship style. Site admins can change this to any registered style
  // key ('medieval', 'modern', 'scifi'); unknown keys fall back to this
  // value at render time.
  defaultStyleKey: "medieval",
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
      bannerCoverCss: typeof parsed.bannerCoverCss === "string" || parsed.bannerCoverCss === null
        ? parsed.bannerCoverCss
        : null,
      logoColor: typeof parsed.logoColor === "string" || parsed.logoColor === null
        ? parsed.logoColor
        : null,
      logoFont: typeof parsed.logoFont === "string" || parsed.logoFont === null
        ? parsed.logoFont
        : null,
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
      // Theme is structured; fall through to DEFAULT_THEME if the cached
      // payload is malformed instead of letting a partial value slip in.
      defaultTheme: parsed.defaultTheme && typeof parsed.defaultTheme === "object"
        ? { ...DEFAULT_BRANDING.defaultTheme, ...parsed.defaultTheme }
        : DEFAULT_BRANDING.defaultTheme,
      activityFeedsEnabled: typeof parsed.activityFeedsEnabled === "boolean"
        ? parsed.activityFeedsEnabled
        : DEFAULT_BRANDING.activityFeedsEnabled,
      featuredWorldsEnabled: typeof parsed.featuredWorldsEnabled === "boolean"
        ? parsed.featuredWorldsEnabled
        : DEFAULT_BRANDING.featuredWorldsEnabled,
      defaultStyleKey: typeof parsed.defaultStyleKey === "string" && parsed.defaultStyleKey.length > 0
        ? parsed.defaultStyleKey
        : DEFAULT_BRANDING.defaultStyleKey,
    };
  } catch {
    return DEFAULT_BRANDING;
  }
}

export function saveCachedBranding(b: SiteBranding): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(b));
  } catch { /* quota or privacy mode - silently skip */ }
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
  setStaleVersion: (v: string | null) => void;

  currentRoomId: string | null;
  setCurrentRoom: (id: string | null) => void;

  rooms: Record<string, RoomSummary>;
  occupants: Record<string, RoomOccupant[]>;
  messagesByRoom: Record<string, ChatMessage[]>;

  appendMessage: (msg: ChatMessage) => void;
  /** Replace an existing message in-place (used for edit/delete grace updates). */
  updateMessage: (msg: ChatMessage) => void;
  setMessages: (roomId: string, msgs: ChatMessage[]) => void;
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
   * Paginated forum topics, keyed by roomId then by category key.
   * categoryKey is the threadCategoryId for a real category or
   * `"_uncat"` for the synthetic Uncategorized bucket.
   *
   * Why separate from `messagesByRoom`:
   *   - The forum view in nested-mode rooms shows topics ordered by
   *     `lastActivityAt DESC` and paginated 20-at-a-time via
   *     `GET /rooms/:id/topics`. The chat backlog (last 50 messages
   *     via room:join) is the wrong substrate — busy threads can
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
  }>>;
  /** Replace a category bucket entirely (used on first page load). */
  setForumTopicsPage: (roomId: string, categoryKey: string, topics: ChatMessage[], hasMore: boolean) => void;
  /** Append the next page to the end of a bucket (used on "Load older"). */
  appendForumTopicsPage: (roomId: string, categoryKey: string, topics: ChatMessage[], hasMore: boolean) => void;
  /** Mark a bucket as in-flight (UI shows a spinner / disables the button). */
  setForumTopicsLoading: (roomId: string, categoryKey: string, loading: boolean) => void;
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

  notice: { code: string; message: string } | null;
  setNotice: (n: { code: string; message: string } | null) => void;

  openProfile: ProfileView | null;
  setOpenProfile: (p: ProfileView | null) => void;

  /**
   * Editor target - null means closed.
   * mode "master" → edits the master account (no characterId).
   * mode "character" → edits the character with that id.
   */
  editor: { mode: "master" | "character"; characterId: string | null } | null;
  openEditor: (target: { mode: "master" | "character"; characterId: string | null }) => void;
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

  /* =========================================================
   *  Direct messages (Phase 4)
   * ========================================================= */
  /**
   * Per-conversation message buffer. Keyed by conversationId. Each
   * list stays sorted oldest → newest; the store action handles
   * dedupe by id (server can fan a message to multiple sockets of
   * the same user). Trimmed lazily — the DmThread caps display at
   * its own rendering layer.
   */
  dmMessagesByConv: Record<string, DirectMessage[]>;
  /** Conversation summaries for the rail. Keyed by conversationId. */
  dmConversations: Record<string, DirectConversationSummary>;
  /**
   * The OTHER user id of the currently-open DM panel, or null when no
   * panel is open. We key on the user id rather than the conversation
   * id because the conversation row may not exist server-side until
   * the first message is sent — letting the panel mount with just an
   * otherUserId removes the "first-DM bootstrapping" footgun.
   */
  openDmOtherUserId: string | null;
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
  soundPrefs: { dm: boolean; chat: boolean; alert: boolean };
  setSoundPrefs: (p: { dm: boolean; chat: boolean; alert: boolean }) => void;
  /**
   * Counter bumped each time the socket (re)connects. Any open
   * ThreadPane watches this and re-runs its history seed when it
   * changes — that's the catch-up path for `dm:new` events the
   * client missed while disconnected (Socket.io drops `emit`s when
   * the recipient socket isn't connected; there's no replay).
   */
  dmReseedTick: number;

  setDmConversations: (list: DirectConversationSummary[]) => void;
  upsertDmConversation: (c: DirectConversationSummary) => void;
  setDmMessages: (conversationId: string, msgs: DirectMessage[]) => void;
  appendDmMessage: (msg: DirectMessage) => void;
  updateDmMessage: (msg: DirectMessage) => void;
  setOpenDmOtherUser: (otherUserId: string | null) => void;
  setDmsEnabled: (enabled: boolean) => void;
  bumpDmReseed: () => void;
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

export const useChat = create<ChatState>((set) => ({
  me: null,
  setMe: (me) => set({ me }),
  authChecked: false,
  setAuthChecked: (b) => set({ authChecked: b }),
  kickReason: null,
  setKickReason: (r) => set({ kickReason: r }),
  staleVersion: null,
  setStaleVersion: (v) => set({ staleVersion: v }),
  activeCharacterId: null,
  setActiveCharacterIdStore: (id) => set({ activeCharacterId: id }),

  currentRoomId: null,
  setCurrentRoom: (id) => set({ currentRoomId: id }),

  rooms: {},
  occupants: {},
  messagesByRoom: {},

  appendMessage: (msg) =>
    set((s) => {
      const list = s.messagesByRoom[msg.roomId] ?? [];
      // Idempotent on duplicate id. The server may deliver the same
      // message via two paths (room broadcast + explicit sender emit, or
      // a reconnect-replay landing on top of a live append) — appending
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
      const list = s.messagesByRoom[msg.roomId];
      if (!list) return {};
      const idx = list.findIndex((m) => m.id === msg.id);
      if (idx < 0) return {};
      const next = list.slice();
      next[idx] = msg;
      return { messagesByRoom: { ...s.messagesByRoom, [msg.roomId]: next } };
    }),

  setMessages: (roomId, msgs) =>
    set((s) => ({ messagesByRoom: { ...s.messagesByRoom, [roomId]: msgs } })),

  prependMessages: (roomId, older) =>
    set((s) => {
      if (older.length === 0) return {};
      const current = s.messagesByRoom[roomId] ?? [];
      // Dedupe by id — a live `message:new` may have landed within the
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

  forumTopicsByRoom: {},

  setForumTopicsPage: (roomId, categoryKey, topics, hasMore) =>
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
              hasMore,
              loading: false,
              // Preserve pending across a first-page refetch — a topic
              // queued behind the pill is still "new" relative to what
              // the user has seen.
              pending: prev?.pending ?? [],
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
        // Defensive: append on an empty bucket behaves like setPage.
        return {
          forumTopicsByRoom: {
            ...s.forumTopicsByRoom,
            [roomId]: {
              ...room,
              [categoryKey]: { topics, hasMore, loading: false, pending: [] },
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
              topics: [...prev.topics, ...extra],
              hasMore,
              loading: false,
              pending: prev.pending,
            },
          },
        },
      };
    }),

  setForumTopicsLoading: (roomId, categoryKey, loading) =>
    set((s) => {
      const room = s.forumTopicsByRoom[roomId] ?? {};
      const prev = room[categoryKey] ?? { topics: [], hasMore: false, loading: false, pending: [] };
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
      const prev = room[categoryKey] ?? { topics: [], hasMore: false, loading: false, pending: [] };
      // Don't double-insert if the topic is already at the head.
      if (prev.topics.some((t) => t.id === topic.id)) return {};
      return {
        forumTopicsByRoom: {
          ...s.forumTopicsByRoom,
          [roomId]: {
            ...room,
            [categoryKey]: { ...prev, topics: [topic, ...prev.topics] },
          },
        },
      };
    }),

  queuePendingForumTopic: (roomId, categoryKey, topic) =>
    set((s) => {
      const room = s.forumTopicsByRoom[roomId] ?? {};
      const prev = room[categoryKey] ?? { topics: [], hasMore: false, loading: false, pending: [] };
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
      // Update in whichever bucket holds the topic, then re-sort that
      // bucket so a sticky toggle (the field most likely to change
      // ordering) lifts the row to / drops it from the top tier.
      // Other field changes (lock, edit) don't affect order but the
      // sort is idempotent so a no-op resort is harmless.
      let touched = false;
      const nextRoom: typeof room = {};
      for (const [key, bucket] of Object.entries(room)) {
        const idx = bucket.topics.findIndex((t) => t.id === msg.id);
        if (idx < 0) {
          nextRoom[key] = bucket;
          continue;
        }
        const next = bucket.topics.slice();
        next[idx] = msg;
        next.sort(compareTopicsForBucket);
        nextRoom[key] = { ...bucket, topics: next };
        touched = true;
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

  setRoom: (room) => set((s) => ({ rooms: { ...s.rooms, [room.id]: room } })),

  notice: null,
  setNotice: (n) => set({ notice: n }),

  openProfile: null,
  setOpenProfile: (p) => set({ openProfile: p }),

  editor: null,
  openEditor: (target) => set({ editor: target }),
  closeEditor: () => set({ editor: null }),

  fontStep: 1,
  setFontStep: (n) => set({ fontStep: n }),

  refreshIntervalSec: 0,
  setRefreshIntervalSec: (n) => set({ refreshIntervalSec: n }),

  // Seed from localStorage so BootSplash/AuthGate render with the configured
  // site name on the very first paint (no flash before /site responds).
  branding: loadCachedBranding(),
  setBranding: (b) => {
    saveCachedBranding(b);
    set({ branding: b });
  },

  /* ----- direct messages ----- */
  dmMessagesByConv: {},
  dmConversations: {},
  openDmOtherUserId: null,
  pendingFriendRequests: [],
  setPendingFriendRequests: (list) => set({ pendingFriendRequests: list }),
  removePendingFriendRequest: (userId) =>
    set((s) => ({ pendingFriendRequests: s.pendingFriendRequests.filter((r) => r.userId !== userId) })),
  dmsEnabled: true,
  soundPrefs: { dm: true, chat: true, alert: true },
  setSoundPrefs: (p) => set({ soundPrefs: p }),
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
  setOpenDmOtherUser: (otherUserId) => set({ openDmOtherUserId: otherUserId }),
  setDmsEnabled: (enabled) => set({ dmsEnabled: enabled }),
  bumpDmReseed: () => set((s) => ({ dmReseedTick: s.dmReseedTick + 1 })),
}));
