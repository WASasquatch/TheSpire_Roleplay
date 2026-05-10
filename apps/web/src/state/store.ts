import { create } from "zustand";
import type {
  ChatMessage,
  ProfileView,
  RoomOccupant,
  RoomSummary,
  Theme,
  UiHint,
} from "@thekeep/shared";
import { DEFAULT_THEME } from "@thekeep/shared";

export interface AuthMe {
  id: string;
  username: string;
  role: "user" | "mod" | "admin";
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

  currentRoomId: string | null;
  setCurrentRoom: (id: string | null) => void;

  rooms: Record<string, RoomSummary>;
  occupants: Record<string, RoomOccupant[]>;
  messagesByRoom: Record<string, ChatMessage[]>;

  appendMessage: (msg: ChatMessage) => void;
  /** Replace an existing message in-place (used for edit/delete grace updates). */
  updateMessage: (msg: ChatMessage) => void;
  setMessages: (roomId: string, msgs: ChatMessage[]) => void;
  setOccupants: (roomId: string, occ: RoomOccupant[]) => void;
  setRoom: (room: RoomSummary) => void;
  upsertRoomList: (rooms: RoomSummary[]) => void;

  notice: { code: string; message: string } | null;
  setNotice: (n: { code: string; message: string } | null) => void;

  pendingHint: UiHint | null;
  setHint: (h: UiHint | null) => void;

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
}

export const useChat = create<ChatState>((set) => ({
  me: null,
  setMe: (me) => set({ me }),
  authChecked: false,
  setAuthChecked: (b) => set({ authChecked: b }),
  kickReason: null,
  setKickReason: (r) => set({ kickReason: r }),

  currentRoomId: null,
  setCurrentRoom: (id) => set({ currentRoomId: id }),

  rooms: {},
  occupants: {},
  messagesByRoom: {},

  appendMessage: (msg) =>
    set((s) => {
      const list = s.messagesByRoom[msg.roomId] ?? [];
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

  setOccupants: (roomId, occ) =>
    set((s) => ({ occupants: { ...s.occupants, [roomId]: occ } })),

  setRoom: (room) => set((s) => ({ rooms: { ...s.rooms, [room.id]: room } })),

  upsertRoomList: (list) =>
    set((s) => {
      const next = { ...s.rooms };
      for (const r of list) next[r.id] = r;
      return { rooms: next };
    }),

  notice: null,
  setNotice: (n) => set({ notice: n }),

  pendingHint: null,
  setHint: (h) => set({ pendingHint: h }),

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
}));
